/**
 * Regressions for the Batch A (3.0.4) critical fixes:
 *
 *  1.1  migrateSchemaToV2 must not abort mid-transaction when a pathToId
 *       entry has no meta (the old `return` inside transact() half-applied
 *       the migration and never set schemaVersion 2).
 *  1.3  v2 orphan GC must rescue collision losers (concurrent create of the
 *       same path on two devices) as conflict copies instead of deleting
 *       the losing side's content.
 *  1.6  destroy() must flush (not drop) a rename still inside the 50 ms
 *       batch window — a dropped rename resurrects the old path as a
 *       duplicate note on the next reconcile.
 *
 * Run: node --import jiti/register tests/phase1-critical-fixes-regressions.mjs
 */
import * as Y from "yjs";

const vaultSyncModule = await import("../src/sync/vaultSync.ts");
const { VaultSync } = vaultSyncModule.default ?? vaultSyncModule;

let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

/**
 * Build a VaultSync without its constructor (which opens IndexedDB and a
 * WebSocket provider). Sets exactly the fields the tested methods use.
 */
function bareVaultSync(device = "test-device") {
	const vs = Object.create(VaultSync.prototype);
	vs.ydoc = new Y.Doc();
	vs.pathToId = vs.ydoc.getMap("pathToId");
	vs.idToText = vs.ydoc.getMap("idToText");
	vs.meta = vs.ydoc.getMap("meta");
	vs.sys = vs.ydoc.getMap("sys");
	vs.pathToBlob = vs.ydoc.getMap("pathToBlob");
	vs.blobMeta = vs.ydoc.getMap("blobMeta");
	vs.blobTombstones = vs.ydoc.getMap("blobTombstones");
	vs.debug = false;
	vs._device = device;
	vs._textToFileId = new WeakMap();
	vs._pathIndex = new Map();
	vs._deletedPathIndex = new Set();
	vs._pathIndexesDirty = true;
	vs._renameBatch = new Map();
	vs._renameBatchNewToOld = new Map();
	vs._renameTimer = null;
	vs._onRenameBatchFlushed = null;
	vs._eventRing = [];
	vs.meta.observe(() => {
		vs._pathIndexesDirty = true;
	});
	// destroy() touches provider/persistence — inert stubs.
	vs.provider = { disconnect() {}, destroy() {} };
	vs.persistence = { destroy: async () => {} };
	// The "obsidian" package is types-only at runtime, so normalizePath is
	// unavailable under Node — shadow the private method with an equivalent.
	vs.normPath = (p) => String(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
	return vs;
}

console.log("\n--- 1.1: migrateSchemaToV2 completes despite a missing meta entry ---");
{
	const vs = bareVaultSync();
	vs.ydoc.transact(() => {
		// File A: pathToId entry with NO meta (the trigger).
		const textA = new Y.Text();
		textA.insert(0, "content A");
		vs.pathToId.set("a.md", "id-a");
		vs.idToText.set("id-a", textA);
		// File B: normal v1 file whose meta.path disagrees (needs updating).
		const textB = new Y.Text();
		textB.insert(0, "content B");
		vs.pathToId.set("b.md", "id-b");
		vs.idToText.set("id-b", textB);
		vs.meta.set("id-b", { path: "old-b.md", mtime: 1 });
		// File C: legacy tombstone that must be converted to v2 form.
		vs.pathToId.set("c.md", "id-c");
		vs.meta.set("id-c", { path: "c.md", deleted: true, mtime: 2 });
	});

	const result = vs.migrateSchemaToV2("migrator");

	assert(vs.sys.get("schemaVersion") === 2, "schemaVersion set to 2 in one pass");
	assert(result.metaCreated === 1, "missing meta entry was created");
	assert(vs.meta.get("id-a")?.path === "a.md", "created meta points at the canonical path");
	assert(vs.meta.get("id-b")?.path === "b.md", "later meta path update still applied (no early abort)");
	const cMeta = vs.meta.get("id-c");
	assert(typeof cMeta?.deletedAt === "number" && cMeta?.deleted === undefined, "legacy tombstone still converted (no early abort)");
}

console.log("\n--- 1.3: orphan GC rescues collision losers as conflict copies ---");
{
	const vs = bareVaultSync("device-1");
	vs.ydoc.transact(() => {
		vs.sys.set("schemaVersion", 2);
		// Two devices created "Ideas.md" concurrently with different content.
		const winner = new Y.Text();
		winner.insert(0, "winner content");
		vs.idToText.set("id-win", winner);
		vs.meta.set("id-win", { path: "Ideas.md", mtime: 2000, device: "device-1" });
		const loser = new Y.Text();
		loser.insert(0, "loser content — unique work that must survive");
		vs.idToText.set("id-lose", loser);
		vs.meta.set("id-lose", { path: "Ideas.md", mtime: 1000, device: "device-2" });
		// A genuinely orphaned empty text with no meta at all — must still be GC'd.
		vs.idToText.set("id-junk", new Y.Text());
	});

	const result = vs.runIntegrityChecks();

	assert(vs.idToText.has("id-lose"), "collision loser's Y.Text was not deleted");
	const rescuedMeta = vs.meta.get("id-lose");
	assert(
		typeof rescuedMeta?.path === "string" && rescuedMeta.path.includes("conflict from device-2"),
		`loser rescued at a conflict-copy path (got "${rescuedMeta?.path}")`,
	);
	assert(vs.idToText.get("id-lose").toJSON().includes("unique work"), "loser content intact");
	assert(vs.meta.get("id-win")?.path === "Ideas.md", "winner keeps the original path");
	assert(!vs.idToText.has("id-junk"), "true orphan (no meta) still GC'd");
	assert(result.orphansCleaned === 1, "orphansCleaned counts only real deletions");
}

console.log("\n--- 1.6: destroy() flushes a rename inside the batch window ---");
{
	const vs = bareVaultSync("device-1");
	vs.ydoc.transact(() => {
		vs.sys.set("schemaVersion", 2);
		const text = new Y.Text();
		text.insert(0, "note body");
		vs.idToText.set("id-1", text);
		vs.meta.set("id-1", { path: "Old Name.md", mtime: 1000, device: "device-1" });
	});

	vs.queueRename("Old Name.md", "New Name.md");
	// Destroy immediately — inside the 50 ms batch window.
	vs.destroy();

	// Inspect the doc state that would have been persisted/broadcast.
	let activePath = null;
	vs.meta.forEach((m) => {
		if (typeof m.deletedAt !== "number" && m.deleted !== true) activePath = m.path;
	});
	assert(activePath === "New Name.md", `rename applied before teardown (active path: "${activePath}")`);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");
process.exit(failed > 0 ? 1 : 0);
