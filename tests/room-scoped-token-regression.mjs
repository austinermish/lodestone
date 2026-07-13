/**
 * Room-scoped token regression test (v3.3.0, C2-3/C2-4).
 *
 * Invite links no longer embed the vault's master token. Instead, the hub
 * mints a token scoped to one room's own Durable Object via
 * POST /vault/{roomId}/room-token (master-token-authenticated), and that
 * minted token is verified server-side via the DO's internal
 * verify-room-token route. This test exercises the real HTTP surface end to
 * end: minting requires the master token; a minted token authorizes WS sync
 * and blob routes for ITS OWN room only; it is rejected for any other room,
 * and rejected outright for debug/snapshots (master-token-only, no fallback).
 *
 * Run: node tests/room-scoped-token-regression.mjs   (spawns its own wrangler dev)
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
const ROOM_A = `room-token-check-a-${Date.now().toString(36)}`;
const ROOM_B = `room-token-check-b-${Date.now().toString(36)}`;

const failures = [];
function check(label, condition) {
	if (condition) {
		console.log(`  PASS  ${label}`);
	} else {
		console.error(`  FAIL  ${label}`);
		failures.push(label);
	}
}

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

async function mintRoomToken(masterToken, roomId) {
	const res = await fetch(`${HOST}/vault/${roomId}/room-token`, {
		method: "POST",
		headers: masterToken ? { Authorization: `Bearer ${masterToken}` } : {},
	});
	return res;
}

/** Attempt a plain WS sync handshake; resolves "synced" or "rejected" — never hangs. */
async function attemptWsSync(roomId, token) {
	const { default: YSyncProvider } = await import("y-partyserver/provider");
	const doc = new Y.Doc();
	const provider = new YSyncProvider(HOST, roomId, doc, {
		prefix: `/vault/sync/${encodeURIComponent(roomId)}`,
		params: { token, schemaVersion: "2" },
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: true,
	});
	try {
		return await new Promise((resolvePromise) => {
			const timeout = setTimeout(() => resolvePromise("timeout"), 8000);
			provider.on("sync", (synced) => {
				if (!synced) return;
				clearTimeout(timeout);
				resolvePromise("synced");
			});
			// y-partyserver's WS wrapper emits its own status changes on close.
			provider.on("status", (event) => {
				if (event?.status === "disconnected") {
					clearTimeout(timeout);
					resolvePromise("rejected");
				}
			});
			if (provider.synced) {
				clearTimeout(timeout);
				resolvePromise("synced");
			}
		});
	} finally {
		provider.destroy();
		doc.destroy();
	}
}

async function main() {
	const persistDir = mkdtempSync(join(tmpdir(), "lodestone-roomtoken-"));
	const rawEnvToken = randomBytes(32).toString("hex");
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
				SYNC_TOKEN: rawEnvToken,
			},
		},
	);
	wrangler.stderr.on("data", (d) => process.stderr.write(d));
	wrangler.stdout.on("data", (d) => process.stderr.write(d));
	wrangler.on("exit", (code) => {
		if (code !== null && code !== 0) console.error(`wrangler dev exited early (code ${code})`);
	});

	try {
		await waitForWorker();
		const envToken = await resolveAuthToken(rawEnvToken);

		// Minting without any auth must fail — this is a master-token-only route.
		const unauthMint = await mintRoomToken(null, ROOM_A);
		check("mint without master token is rejected", unauthMint.status === 401);

		// Minting with the wrong token must fail.
		const wrongMint = await mintRoomToken(randomBytes(32).toString("hex"), ROOM_A);
		check("mint with wrong token is rejected", wrongMint.status === 401);

		// Minting with the master token succeeds and returns a plaintext token.
		const mintA = await mintRoomToken(envToken, ROOM_A);
		check("mint with master token succeeds", mintA.status === 200);
		const { token: roomATokenPayload } = await mintA.json();
		check("mint response includes a token", typeof roomATokenPayload === "string" && roomATokenPayload.length > 0);

		await mintRoomToken(envToken, ROOM_B);

		// The room A token authorizes WS sync for room A.
		const ownRoomSync = await attemptWsSync(ROOM_A, roomATokenPayload);
		check("room A token authorizes WS sync for room A", ownRoomSync === "synced");

		// The room A token does NOT authorize WS sync for room B.
		const crossRoomSync = await attemptWsSync(ROOM_B, roomATokenPayload);
		check("room A token is rejected for room B's WS sync", crossRoomSync === "rejected");

		// The room A token authorizes the blobs route for room A (falls through
		// past auth to "attachments_unavailable" rather than "unauthorized",
		// since this local dev worker has no R2 bucket bound).
		const blobsOwnRoom = await fetch(`${HOST}/vault/${ROOM_A}/blobs/exists`, {
			method: "POST",
			headers: { Authorization: `Bearer ${roomATokenPayload}`, "Content-Type": "application/json" },
			body: JSON.stringify({ hashes: [] }),
		});
		check("room A token authorizes blobs route for room A", blobsOwnRoom.status !== 401);

		// The room A token does NOT authorize the blobs route for room B.
		const blobsCrossRoom = await fetch(`${HOST}/vault/${ROOM_B}/blobs/exists`, {
			method: "POST",
			headers: { Authorization: `Bearer ${roomATokenPayload}`, "Content-Type": "application/json" },
			body: JSON.stringify({ hashes: [] }),
		});
		check("room A token is rejected for room B's blobs route", blobsCrossRoom.status === 401);

		// The room A token must NOT authorize debug or snapshots for its own
		// room — those routes stay master-token-only, no room-token fallback.
		const debugOwnRoom = await fetch(`${HOST}/vault/${ROOM_A}/debug/recent`, {
			headers: { Authorization: `Bearer ${roomATokenPayload}` },
		});
		check("room A token is rejected for its own room's debug route", debugOwnRoom.status === 401);

		const snapshotsOwnRoom = await fetch(`${HOST}/vault/${ROOM_A}/snapshots`, {
			headers: { Authorization: `Bearer ${roomATokenPayload}` },
		});
		check("room A token is rejected for its own room's snapshots route", snapshotsOwnRoom.status === 401);

		// The room A token must NOT authorize minting a token for any room
		// (room-token is not in the fallback allow-list at all).
		const remint = await mintRoomToken(roomATokenPayload, ROOM_A);
		check("room A token cannot mint another room token", remint.status === 401);

		console.log("──────────────────────────────");
		if (failures.length > 0) {
			console.error(`Result: room-scoped-token regression FAILED (${failures.length} failure(s))`);
		} else {
			console.log("Result: room-scoped-token regression PASSED");
		}
	} catch (err) {
		failures.push(err instanceof Error ? err.message : String(err));
		console.error("FAIL ", err instanceof Error ? err.message : err);
	} finally {
		wrangler.kill("SIGTERM");
		await wait(500);
		rmSync(persistDir, { recursive: true, force: true });
	}
	process.exit(failures.length > 0 ? 1 : 0);
}

await main();
