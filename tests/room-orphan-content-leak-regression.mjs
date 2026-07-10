/**
 * Regression for the 4.1 privacy-leak fix (v3.2.0).
 *
 * The bug: a body edit (content-only, no pathToId/meta/idToText map-key
 * touch) to a fileId with no LIVE, hub-known meta entry passed
 * updateTouchesStructure unconditionally — it never touches the containing
 * maps' keys, only the nested Y.Text's own structure — so it merged into the
 * hub's document as an untracked orphan and still got fanned out to every
 * other spoke, regardless of whether the hub actually considers that file
 * part of the shared room.
 *
 * This test seeds the HUB's own doc with an "orphan" idToText/pathToId entry
 * that has NO meta entry at all (simulating a stale/leftover fileId with no
 * home in the hub's authoritative file list — the precondition described in
 * the finding), registers a spoke (which legitimately receives that content
 * via the unfiltered initial seed push), then has the spoke edit that
 * orphan's body and asserts the hub REJECTS the edit instead of silently
 * merging + fanning it out.
 *
 * Run: node tests/room-orphan-content-leak-regression.mjs (spawns wrangler dev)
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Y from "yjs";
import WebSocket from "ws";

const HOST = "http://127.0.0.1:8797";
const WRANGLER_BIN = resolve("server/node_modules/.bin/wrangler");
const HUB_VAULT = `orphanleak-hub-${Date.now().toString(36)}`;
const SPOKE_VAULT = `orphanleak-spoke-${Date.now().toString(36)}`;
const ORPHAN_FILE_ID = "orphan-file-1";

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
	const persistDir = mkdtempSync(join(tmpdir(), "lodestone-orphanleak-"));
	const envToken = randomBytes(32).toString("hex");
	const wrangler = spawn(
		WRANGLER_BIN,
		["dev", "--ip", "127.0.0.1", "--port", "8797", "--local-protocol", "http", "--persist-to", persistDir, "--log-level", "error"],
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

		// 1. Seed the hub with ONE legitimate file plus ONE orphan: an
		// idToText + pathToId entry with NO corresponding meta entry at all.
		const hubDoc = new Y.Doc();
		hubDoc.transact(() => {
			const goodText = new Y.Text();
			goodText.insert(0, "legitimate content");
			hubDoc.getMap("idToText").set("hub-file-1", goodText);
			hubDoc.getMap("pathToId").set("Shared/existing.md", "hub-file-1");
			hubDoc.getMap("meta").set("hub-file-1", { path: "Shared/existing.md", mtime: Date.now() });

			const orphanText = new Y.Text();
			orphanText.insert(0, "orphan content with no meta entry");
			hubDoc.getMap("idToText").set(ORPHAN_FILE_ID, orphanText);
			hubDoc.getMap("pathToId").set("Shared/orphan.md", ORPHAN_FILE_ID);
			// Deliberately no meta.set(ORPHAN_FILE_ID, ...) — this is the
			// "no live, hub-known meta entry" precondition from the finding.
		});
		const hubProvider = await connectDoc(HUB_VAULT, authToken, hubDoc);
		await wait(1500);
		hubProvider.destroy();

		// 2. Register a spoke — the initial seed push is unfiltered, so the
		// spoke legitimately receives the orphan's content too.
		const regRes = await fetch(`${HOST}/hub/${encodeURIComponent(HUB_VAULT)}/spokes`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
			body: JSON.stringify({ spokeVaultId: SPOKE_VAULT, deviceName: "orphan-leak-test" }),
		});
		if (!regRes.ok) throw new Error(`spoke registration failed (${regRes.status})`);

		const spokeDoc = new Y.Doc();
		const spokeProvider = await connectDoc(SPOKE_VAULT, authToken, spokeDoc);
		await wait(500);

		const orphanTextOnSpoke = spokeDoc.getMap("idToText").get(ORPHAN_FILE_ID);
		if (!orphanTextOnSpoke) {
			throw new Error("test setup invalid: spoke never received the orphan entry from the initial seed");
		}
		console.log("PASS  spoke received the orphan entry via initial seed (test precondition confirmed)");

		// 3. Spoke edits the orphan's BODY — a pure content edit, no map-key
		// touch — and this must be rejected, not merged + fanned out.
		spokeDoc.transact(() => {
			orphanTextOnSpoke.insert(orphanTextOnSpoke.length, " -- spoke edit");
		});
		await wait(3000);

		// recorded on the HUB's DO — apply-spoke-update (and its recordTrace
		// call) runs on whichever DO owns that internal route, i.e. the hub.
		const hubTraceCheck = await fetchDebugRecent(HUB_VAULT, authToken);
		const rejectionEvents = hubTraceCheck.filter((e) => e.event === "spoke-unknown-file-edit-rejected");
		if (rejectionEvents.length === 0) {
			console.error("DIAGNOSTIC hub trace:", JSON.stringify(hubTraceCheck, null, 2));
			throw new Error('expected a "spoke-unknown-file-edit-rejected" trace event, found none — the orphan content edit was not rejected');
		}
		console.log(`PASS  orphan content edit was rejected (${rejectionEvents.length} event(s))`);

		// 4. Confirm the hub's OWN document did not absorb the spoke's edit —
		// the orphan's content on the hub must be unchanged.
		const hubDoc2 = new Y.Doc();
		const hubProvider2 = await connectDoc(HUB_VAULT, authToken, hubDoc2);
		await wait(500);
		const hubOrphanText = hubDoc2.getMap("idToText").get(ORPHAN_FILE_ID);
		const hubOrphanContent = hubOrphanText ? hubOrphanText.toString() : null;
		hubProvider2.destroy();
		if (hubOrphanContent !== "orphan content with no meta entry") {
			throw new Error(`hub's orphan content was modified by the rejected spoke edit: ${JSON.stringify(hubOrphanContent)}`);
		}
		console.log("PASS  hub's document did not absorb the rejected orphan edit");

		spokeProvider.destroy();
		console.log("──────────────────────────────");
		console.log("Result: orphan content leak regression check PASSED");
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
