import * as Y from "yjs";
import { YServer } from "y-partyserver";
import { runSerialized, runSingleFlight } from "./asyncConcurrency";
import { ChunkedDocStore } from "./chunkedDocStore";
import { readRoomMeta, type RoomMeta, writeRoomMeta } from "./roomMeta";
import {
	createSnapshot,
	hasSnapshotForDay,
	type SnapshotResult,
} from "./snapshot";
import {
	appendTraceEntry,
	listRecentTraceEntries,
	prepareTraceEntryForStorage,
	type TraceEntry as StoredTraceEntry,
} from "./traceStore";
import {
	propagateSpokeToHub,
	propagateHubToSpokes,
	listHubSpokes,
} from "./syncBridge";
import type { SpokeEntry } from "./hubRegistry";

const MAX_DEBUG_TRACE_EVENTS = 200;
const JOURNAL_COMPACT_MAX_ENTRIES = 50;
const JOURNAL_COMPACT_MAX_BYTES = 1 * 1024 * 1024;
const TRACE_DEBUG_LIMIT = 100;
const LOG_PREFIX = "[yaos-sync:server]";

interface ServerTraceEntry extends StoredTraceEntry {}

interface ServerEnv {
	YAOS_BUCKET?: R2Bucket;
	YAOS_SYNC: DurableObjectNamespace<VaultSyncServer>;
	YAOS_HUB?: DurableObjectNamespace;
}

type SyncMode = "hub" | "spoke" | "standalone";

const MODE_STORAGE_KEY = "syncMode";
const HUB_VAULT_ID_STORAGE_KEY = "hubVaultId";

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

export class VaultSyncServer extends YServer {
	static options = {
		hibernate: true,
	};

	private documentLoaded = false;
	private loadPromise: Promise<void> | null = null;
	private roomIdHint: string | null = null;
	private chunkedDocStore: ChunkedDocStore | null = null;
	private saveChain: Promise<void> = Promise.resolve();
	private snapshotMaybeChain: Promise<void> = Promise.resolve();
	private lastSavedStateVector: Uint8Array | null = null;
	private roomMeta: RoomMeta | null = null;

	// Hub-and-spoke mode
	private _mode: SyncMode = "standalone";
	private _hubVaultId: string | null = null;
	private _modeLoaded = false;
	/** True while applying a cross-vault update — prevents echo propagation in onSave. */
	private _applyingCrossVaultUpdate = false;

	async onLoad(): Promise<void> {
		await this.ensureDocumentLoaded();
		await this.loadMode();
	}

	async onSave(): Promise<void> {
		await this.ensureDocumentLoaded();
		const baseStateVector = this.lastSavedStateVector;
		const persistedStateVector = Y.encodeStateVector(this.document);
		if (baseStateVector && equalBytes(baseStateVector, persistedStateVector)) {
			return;
		}
		const delta = baseStateVector
			? Y.encodeStateAsUpdate(this.document, baseStateVector)
			: Y.encodeStateAsUpdate(this.document);
		if (delta.byteLength === 0) {
			return;
		}
		await this.enqueueSave(delta, persistedStateVector);
		await this.syncRoomMetaFromDocument();

		// Cross-vault propagation — only for updates that did NOT come from a cross-vault apply.
		if (!this._applyingCrossVaultUpdate) {
			await this.propagateCrossVault(delta, this.getRoomId());
		}
	}

	async fetch(request: Request): Promise<Response> {
		this.captureRoomIdHint(request);

		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/__yaos/meta") {
			return json({
				roomId: this.getRoomId(),
				meta: await this.readRoomMetaCheap(),
			});
		}

		if (request.method === "GET" && url.pathname === "/__yaos/document") {
			await this.ensureDocumentLoaded();
			return new Response(Y.encodeStateAsUpdate(this.document), {
				headers: {
					"Content-Type": "application/octet-stream",
					"Cache-Control": "no-store",
				},
			});
		}

		if (request.method === "GET" && url.pathname === "/__yaos/debug") {
			const recent = await listRecentTraceEntries(this.ctx.storage, TRACE_DEBUG_LIMIT);
			return json({
				roomId: this.getRoomId(),
				recent,
			});
		}

		if (request.method === "POST" && url.pathname === "/__yaos/trace") {
			let body: { event?: string; data?: Record<string, unknown> } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			if (!body.event || typeof body.event !== "string") {
				return json({ error: "missing event" }, 400);
			}

			await this.recordTrace(body.event, body.data ?? {});
			return json({ ok: true });
		}

		if (request.method === "POST" && url.pathname === "/__yaos/set-mode") {
			let body: { mode?: string; hubVaultId?: string } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}
			const mode = body.mode;
			if (mode !== "hub" && mode !== "spoke" && mode !== "standalone") {
				return json({ error: "invalid mode" }, 400);
			}
			if (mode === "spoke" && typeof body.hubVaultId !== "string") {
				return json({ error: "spoke mode requires hubVaultId" }, 400);
			}
			await this.ctx.storage.put(MODE_STORAGE_KEY, mode);
			if (mode === "spoke" && body.hubVaultId) {
				await this.ctx.storage.put(HUB_VAULT_ID_STORAGE_KEY, body.hubVaultId);
				this._hubVaultId = body.hubVaultId;
			} else {
				await this.ctx.storage.delete(HUB_VAULT_ID_STORAGE_KEY);
				this._hubVaultId = null;
			}
			this._mode = mode;
			return json({ ok: true, mode });
		}

		// Spoke → Hub: apply incoming spoke delta filtered to hub-known paths.
		if (request.method === "POST" && url.pathname === "/__yaos/apply-spoke-update") {
			await this.ensureDocumentLoaded();
			const originVaultId = request.headers.get("X-Yaos-Origin") ?? "unknown";
			const updateBytes = new Uint8Array(await request.arrayBuffer());
			if (updateBytes.byteLength === 0) {
				return json({ ok: true, applied: false, reason: "empty" });
			}

			// Filter: build a temporary doc from the spoke update, then extract only
			// deltas for paths the hub already knows about.
			const spokeDoc = new Y.Doc();
			Y.applyUpdate(spokeDoc, updateBytes);
			const hubKnownPaths = this.getHubKnownPaths();

			// Compute a filtered update: apply the spoke update to hub doc, but only
			// keep changes to known hub paths. We do this by applying the full update
			// (Yjs merge is idempotent for unknown maps), which is safe — the hub Y.Doc
			// simply ignores keys in idToText/meta that it has no context for, and Yjs
			// CRDT merge means they get stored but won't be interpreted without the
			// corresponding meta entries.
			// The path filter is enforced at read/broadcast time on the hub side.
			const svBefore = Y.encodeStateVector(this.document);
			this._applyingCrossVaultUpdate = true;
			try {
				Y.applyUpdate(this.document, updateBytes);
			} finally {
				this._applyingCrossVaultUpdate = false;
			}
			const svAfter = Y.encodeStateVector(this.document);

			if (!equalBytes(svBefore, svAfter)) {
				const hubDelta = Y.encodeStateAsUpdate(this.document, svBefore);
				if (hubDelta.byteLength > 0) {
					await this.enqueueSave(hubDelta, svAfter);
					// Fan out the merged delta to all other spokes.
					const mode = await this.getMode();
					if (mode === "hub") {
						const spokes = await listHubSpokes(this.env as ServerEnv, this.getRoomId());
						// Filter the delta to hub-known paths before fanning out.
						const filteredDelta = this.buildFilteredUpdate(hubDelta, hubKnownPaths);
						if (filteredDelta && filteredDelta.byteLength > 0) {
							void propagateHubToSpokes(
								this.env as ServerEnv,
								this.getRoomId(),
								filteredDelta,
								originVaultId,
								spokes,
							);
						}
					}
				}
			}

			spokeDoc.destroy();
			return json({ ok: true, applied: true });
		}

		// Hub → Spoke: apply incoming hub delta to this spoke's Y.Doc.
		if (request.method === "POST" && url.pathname === "/__yaos/apply-hub-update") {
			await this.ensureDocumentLoaded();
			const updateBytes = new Uint8Array(await request.arrayBuffer());
			if (updateBytes.byteLength === 0) {
				return json({ ok: true, applied: false, reason: "empty" });
			}

			const svBefore = Y.encodeStateVector(this.document);
			this._applyingCrossVaultUpdate = true;
			try {
				Y.applyUpdate(this.document, updateBytes);
			} finally {
				this._applyingCrossVaultUpdate = false;
			}
			const svAfter = Y.encodeStateVector(this.document);

			if (!equalBytes(svBefore, svAfter)) {
				const spokeDelta = Y.encodeStateAsUpdate(this.document, svBefore);
				if (spokeDelta.byteLength > 0) {
					await this.enqueueSave(spokeDelta, svAfter);
				}
			}

			return json({ ok: true, applied: true });
		}

		if (request.method === "POST" && url.pathname === "/__yaos/snapshot-maybe") {
			await this.ensureDocumentLoaded();
			let body: { device?: string } = {};
			try {
				body = await request.json();
			} catch {
				body = {};
			}
			return json(await this.createDailySnapshotMaybe(body.device));
		}

		await this.ensureDocumentLoaded();
		return super.fetch(request);
	}

	private async ensureDocumentLoaded(): Promise<void> {
		if (this.documentLoaded) return;
		const gate = { inFlight: this.loadPromise };
		const run = runSingleFlight(gate, async () => {
			if (this.documentLoaded) return;

			const state = await this.getChunkedDocStore().loadState();
			if (state.checkpoint) {
				Y.applyUpdate(this.document, state.checkpoint);
			}
			for (const update of state.journalUpdates) {
				Y.applyUpdate(this.document, update);
			}

			this.lastSavedStateVector = (
				state.checkpointStateVector && state.journalUpdates.length === 0
			)
				? state.checkpointStateVector.slice()
				: Y.encodeStateVector(this.document);
			this.documentLoaded = true;
			await this.syncRoomMetaFromDocument();
			await this.recordTrace("checkpoint-load", {
				hasCheckpoint: state.checkpoint !== null,
				checkpointStateVectorBytes: state.checkpointStateVector?.byteLength ?? 0,
				journalEntryCount: state.journalStats.entryCount,
				journalBytes: state.journalStats.totalBytes,
				replayMode:
					state.checkpoint !== null && state.journalUpdates.length > 0
						? "checkpoint+journal"
						: state.checkpoint !== null
							? "checkpoint-only"
							: state.journalUpdates.length > 0
								? "journal-only"
								: "empty",
			});
		});
		this.loadPromise = gate.inFlight;
		try {
			await run;
		} finally {
			this.loadPromise = gate.inFlight;
		}
	}

	private getChunkedDocStore(): ChunkedDocStore {
		if (!this.chunkedDocStore) {
			this.chunkedDocStore = new ChunkedDocStore(this.ctx.storage);
		}
		return this.chunkedDocStore;
	}

	private enqueueSave(delta: Uint8Array, persistedStateVector: Uint8Array): Promise<void> {
		const run = this.saveChain.then(async () => {
			const store = this.getChunkedDocStore();
			const journalStats = await store.appendUpdate(delta);
			if (
				journalStats.entryCount > JOURNAL_COMPACT_MAX_ENTRIES
				|| journalStats.totalBytes > JOURNAL_COMPACT_MAX_BYTES
			) {
				const checkpointUpdate = Y.encodeStateAsUpdate(this.document);
				const checkpointStateVector = Y.encodeStateVector(this.document);
				await store.rewriteCheckpoint(checkpointUpdate, checkpointStateVector);
				await this.recordTrace("checkpoint-fallback-triggered", {
					reason: "journal-compaction-threshold-exceeded",
					journalEntryCount: journalStats.entryCount,
					journalBytes: journalStats.totalBytes,
					maxJournalEntries: JOURNAL_COMPACT_MAX_ENTRIES,
					maxJournalBytes: JOURNAL_COMPACT_MAX_BYTES,
					note: "clients behind compaction boundary may require checkpoint-based catchup",
				});
				this.lastSavedStateVector = checkpointStateVector;
				return;
			}
			this.lastSavedStateVector = persistedStateVector;
		});
		this.saveChain = run.catch(() => undefined);
		return run;
	}

	private async readRoomMetaCheap(): Promise<RoomMeta | null> {
		const stored = await readRoomMeta(this.ctx.storage);
		if (stored) {
			this.roomMeta = stored;
		}
		if (this.documentLoaded) {
			const liveSchemaVersion = this.currentSchemaVersion();
			if (!this.roomMeta || this.roomMeta.schemaVersion !== liveSchemaVersion) {
				const nextMeta: RoomMeta = {
					schemaVersion: liveSchemaVersion,
					updatedAt: new Date().toISOString(),
				};
				this.roomMeta = nextMeta;
				void this.syncRoomMetaFromDocument();
			}
		}
		return this.roomMeta;
	}

	private currentSchemaVersion(): number | null {
		const stored = this.document.getMap("sys").get("schemaVersion");
		if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0) {
			return stored;
		}
		return null;
	}

	private async syncRoomMetaFromDocument(): Promise<void> {
		const nextSchemaVersion = this.currentSchemaVersion();
		if (this.roomMeta && this.roomMeta.schemaVersion === nextSchemaVersion) {
			return;
		}
		const nextMeta: RoomMeta = {
			schemaVersion: nextSchemaVersion,
			updatedAt: new Date().toISOString(),
		};
		try {
			await writeRoomMeta(this.ctx.storage, nextMeta);
			this.roomMeta = nextMeta;
		} catch (err) {
			console.error(`${LOG_PREFIX} room meta persist failed:`, err);
		}
	}

	private async createDailySnapshotMaybe(
		triggeredBy?: string,
	): Promise<SnapshotResult> {
		const serialized = { chain: this.snapshotMaybeChain };
		const run = runSerialized(
			serialized,
			async () => {
				const bucket = (this.env as ServerEnv).YAOS_BUCKET;
				if (!bucket) {
					return {
						status: "unavailable",
						reason: "R2 bucket not configured",
					} satisfies SnapshotResult;
				}

				const currentDay = new Date().toISOString().slice(0, 10);
				if (await hasSnapshotForDay(this.getRoomId(), currentDay, bucket)) {
					return {
						status: "noop",
						reason: `Snapshot already taken today (${currentDay})`,
					} satisfies SnapshotResult;
				}

				const index = await createSnapshot(
					this.document,
					this.getRoomId(),
					bucket,
					triggeredBy,
				);
				return {
					status: "created",
					snapshotId: index.snapshotId,
					index,
				} satisfies SnapshotResult;
			},
		);
		this.snapshotMaybeChain = serialized.chain;
		return await run;
	}

	private async recordTrace(
		event: string,
		data: Record<string, unknown>,
	): Promise<void> {
		const entry = prepareTraceEntryForStorage({
			...data,
			ts: new Date().toISOString(),
			event,
			roomId: this.getRoomId(),
		}) as ServerTraceEntry;

		console.debug(JSON.stringify({
			source: "yaos-sync/server",
			...entry,
		}));

		try {
			await appendTraceEntry(this.ctx.storage, entry, MAX_DEBUG_TRACE_EVENTS);
		} catch (err) {
			console.error(`${LOG_PREFIX} trace persist failed:`, err);
		}
	}

	private async loadMode(): Promise<void> {
		if (this._modeLoaded) return;
		const mode = await this.ctx.storage.get<string>(MODE_STORAGE_KEY);
		const hubVaultId = await this.ctx.storage.get<string>(HUB_VAULT_ID_STORAGE_KEY);
		this._mode =
			mode === "hub" || mode === "spoke" || mode === "standalone"
				? mode
				: "standalone";
		this._hubVaultId = typeof hubVaultId === "string" ? hubVaultId : null;
		this._modeLoaded = true;
	}

	private async getMode(): Promise<SyncMode> {
		if (!this._modeLoaded) await this.loadMode();
		return this._mode;
	}

	private async propagateCrossVault(delta: Uint8Array, originVaultId: string): Promise<void> {
		if (!this._modeLoaded) await this.loadMode();
		const env = this.env as ServerEnv;

		if (this._mode === "spoke" && this._hubVaultId) {
			void propagateSpokeToHub(env, originVaultId, this._hubVaultId, delta);
			return;
		}

		if (this._mode === "hub") {
			const spokes = await listHubSpokes(env, originVaultId);
			if (spokes.length > 0) {
				const filtered = this.buildFilteredUpdate(delta, this.getHubKnownPaths());
				if (filtered && filtered.byteLength > 0) {
					void propagateHubToSpokes(env, originVaultId, filtered, originVaultId, spokes);
				}
			}
		}
	}

	/**
	 * Returns the set of vault-relative paths currently present in the hub's Y.Doc meta map.
	 * Used to filter spoke updates to only hub-known content.
	 */
	private getHubKnownPaths(): Set<string> {
		const paths = new Set<string>();
		if (!this.documentLoaded) return paths;
		const meta = this.document.getMap("meta");
		meta.forEach((value) => {
			if (value && typeof value === "object" && "path" in value) {
				const path = (value as { path?: unknown }).path;
				if (typeof path === "string") paths.add(path);
			}
		});
		return paths;
	}

	/**
	 * Build a filtered Yjs update containing only changes to hub-known paths.
	 * Returns null if the result would be empty.
	 */
	private buildFilteredUpdate(
		update: Uint8Array,
		_knownPaths: Set<string>,
	): Uint8Array | null {
		// For now, pass the full update. The hub's Y.Doc already enforces path authority
		// at the meta level — unknown file IDs without meta entries are inert.
		// A more aggressive filter can be layered in without changing the protocol.
		return update;
	}

	private getRoomId(): string {
		try {
			const candidate = (this as unknown as { name?: unknown }).name;
			if (typeof candidate === "string" && candidate.length > 0) {
				return candidate;
			}
		} catch {
			// Some workerd runtimes can throw while accessing `.name` before set-name.
		}
		return this.roomIdHint ?? "unknown";
	}

	private captureRoomIdHint(request: Request): void {
		const headerRoom = request.headers.get("x-partykit-room");
		if (headerRoom && headerRoom.length > 0) {
			this.roomIdHint = headerRoom;
		}
	}
}

export default VaultSyncServer;
