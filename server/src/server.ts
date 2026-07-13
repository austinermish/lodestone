import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import { YServer } from "y-partyserver";
import type { Connection, ConnectionContext } from "partyserver";
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
import { bytesToHex, sha256Hex } from "./hex";

/**
 * y-partyserver's WSSharedDoc disables y-protocols/awareness's own periodic
 * stale-client sweep (`clearInterval(this.awareness._checkInterval)`), and
 * VaultSyncServer never replaces it. Clean disconnects are still handled by
 * the base class's onClose -> removeAwarenessStates. But a client that drops
 * without a clean close (mobile backgrounding, network loss, crash) leaves
 * its cursor in `document.awareness` forever — hence the stale-cursor bug.
 * This DO alarm re-implements that sweep: any awareness clientID with no
 * currently-open connection after AWARENESS_GC_INTERVAL_MS is considered
 * abandoned and removed.
 */
const AWARENESS_GC_INTERVAL_MS = 30_000;
const AWARENESS_IDS_CONNECTION_STATE_KEY = "__ypsAwarenessIds";

const MAX_DEBUG_TRACE_EVENTS = 200;
const JOURNAL_COMPACT_MAX_ENTRIES = 50;
const JOURNAL_COMPACT_MAX_BYTES = 1 * 1024 * 1024;
const TRACE_DEBUG_LIMIT = 100;
const LOG_PREFIX = "[lodestone-sync:server]";
const ROOM_TOKEN_HASH_STORAGE_KEY = "__lodestoneRoomTokenHash";

interface ServerTraceEntry extends StoredTraceEntry {}

interface ServerEnv {
	LODESTONE_BUCKET?: R2Bucket;
	LODESTONE_SYNC: DurableObjectNamespace<VaultSyncServer>;
}

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

	// Reduce the onSave debounce from the 2 s y-partyserver default so that
	// cross-vault propagation (hub→spoke, spoke→hub) fires within ~100 ms of
	// the last edit rather than after a 2–10 s idle window.
	static callbackOptions = {
		debounceWait: 100,
		debounceMaxWait: 500,
	};

	private documentLoaded = false;
	private loadPromise: Promise<void> | null = null;
	private roomIdHint: string | null = null;
	private chunkedDocStore: ChunkedDocStore | null = null;
	private saveChain: Promise<void> = Promise.resolve();
	private snapshotMaybeChain: Promise<void> = Promise.resolve();
	private lastSavedStateVector: Uint8Array | null = null;
	private roomMeta: RoomMeta | null = null;

	async onLoad(): Promise<void> {
		await this.ensureDocumentLoaded();
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
	}

	async fetch(request: Request): Promise<Response> {
		this.captureRoomIdHint(request);

		// Serve routes that don't need the CRDT document BEFORE super.fetch()
		// triggers onStart -> onLoad -> ensureDocumentLoaded(). Without this,
		// every /meta, /debug, and /trace request — including auth-rejection
		// telemetry — fully replays the checkpoint+journal on a cold DO.
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/__lodestone/meta") {
			return json({
				roomId: this.getRoomId(),
				meta: await this.readRoomMetaCheap(),
			});
		}

		if (request.method === "GET" && url.pathname === "/__lodestone/debug") {
			const recent = await listRecentTraceEntries(this.ctx.storage, TRACE_DEBUG_LIMIT);
			return json({
				roomId: this.getRoomId(),
				recent,
			});
		}

		if (request.method === "POST" && url.pathname === "/__lodestone/trace") {
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

		return super.fetch(request);
	}

	async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
		await super.onConnect(connection, ctx);
		await this.scheduleAwarenessGc();
	}

	async onAlarm(): Promise<void> {
		const controlledIds = new Set<number>();
		for (const conn of this.getConnections<unknown>()) {
			const state = conn.state as Record<string, unknown> | null;
			const ids = state?.[AWARENESS_IDS_CONNECTION_STATE_KEY];
			if (Array.isArray(ids)) {
				for (const id of ids) {
					if (typeof id === "number") controlledIds.add(id);
				}
			}
		}

		const staleIds: number[] = [];
		for (const clientId of this.document.awareness.getStates().keys()) {
			if (!controlledIds.has(clientId)) staleIds.push(clientId);
		}

		if (staleIds.length > 0) {
			awarenessProtocol.removeAwarenessStates(this.document.awareness, staleIds, null);
			await this.recordTrace("awareness-gc-swept-stale-clients", { staleIds });
		}

		// Keep sweeping while anyone is connected, in case a future client drops uncleanly.
		if ([...this.getConnections()].length > 0 || this.document.awareness.getStates().size > 0) {
			await this.scheduleAwarenessGc();
		}
	}

	private async scheduleAwarenessGc(): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now() + AWARENESS_GC_INTERVAL_MS);
	}

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// /meta, /debug, /trace are handled in fetch() before this method runs
		// (they don't need the document loaded — see the comment there).

		if (request.method === "GET" && url.pathname === "/__lodestone/document") {
			return new Response(Y.encodeStateAsUpdate(this.document), {
				headers: {
					"Content-Type": "application/octet-stream",
					"Cache-Control": "no-store",
				},
			});
		}

		if (request.method === "POST" && url.pathname === "/__lodestone/snapshot-maybe") {
			let body: { device?: string } = {};
			try {
				body = await request.json();
			} catch {
				body = {};
			}
			return json(await this.createDailySnapshotMaybe(body.device));
		}

		if (request.method === "POST" && url.pathname === "/__lodestone/mint-room-token") {
			const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
			const hash = await sha256Hex(new TextEncoder().encode(token));
			await this.ctx.storage.put(ROOM_TOKEN_HASH_STORAGE_KEY, hash);
			return json({ token });
		}

		if (request.method === "POST" && url.pathname === "/__lodestone/verify-room-token") {
			let body: { token?: string } = {};
			try {
				body = await request.json();
			} catch {
				body = {};
			}
			const storedHash = await this.ctx.storage.get<string>(ROOM_TOKEN_HASH_STORAGE_KEY);
			if (!storedHash || !body.token) {
				return json({ valid: false });
			}
			const presentedHash = await sha256Hex(new TextEncoder().encode(body.token));
			return json({ valid: presentedHash === storedHash });
		}

		return new Response("Not found", { status: 404 });
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
				const bucket = (this.env as ServerEnv).LODESTONE_BUCKET;
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
			source: "lodestone-sync/server",
			...entry,
		}));

		try {
			await appendTraceEntry(this.ctx.storage, entry, MAX_DEBUG_TRACE_EVENTS);
		} catch (err) {
			console.error(`${LOG_PREFIX} trace persist failed:`, err);
		}
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
