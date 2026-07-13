/**
 * Room sync sanity check for the REAL room architecture (v3.3.0+).
 *
 * Rooms are NOT bridged between separate per-vault Durable Objects — a hub
 * and every spoke connect to the exact same Durable Object (same roomId used
 * as vaultId on both sides) and sync via ordinary Yjs collaborative editing,
 * the same mechanism as two devices on one person's own vault. There is no
 * registration step and no explicit "seed the spoke" push: connecting a
 * second client to an existing roomId gets the full document for free via
 * the normal y-partyserver sync handshake (steps 1/2).
 *
 * (The previous version of this test exercised a separate hub/spoke
 * DO-to-DO bridge — HubRegistry, /hub/{id}/spokes registration, an explicit
 * apply-hub-update seed push — that turned out to be dead code, unreachable
 * from the real plugin, and was deleted in the same release as this test's
 * rewrite. See PROJECT-PLAN.md Phase 4 for the full writeup.)
 *
 * This test seeds a large (~1 MB) document from one client, then connects a
 * SECOND client to the same roomId and confirms it receives everything via
 * plain WS sync — the actual mechanism rooms depend on, at a size well past
 * the byte-level pitfalls (e.g. argument-count limits) that have bitten
 * one-shot encoders in this codebase before.
 *
 * Run: node tests/room-same-doc-sync-check.mjs   (spawns its own wrangler dev)
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
const ROOM_ID = `room-sync-check-${Date.now().toString(36)}`;

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

/** Sync a Y.Doc into (or out of) a room over WebSocket via y-partyserver. */
async function syncDoc(vaultId, token, ydoc, { pushOnly = false } = {}) {
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
	if (pushOnly) await wait(1500);
	provider.destroy();
}

async function main() {
	const persistDir = mkdtempSync(join(tmpdir(), "lodestone-roomsync-"));
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
		const authToken = await resolveAuthToken(envToken);

		// 1. First client ("hub") pushes a large document into the room.
		const firstDoc = new Y.Doc();
		firstDoc.transact(() => {
			const pathToId = firstDoc.getMap("pathToId");
			const idToText = firstDoc.getMap("idToText");
			const meta = firstDoc.getMap("meta");
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
		await syncDoc(ROOM_ID, authToken, firstDoc, { pushOnly: true });
		const docSize = Y.encodeStateAsUpdate(firstDoc).byteLength;
		console.log(`first client pushed: ${FILE_COUNT} files, encoded size ${(docSize / 1024).toFixed(0)} KB`);
		if (docSize < 150_000) {
			throw new Error("test doc too small to be a meaningful scale check");
		}

		// 2. Second client ("spoke") connects to the SAME roomId — no
		// registration, no seed push, just an ordinary WS connection.
		const secondDoc = new Y.Doc();
		await syncDoc(ROOM_ID, authToken, secondDoc);
		const secondTexts = secondDoc.getMap("idToText");
		if (secondTexts.size !== FILE_COUNT) {
			throw new Error(`second client has ${secondTexts.size}/${FILE_COUNT} files after plain WS sync`);
		}
		let contentOk = 0;
		for (const [, text] of secondTexts) {
			if (text.toString().includes("lorem ipsum")) contentOk++;
		}
		if (contentOk !== FILE_COUNT) {
			throw new Error(`only ${contentOk}/${FILE_COUNT} files have intact content on the second client`);
		}
		console.log(`PASS  second client received all ${FILE_COUNT} files via plain WS sync (no registration/seed step)`);
		console.log("──────────────────────────────");
		console.log("Result: room same-doc sync check PASSED");
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
