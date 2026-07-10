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
import {
	propagateSpokeToHub,
	propagateHubToSpokes,
	listHubSpokes,
} from "./syncBridge";
import type { SpokeEntry } from "./hubRegistry";

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

interface ServerTraceEntry extends StoredTraceEntry {}

interface ServerEnv {
	LODESTONE_BUCKET?: R2Bucket;
	LODESTONE_SYNC: DurableObjectNamespace<VaultSyncServer>;
	LODESTONE_HUB?: DurableObjectNamespace;
}

type SyncMode = "hub" | "spoke" | "standalone" | "hub+spoke";

const MODE_STORAGE_KEY = "syncMode";
const HUB_VAULT_ID_STORAGE_KEY = "hubVaultId";

/** True if a meta entry represents a tombstoned (deleted) file, in either the
 * legacy ({deleted, deletedAt, mtime}) or v2 ({path, deletedAt}) shape. */
function isMetaTombstoned(meta: unknown): boolean {
	if (!meta || typeof meta !== "object") return true;
	const m = meta as Record<string, unknown>;
	return m.deleted === true || typeof m.deletedAt === "number";
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

	// Hub-and-spoke mode
	private _mode: SyncMode = "standalone";
	private _hubVaultId: string | null = null;
	private _modeLoaded = false;
	/** True while applying a cross-vault update — prevents echo propagation in onSave. */
	private _applyingCrossVaultUpdate = false;
	/**
	 * State vector immediately after the most recent revertRejectedStructuralChange()
	 * transaction. onSave()'s debounce (100 ms) fires well after
	 * _applyingCrossVaultUpdate has already been reset to false in that call's
	 * `finally`, so the flag alone can't stop the revert's own delta from being
	 * re-proposed to the hub — which would reject it again, trigger another
	 * revert, and loop forever (each cycle stamping a fresh deletedAt). Checked
	 * (and cleared) once in onSave(): if nothing else has changed the document
	 * since the revert, this onSave's delta IS the revert and must not be
	 * re-propagated. Y state vectors only move forward, so once this fails to
	 * match it can never match again — safe to clear unconditionally after one check.
	 */
	private _lastRevertStateVector: Uint8Array | null = null;

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

		// Check-and-clear: if the document hasn't moved since the most recent
		// revert, this delta IS that revert — never re-propose it (see the
		// field comment on _lastRevertStateVector for why the boolean flag
		// alone can't catch this across the debounce gap).
		const revertSv = this._lastRevertStateVector;
		this._lastRevertStateVector = null;
		const isPureRevertEcho = revertSv !== null && equalBytes(revertSv, persistedStateVector);

		// Cross-vault propagation — only for updates that did NOT come from a cross-vault apply.
		if (!this._applyingCrossVaultUpdate && !isPureRevertEcho) {
			await this.propagateCrossVault(delta, this.getRoomId());
		}
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

		if (request.method === "POST" && url.pathname === "/__lodestone/set-mode") {
			let body: { mode?: string; hubVaultId?: string } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}
			const mode = body.mode;
			if (mode !== "hub" && mode !== "spoke" && mode !== "standalone" && mode !== "hub+spoke") {
				return json({ error: "invalid mode" }, 400);
			}
			if ((mode === "spoke" || mode === "hub+spoke") && typeof body.hubVaultId !== "string") {
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
		if (request.method === "POST" && url.pathname === "/__lodestone/apply-spoke-update") {
			const originVaultId = request.headers.get("X-Lodestone-Origin") ?? "unknown";
			const updateBytes = new Uint8Array(await request.arrayBuffer());
			if (updateBytes.byteLength === 0) {
				return json({ ok: true, applied: false, reason: "empty" });
			}

			// Spokes may edit the body of an existing file's Y.Text, but must not
			// create/rename/move/delete files or folders (pathToId/meta/idToText
			// top-level keys). Enforced here at the transaction layer — never by
			// inspecting raw update bytes — by replaying the update on a throwaway
			// doc and checking which Y types it actually touched.
			await this.ensureDocumentLoaded();
			if (this.updateTouchesStructure(updateBytes)) {
				await this.recordTrace("spoke-structural-update-rejected", { originVaultId });
				return json({
					ok: true,
					applied: false,
					rejected: true,
					reason: "structural-change-not-permitted",
				});
			}

			// Privacy leak (4.1): a body edit to a fileId with no live,
			// hub-known meta entry — e.g. a stale fileId a spoke still has
			// locally, or one only ever present in that spoke's own copy of
			// the room doc — never touches pathToId/meta/idToText map keys,
			// so it passes the structural check above. Left unchecked, its
			// content would merge into the hub doc as an untracked orphan
			// and still get fanned out to every other spoke. Reject it the
			// same way as a structural change.
			const contentTouchedIds = this.findContentTouchedFileIds(updateBytes);
			if (contentTouchedIds.size > 0) {
				const metaMap = this.document.getMap<Record<string, unknown>>("meta");
				let hasUnknownFile = false;
				for (const fileId of contentTouchedIds) {
					const meta = metaMap.get(fileId);
					if (!meta || typeof meta.path !== "string" || isMetaTombstoned(meta)) {
						hasUnknownFile = true;
						break;
					}
				}
				if (hasUnknownFile) {
					await this.recordTrace("spoke-unknown-file-edit-rejected", { originVaultId });
					return json({
						ok: true,
						applied: false,
						rejected: true,
						reason: "unknown-file-not-shared",
					});
				}
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
				// Fan-out delta: just this handler's own contribution (svBefore is
				// exactly the state right before this apply — correct as-is).
				const hubDelta = Y.encodeStateAsUpdate(this.document, svBefore);
				if (hubDelta.byteLength > 0) {
					// PERSISTED delta: relative to lastSavedStateVector, not svBefore.
					// svBefore only excludes changes THIS handler introduced; it can
					// still be ahead of the last value actually written to the
					// journal (e.g. a concurrent onSave still pending, or one whose
					// journal write failed and self-heals on its own next run).
					// Persisting from svBefore while advancing lastSavedStateVector
					// to svAfter would silently mark that earlier gap as persisted
					// without ever having written it — lost on DO eviction before
					// the next checkpoint. Read fresh here: everything above is
					// synchronous since svBefore was captured, so no concurrent job
					// can have moved lastSavedStateVector in between.
					const persistBase = this.lastSavedStateVector ?? svBefore;
					const persistDelta = equalBytes(persistBase, svBefore)
						? hubDelta
						: Y.encodeStateAsUpdate(this.document, persistBase);
					if (persistDelta.byteLength > 0) {
						await this.enqueueSave(persistDelta, svAfter);
					}
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
		if (request.method === "POST" && url.pathname === "/__lodestone/apply-hub-update") {
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
				// Persist relative to lastSavedStateVector, not svBefore — see the
				// matching comment in apply-spoke-update above. This delta is only
				// used for persistence here (spokes don't fan out further), so
				// there's no separate fan-out variant to keep.
				const persistBase = this.lastSavedStateVector ?? svBefore;
				const spokeDelta = Y.encodeStateAsUpdate(this.document, persistBase);
				if (spokeDelta.byteLength > 0) {
					await this.enqueueSave(spokeDelta, svAfter);
				}
			}

			return json({ ok: true, applied: true });
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

	private async loadMode(): Promise<void> {
		if (this._modeLoaded) return;
		const mode = await this.ctx.storage.get<string>(MODE_STORAGE_KEY);
		const hubVaultId = await this.ctx.storage.get<string>(HUB_VAULT_ID_STORAGE_KEY);
		this._mode =
			mode === "hub" || mode === "spoke" || mode === "standalone" || mode === "hub+spoke"
				? mode
				: "standalone";
		this._hubVaultId = typeof hubVaultId === "string" ? hubVaultId : null;
		this._modeLoaded = true;
	}

	private async getMode(): Promise<SyncMode> {
		if (!this._modeLoaded) await this.loadMode();
		return this._mode;
	}

	/**
	 * All cross-vault work here is AWAITED, not fire-and-forget. A bare
	 * `void promise.catch(...)` kicked off from onSave() has nothing left
	 * holding it alive once onSave() (and the debounced document-update
	 * listener that called it) returns — in practice the bridge call and any
	 * follow-up (specifically the structural-change revert) frequently never
	 * ran to completion at all, not just raced against the next debounce
	 * cycle. That meant a spoke's rejected structural change was silently
	 * never rolled back in its own CRDT, on top of the revert-loop risk this
	 * method also guards against (see _lastRevertStateVector). Awaiting here
	 * is safe: onSave()'s own caller (the base class's debounced listener)
	 * already awaits onSave() and only logs on failure.
	 */
	private async propagateCrossVault(delta: Uint8Array, originVaultId: string): Promise<void> {
		if (!this._modeLoaded) await this.loadMode();
		const env = this.env as ServerEnv;

		// Spoke direction: propagate changes up to the hub.
		if ((this._mode === "spoke" || this._mode === "hub+spoke") && this._hubVaultId) {
			const bridgeResult = await propagateSpokeToHub(env, originVaultId, this._hubVaultId, delta);
			if (bridgeResult.rejected) {
				try {
					await this.revertRejectedStructuralChange(delta);
				} catch (err) {
					console.error(`${LOG_PREFIX} failed to revert rejected structural change:`, err);
				}
			}
		}

		// Hub direction: fan out changes down to all connected spokes.
		if (this._mode === "hub" || this._mode === "hub+spoke") {
			const spokes = await listHubSpokes(env, originVaultId);
			if (spokes.length > 0) {
				const filtered = this.buildFilteredUpdate(delta, this.getHubKnownPaths());
				if (filtered && filtered.byteLength > 0) {
					await propagateHubToSpokes(env, originVaultId, filtered, originVaultId, spokes);
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

	/**
	 * Replays `updateBytes` on a scratch probe doc and reports which top-level
	 * keys of the vault-tree structure maps (pathToId, meta, idToText) it
	 * touched. Edits to the body of an existing Y.Text never show up here —
	 * only add/update/delete of a map *entry* does (file create/rename/move/
	 * delete).
	 *
	 * `seedWithCurrentDocument` controls what the probe starts from, and
	 * callers MUST pick correctly or this silently reports zero touched keys:
	 *
	 * - `true` (default) — seed the probe with `this.document`'s CURRENT
	 *   state before replay. Required when `updateBytes` is a FOREIGN delta
	 *   this document has not yet merged (the hub inspecting an incoming
	 *   spoke update in `updateTouchesStructure`): a rename overwrites an
	 *   existing key and references a predecessor item that only exists in
	 *   the real document, so replaying against a bare empty doc would
	 *   silently drop it instead of registering a change.
	 * - `false` — replay against a bare empty doc. Required when
	 *   `updateBytes` is THIS document's OWN delta that has already been
	 *   merged into `this.document` (revertRejectedStructuralChange, always
	 *   called on the vault that originated the change). Seeding with the
	 *   current state there would clone a document that already contains
	 *   every op in the delta, so replaying it again produces no detectable
	 *   diff at all — every revert would silently no-op.
	 */
	private extractStructuralKeys(
		updateBytes: Uint8Array,
		seedWithCurrentDocument = true,
	): {
		pathToId: Set<string>;
		meta: Set<string>;
		idToText: Set<string>;
	} {
		const probeDoc = new Y.Doc();
		if (seedWithCurrentDocument) {
			Y.applyUpdate(probeDoc, Y.encodeStateAsUpdate(this.document));
		}

		const touched = {
			pathToId: new Set<string>(),
			meta: new Set<string>(),
			idToText: new Set<string>(),
		};
		const pathToIdMap: unknown = probeDoc.getMap("pathToId");
		const metaMap: unknown = probeDoc.getMap("meta");
		const idToTextMap: unknown = probeDoc.getMap("idToText");

		const handler = (transaction: Y.Transaction) => {
			for (const [type, events] of transaction.changedParentTypes) {
				let bucket: Set<string> | null = null;
				if ((type as unknown) === pathToIdMap) bucket = touched.pathToId;
				else if ((type as unknown) === metaMap) bucket = touched.meta;
				else if ((type as unknown) === idToTextMap) bucket = touched.idToText;
				if (!bucket) continue;
				for (const event of events) {
					if (event instanceof Y.YMapEvent) {
						for (const key of event.keys.keys()) bucket.add(key);
					}
				}
			}
		};
		probeDoc.on("afterTransaction", handler);
		try {
			Y.applyUpdate(probeDoc, updateBytes);
		} finally {
			probeDoc.off("afterTransaction", handler);
			probeDoc.destroy();
		}
		return touched;
	}

	/**
	 * Replays `updateBytes` on a probe seeded with the current document and
	 * reports which idToText fileIds had their Y.Text BODY (not the
	 * containing map's keys) modified — i.e. ordinary content edits, the
	 * complement of extractStructuralKeys. Uses a reverse lookup from live
	 * Y.Text object identity to fileId, since idToText stores references.
	 *
	 * Needed because a body edit to a fileId with no live hub-known meta
	 * entry (privacy leak 4.1: a stale/orphaned fileId a spoke still has
	 * locally, or one only present in that spoke's copy of the room doc)
	 * passes updateTouchesStructure — it never touches pathToId/meta/idToText
	 * map keys — and would otherwise merge untracked content into the hub
	 * doc that still gets fanned out to every other spoke.
	 */
	private findContentTouchedFileIds(updateBytes: Uint8Array): Set<string> {
		const probeDoc = new Y.Doc();
		Y.applyUpdate(probeDoc, Y.encodeStateAsUpdate(this.document));

		const idToTextMap = probeDoc.getMap<Y.Text>("idToText");
		const textToFileId = new Map<Y.Text, string>();
		idToTextMap.forEach((text, fileId) => {
			if (text instanceof Y.Text) textToFileId.set(text, fileId);
		});

		const touchedFileIds = new Set<string>();
		const handler = (transaction: Y.Transaction) => {
			for (const [type] of transaction.changedParentTypes) {
				if (type instanceof Y.Text) {
					const fileId = textToFileId.get(type);
					if (fileId) touchedFileIds.add(fileId);
				}
			}
		};
		probeDoc.on("afterTransaction", handler);
		try {
			Y.applyUpdate(probeDoc, updateBytes);
		} finally {
			probeDoc.off("afterTransaction", handler);
			probeDoc.destroy();
		}
		return touchedFileIds;
	}

	/** True if `updateBytes` adds/renames/moves/deletes a file or folder rather than just editing text. */
	private updateTouchesStructure(updateBytes: Uint8Array): boolean {
		const touched = this.extractStructuralKeys(updateBytes);
		return touched.pathToId.size > 0 || touched.meta.size > 0 || touched.idToText.size > 0;
	}

	/**
	 * Undo a structural change locally after the hub has rejected it. The spoke
	 * already applied the change to its own document before sync (Obsidian fired
	 * the vault event first); since the hub never merged it, this vault must roll
	 * its own copy back so the two documents don't permanently diverge.
	 *
	 * Runs under `_applyingCrossVaultUpdate` so it doesn't get re-proposed to the
	 * hub (which would just reject it again and loop forever).
	 */
	private async revertRejectedStructuralChange(delta: Uint8Array): Promise<void> {
		await this.ensureDocumentLoaded();
		// Unseeded: `delta` is this vault's OWN change, already merged into
		// this.document — see extractStructuralKeys' doc comment.
		const touched = this.extractStructuralKeys(delta, false);
		if (touched.pathToId.size === 0 && touched.meta.size === 0 && touched.idToText.size === 0) {
			return;
		}

		// Match the plugin's own tombstone shape (vaultSync.ts setMetaDeleted) so
		// downstream consumers (orphan GC, snapshot diff) recognize this as a
		// normal soft-delete rather than a malformed meta entry. Schema v2 uses a
		// minimal {path, deletedAt} tombstone; v1 (and unset, which the plugin
		// itself treats as v1) keeps the legacy {deleted, deletedAt, mtime} shape.
		const schemaVersion = this.currentSchemaVersion();
		const isLegacySchema = schemaVersion === null || schemaVersion < 2;
		const deletedAt = Date.now();

		this._applyingCrossVaultUpdate = true;
		try {
			const pathToId = this.document.getMap<string>("pathToId");
			const meta = this.document.getMap<Record<string, unknown>>("meta");
			const idToText = this.document.getMap<Y.Text>("idToText");
			this.document.transact(() => {
				for (const key of touched.pathToId) pathToId.delete(key);
				for (const key of touched.idToText) idToText.delete(key);
				for (const key of touched.meta) {
					const existing = meta.get(key);
					const path = typeof existing?.path === "string" ? existing.path : undefined;
					meta.set(
						key,
						isLegacySchema
							? { path, deleted: true, deletedAt, mtime: deletedAt }
							: { path, deletedAt },
					);
				}
			});
		} finally {
			this._applyingCrossVaultUpdate = false;
			// Recorded even if the transact() body no-ops (e.g. re-reverting an
			// already-tombstoned key) — onSave's check-and-clear only needs the
			// resulting state vector, not whether this call produced new bytes.
			this._lastRevertStateVector = Y.encodeStateVector(this.document);
		}

		await this.recordTrace("spoke-structural-change-reverted", {
			pathToIdKeys: Array.from(touched.pathToId),
			metaKeys: Array.from(touched.meta),
			idToTextKeys: Array.from(touched.idToText),
		});
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
