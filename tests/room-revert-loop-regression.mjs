/**
 * Regression for the structural-rejection revert-loop fix (4.3, v3.2.0).
 *
 * Root cause: onSave() is invoked via a debounced Y.Doc "update" listener
 * (100 ms wait / 500 ms max, server.ts static callbackOptions) — NOT
 * synchronously after a transaction. revertRejectedStructuralChange() wraps
 * its own document.transact() in _applyingCrossVaultUpdate = true/false, but
 * resets that flag to false synchronously, well before the debounced onSave
 * for that same transaction actually fires. So the revert's own delta was
 * indistinguishable from a genuine new local edit by the time onSave checked
 * the flag — it got re-proposed to the hub, rejected again (still touches
 * meta/pathToId/idToText), reverted again (fresh deletedAt timestamp each
 * time), forever, on a ~100-500ms cycle.
 *
 * This test: a spoke makes a structural change (new file) directly on its own
 * Y.Doc over a real WS connection, waits several debounce cycles, and asserts
 * the server recorded exactly ONE "spoke-structural-change-reverted" trace
 * event (not a growing count) and that the reverted meta entry's `deletedAt`
 * stops changing — i.e. the loop does not run away.
 *
 * Run: node tests/room-revert-loop-regression.mjs   (spawns its own wrangler dev)
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Y from "yjs";
import WebSocket from "ws";

const HOST = "http://127.0.0.1:8798";
const WRANGLER_BIN = resolve("server/node_modules/.bin/wrangler");
const HUB_VAULT = `revertloop-hub-${Date.now().toString(36)}`;
const SPOKE_VAULT = `revertloop-spoke-${Date.now().toString(36)}`;

function wait(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitForWorker() {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${HOST}/api/capabilities`);
			if (res.status > 0) return;
		} catch { /* not up yet */ }
		await wait(250);
	}
	throw new Error("Timed out waiting for wrangler dev");
}

async function resolveAuthToken(defaultEnvToken) {
	const capabilities = await fetch(`${HOST}/api/capabilities`).then((r) => r.json());
	if (capabilities?.claimed === true && capabilities?.authMode === "env") {
		return defaultEnvToken;
	}
	const token = randomBytes(32).toString("hex");
	const res = await fetch(`${HOST}/claim`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
	});
	if (!res.ok) throw new Error(`claim failed (${res.status})`);
	return token;
}

async function connectDoc(vaultId, token, ydoc) {
	const { default: YSyncProvider } = await import("y-partyserver/provider");
	const provider = new YSyncProvider(HOST, vaultId, ydoc, {
		prefix: `/vault/sync/${encodeURIComponent(vaultId)}`,
		params: { token, schemaVersion: "2" },
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: true,
	});
	await new Promise((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(() => rejectPromise(new Error(`sync timeout for ${vaultId}`)), 30_000);
		const check = (synced) => {
			if (!synced) return;
			clearTimeout(timeout);
			resolvePromise();
		};
		provider.on("sync", check);
		if (provider.synced) check(true);
	});
	return provider;
}

async function fetchDebugRecent(vaultId, token) {
	const res = await fetch(`${HOST}/vault/${encodeURIComponent(vaultId)}/debug/recent`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) throw new Error(`debug/recent failed (${res.status})`);
	const payload = await res.json();
	return Array.isArray(payload.recent) ? payload.recent : [];
}

async function main() {
	const persistDir = mkdtempSync(join(tmpdir(), "lodestone-revertloop-"));
	const envToken = randomBytes(32).toString("hex");
	const wrangler = spawn(
		WRANGLER_BIN,
		["dev", "--ip", "127.0.0.1", "--port", "8798", "--local-protocol", "http", "--persist-to", persistDir, "--log-level", "error"],
		{
			cwd: resolve("server"),
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
				CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
				SYNC_TOKEN: envToken,
			},
		},
	);
	wrangler.stderr.on("data", (d) => process.stderr.write(d));
	wrangler.stdout.on("data", (d) => process.stderr.write(d));
	wrangler.on("exit", (code) => {
		if (code !== null && code !== 0) console.error(`wrangler dev exited early (code ${code})`);
	});

	let failed = false;
	try {
		await waitForWorker();
		const authToken = await resolveAuthToken(envToken);

		// 1. Seed the hub with one known file so it has *some* content, then
		// register the spoke.
		const hubDoc = new Y.Doc();
		hubDoc.transact(() => {
			const text = new Y.Text();
			text.insert(0, "hub content");
			hubDoc.getMap("idToText").set("hub-file-1", text);
			hubDoc.getMap("pathToId").set("Shared/existing.md", "hub-file-1");
			hubDoc.getMap("meta").set("hub-file-1", { path: "Shared/existing.md", mtime: Date.now() });
		});
		const hubProvider = await connectDoc(HUB_VAULT, authToken, hubDoc);
		await wait(1500);
		hubProvider.destroy();

		const regRes = await fetch(`${HOST}/hub/${encodeURIComponent(HUB_VAULT)}/spokes`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
			body: JSON.stringify({ spokeVaultId: SPOKE_VAULT, deviceName: "revert-loop-test" }),
		});
		const regPayload = await regRes.json();
		console.log("registration response:", JSON.stringify(regPayload));
		if (!regRes.ok) throw new Error(`spoke registration failed (${regRes.status})`);

		// 2. Connect as the spoke and make a STRUCTURAL change (new file) — the
		// kind of edit the hub always rejects from a spoke.
		const spokeDoc = new Y.Doc();
		const spokeProvider = await connectDoc(SPOKE_VAULT, authToken, spokeDoc);

		console.log(`t=${Date.now()} making structural edit on spoke doc`);
		const newFileId = "spoke-new-file-1";
		spokeDoc.transact(() => {
			const text = new Y.Text();
			text.insert(0, "spoke tried to create this file");
			spokeDoc.getMap("idToText").set(newFileId, text);
			spokeDoc.getMap("pathToId").set("Shared/spoke-created.md", newFileId);
			spokeDoc.getMap("meta").set(newFileId, { path: "Shared/spoke-created.md", mtime: Date.now() });
		});

		// 3. Wait many debounce cycles (100/500ms) — long enough for a runaway
		// loop to have fired repeatedly, short enough to keep the test fast.
		await wait(6000);
		console.log(`t=${Date.now()} done waiting`);

		const firstMeta = spokeDoc.getMap("meta").get(newFileId);
		const firstDeletedAt = firstMeta?.deletedAt;
		if (typeof firstDeletedAt !== "number") {
			const spokeTrace = await fetchDebugRecent(SPOKE_VAULT, authToken).catch((e) => [`<trace fetch failed: ${e}>`]);
			const hubTrace = await fetchDebugRecent(HUB_VAULT, authToken).catch((e) => [`<trace fetch failed: ${e}>`]);
			console.error("DIAGNOSTIC spoke trace:", JSON.stringify(spokeTrace, null, 2));
			console.error("DIAGNOSTIC hub trace:", JSON.stringify(hubTrace, null, 2));
			throw new Error(`expected reverted meta with deletedAt, got: ${JSON.stringify(firstMeta)}`);
		}
		console.log(`PASS  spoke's structural change was reverted (tombstoned) as expected`);

		// 4. Wait again — if the loop is running, deletedAt will have changed.
		await wait(3000);
		const secondMeta = spokeDoc.getMap("meta").get(newFileId);
		const secondDeletedAt = secondMeta?.deletedAt;
		if (secondDeletedAt !== firstDeletedAt) {
			throw new Error(
				`REVERT LOOP DETECTED: deletedAt changed from ${firstDeletedAt} to ${secondDeletedAt} ` +
				`during a quiet window — the revert is being re-proposed and re-rejected repeatedly`,
			);
		}
		console.log(`PASS  deletedAt stable across a second wait window (no revert loop)`);

		// 5. Confirm via server trace: exactly one revert event recorded, not a
		// growing count.
		const trace = await fetchDebugRecent(SPOKE_VAULT, authToken);
		const revertEvents = trace.filter((e) => e.event === "spoke-structural-change-reverted");
		if (revertEvents.length !== 1) {
			throw new Error(
				`expected exactly 1 "spoke-structural-change-reverted" trace event, got ${revertEvents.length} ` +
				`(a count > 1 means the loop fired more than once)`,
			);
		}
		console.log(`PASS  exactly 1 revert trace event recorded (no runaway loop)`);

		spokeProvider.destroy();
		console.log("──────────────────────────────");
		console.log("Result: revert-loop regression check PASSED");
	} catch (err) {
		failed = true;
		console.error("FAIL ", err instanceof Error ? err.message : err);
	} finally {
		wrangler.kill("SIGTERM");
		await wait(500);
		rmSync(persistDir, { recursive: true, force: true });
	}
	process.exit(failed ? 1 : 0);
}

await main();
