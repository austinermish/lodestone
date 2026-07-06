/**
 * Regression + scale check for hub→spoke seeding (3.0.3 fix).
 *
 * The 3.0.2-and-earlier bug: btoa(String.fromCharCode(...bytes)) threw a
 * RangeError for hub docs over ~100 KB, the catch swallowed it, and the
 * spoke DO seed push (placed after the throw) never ran — spokes received
 * only new deltas, never existing files.
 *
 * This test seeds a hub vault with FILE_COUNT files (~1 MB+ total doc),
 * registers a spoke, and asserts the spoke's DO returns every file with
 * intact content, plus a valid inline initialStateUpdate payload.
 *
 * Run: node tests/room-seed-scale-check.mjs   (spawns its own wrangler dev)
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Y from "yjs";
import WebSocket from "ws";

const HOST = "http://127.0.0.1:8799";
const WRANGLER_BIN = resolve("server/node_modules/.bin/wrangler");
const FILE_COUNT = 400;
const FILE_BODY = "lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40); // ~2.3 KB per file
const HUB_VAULT = `seedscale-hub-${Date.now().toString(36)}`;
const SPOKE_VAULT = `seedscale-spoke-${Date.now().toString(36)}`;

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

/** Sync a Y.Doc into (or out of) a vault room over WebSocket via y-partyserver. */
async function syncDoc(vaultId, token, ydoc, { pushOnly = false } = {}) {
	const { default: YSyncProvider } = await import("y-partyserver/provider");
	const provider = new YSyncProvider(HOST, vaultId, ydoc, {
		prefix: `/vault/sync/${encodeURIComponent(vaultId)}`,
		params: { token, schemaVersion: "2" },
		WebSocketPolyfill: WebSocket,
		connect: true,
	});
	await new Promise((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(() => rejectPromise(new Error(`sync timeout for ${vaultId}`)), 30_000);
		provider.on("synced", () => {
			clearTimeout(timeout);
			resolvePromise();
		});
	});
	// Give the server a moment to persist the pushed state before disconnect.
	if (pushOnly) await wait(1500);
	provider.destroy();
}

async function main() {
	const persistDir = mkdtempSync(join(tmpdir(), "lodestone-seedscale-"));
	const envToken = randomBytes(32).toString("hex");
	const wrangler = spawn(
		WRANGLER_BIN,
		["dev", "--ip", "127.0.0.1", "--port", "8799", "--local-protocol", "http", "--persist-to", persistDir, "--log-level", "error"],
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

		// 1. Seed the hub with FILE_COUNT files.
		const hubDoc = new Y.Doc();
		hubDoc.transact(() => {
			const pathToId = hubDoc.getMap("pathToId");
			const idToText = hubDoc.getMap("idToText");
			const meta = hubDoc.getMap("meta");
			for (let i = 0; i < FILE_COUNT; i++) {
				const path = `Shared/notes/note-${String(i).padStart(4, "0")}.md`;
				const fileId = `file-${i}-${randomBytes(6).toString("hex")}`;
				const text = new Y.Text();
				text.insert(0, `# Note ${i}\n\n${FILE_BODY}`);
				idToText.set(fileId, text);
				pathToId.set(path, fileId);
				meta.set(fileId, { path, mtime: 1700000000000 + i });
			}
		});
		await syncDoc(HUB_VAULT, envToken, hubDoc, { pushOnly: true });
		const hubDocSize = Y.encodeStateAsUpdate(hubDoc).byteLength;
		console.log(`hub doc pushed: ${FILE_COUNT} files, encoded size ${(hubDocSize / 1024).toFixed(0)} KB`);
		if (hubDocSize < 150_000) {
			throw new Error("test doc too small to exercise the >100 KB regression");
		}

		// 2. Register the spoke (this is where seeding happens).
		const regRes = await fetch(`${HOST}/hub/${encodeURIComponent(HUB_VAULT)}/spokes`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${envToken}`,
			},
			body: JSON.stringify({ spokeVaultId: SPOKE_VAULT, deviceName: "seed-scale-test" }),
		});
		if (!regRes.ok) throw new Error(`spoke registration failed (${regRes.status})`);
		const regPayload = await regRes.json();
		if (regPayload.ok !== true) throw new Error("registration payload not ok");
		if (typeof regPayload.initialStateUpdate !== "string" || regPayload.initialStateUpdate.length === 0) {
			throw new Error("initialStateUpdate missing — inline seed payload failed (pre-3.0.3 regression)");
		}
		const inlineBytes = Buffer.from(regPayload.initialStateUpdate, "base64");
		console.log(`inline initialStateUpdate: ${(inlineBytes.byteLength / 1024).toFixed(0)} KB (base64 decode ok)`);

		// 3. Verify the inline payload round-trips into a Y.Doc with all files.
		const inlineDoc = new Y.Doc();
		Y.applyUpdate(inlineDoc, new Uint8Array(inlineBytes));
		const inlineCount = inlineDoc.getMap("idToText").size;
		if (inlineCount !== FILE_COUNT) {
			throw new Error(`inline payload has ${inlineCount}/${FILE_COUNT} files`);
		}
		console.log(`PASS  inline seed payload contains all ${FILE_COUNT} files`);

		// 4. Connect a fresh client to the SPOKE vault and verify the DO was seeded.
		const spokeDoc = new Y.Doc();
		await syncDoc(SPOKE_VAULT, envToken, spokeDoc);
		await wait(1000);
		const spokeTexts = spokeDoc.getMap("idToText");
		if (spokeTexts.size !== FILE_COUNT) {
			throw new Error(`spoke DO has ${spokeTexts.size}/${FILE_COUNT} files after seed`);
		}
		let contentOk = 0;
		for (const [, text] of spokeTexts) {
			if (text.toString().includes("lorem ipsum")) contentOk++;
		}
		if (contentOk !== FILE_COUNT) {
			throw new Error(`only ${contentOk}/${FILE_COUNT} spoke files have intact content`);
		}
		console.log(`PASS  spoke DO seeded with all ${FILE_COUNT} files, content intact`);
		console.log("──────────────────────────────");
		console.log("Result: seeding scale check PASSED");
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
