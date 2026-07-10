/**
 * Manual investigation for plan item 4.7 (new-file live-editing delay in
 * rooms, reported by Austin from live hub/spoke testing: ~15s before a
 * spoke sees a hub's live typing into a brand-new file, no live cursor
 * until later, self-heals).
 *
 * This measures raw server-side propagation latency for the exact
 * scenario: hub creates a new file, then makes several more edits to it
 * (simulating live typing), timing how long each edit takes to become
 * visible on an already-connected spoke.
 *
 * Purpose: determine whether today's fix (propagateCrossVault/
 * propagateHubToSpokes changed from fire-and-forget to properly awaited,
 * see 4.3) already resolves or substantially improves 4.7, since that bug
 * affected ALL hub->spoke propagation, not just the structural-rejection
 * path originally scoped. This is NOT a pass/fail regression test — it's
 * a diagnostic, run manually and read by eye. Not wired into CI.
 *
 * Run: node tests/manual/room-new-file-latency-check.mjs
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Y from "yjs";
import WebSocket from "ws";

const HOST = "http://127.0.0.1:8796";
const WRANGLER_BIN = resolve("server/node_modules/.bin/wrangler");
const HUB_VAULT = `latency-hub-${Date.now().toString(36)}`;
const SPOKE_VAULT = `latency-spoke-${Date.now().toString(36)}`;
const NEW_FILE_ID = "new-file-1";

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

async function main() {
	const persistDir = mkdtempSync(join(tmpdir(), "lodestone-latency-"));
	const envToken = randomBytes(32).toString("hex");
	const wrangler = spawn(
		WRANGLER_BIN,
		["dev", "--ip", "127.0.0.1", "--port", "8796", "--local-protocol", "http", "--persist-to", persistDir, "--log-level", "error"],
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
	wrangler.stderr.on("data", () => {});
	wrangler.stdout.on("data", () => {});

	try {
		await waitForWorker();
		const authToken = await resolveAuthToken(envToken);

		const hubDoc = new Y.Doc();
		const hubProvider = await connectDoc(HUB_VAULT, authToken, hubDoc);

		const regRes = await fetch(`${HOST}/hub/${encodeURIComponent(HUB_VAULT)}/spokes`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
			body: JSON.stringify({ spokeVaultId: SPOKE_VAULT, deviceName: "latency-test" }),
		});
		if (!regRes.ok) throw new Error(`spoke registration failed (${regRes.status})`);

		// Spoke connects BEFORE the hub creates the new file, matching Austin's
		// scenario order (spoke sees the new file appear, then opens it).
		const spokeDoc = new Y.Doc();
		const spokeProvider = await connectDoc(SPOKE_VAULT, authToken, spokeDoc);

		console.log("Setup complete. Measuring hub -> spoke propagation latency for a brand-new file.\n");

		// 1. Hub creates the file (structural: pathToId + meta + idToText).
		const t0 = Date.now();
		const text = new Y.Text();
		text.insert(0, "Hello");
		hubDoc.transact(() => {
			hubDoc.getMap("idToText").set(NEW_FILE_ID, text);
			hubDoc.getMap("pathToId").set("Shared/new-file.md", NEW_FILE_ID);
			hubDoc.getMap("meta").set(NEW_FILE_ID, { path: "Shared/new-file.md", mtime: Date.now() });
		});

		const createSeenAt = await pollUntil(() => spokeDoc.getMap("pathToId").has("Shared/new-file.md"), 10_000);
		console.log(`[structural create]  hub->spoke visible after ${createSeenAt - t0}ms`);

		// 2. Hub "types" — a sequence of content-only edits, like a live typing
		// session. Measure latency of EACH one individually.
		const spokeText = () => spokeDoc.getMap("idToText").get(NEW_FILE_ID);
		const chunks = [" world", ", this", " is", " a", " live", " typing", " test"];
		for (const chunk of chunks) {
			const tEdit = Date.now();
			text.insert(text.length, chunk);
			const expected = text.toString();
			const seenAt = await pollUntil(() => spokeText()?.toString() === expected, 10_000).catch(() => null);
			if (seenAt === null) {
				console.log(`[content edit "${chunk.trim()}"]  NOT SEEN within 10s (still: "${spokeText()?.toString()}")`);
			} else {
				console.log(`[content edit "${chunk.trim()}"]  hub->spoke visible after ${seenAt - tEdit}ms`);
			}
			await wait(200); // small gap between "keystrokes"
		}

		console.log(`\nFinal spoke content: "${spokeText()?.toString()}"`);
		console.log(`Final hub content:   "${text.toString()}"`);

		hubProvider.destroy();
		spokeProvider.destroy();
	} finally {
		wrangler.kill("SIGTERM");
		await wait(500);
		rmSync(persistDir, { recursive: true, force: true });
	}
}

async function pollUntil(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return Date.now();
		await wait(50);
	}
	throw new Error("timed out waiting for condition");
}

await main();
