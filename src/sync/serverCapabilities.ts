import { obsidianRequest } from "../utils/http";

export interface ServerCapabilities {
	claimed: boolean;
	authMode: "env" | "claim" | "unclaimed";
	attachments: boolean;
	snapshots: boolean;
	serverVersion: string;
	minPluginVersion: string | null;
	recommendedPluginVersion: string | null;
	minSchemaVersion: number | null;
	maxSchemaVersion: number | null;
	migrationRequired: boolean;
	updateProvider: "github" | "gitlab" | "unknown" | null;
	updateRepoUrl: string | null;
	updateRepoBranch?: string | null;
}

export async function fetchServerCapabilities(host: string): Promise<ServerCapabilities> {
	const base = host.replace(/\/$/, "");
	const res = await obsidianRequest({
		url: `${base}/api/capabilities`,
		method: "GET",
	});
	if (res.status !== 200) {
		throw new Error(`capabilities request failed (${res.status})`);
	}
	return res.json as ServerCapabilities;
}

/** Mint a fresh room-scoped token for `roomId`, authenticated with this
 * vault's own master token. The returned token only ever authorizes WS sync
 * and blob access for that one room's Durable Object — never the vault's
 * main sync, snapshots, debug routes, or any other room. Used to build
 * invite links so a leaked invite can't grant broader access. */
export async function mintRoomToken(host: string, masterToken: string, roomId: string): Promise<string> {
	const base = host.replace(/\/$/, "");
	const res = await obsidianRequest({
		url: `${base}/vault/${encodeURIComponent(roomId)}/room-token`,
		method: "POST",
		headers: {
			Authorization: `Bearer ${masterToken}`,
		},
	});
	if (res.status !== 200) {
		throw new Error(`room token mint failed (${res.status})`);
	}
	const payload = res.json as { token?: string };
	if (!payload.token) {
		throw new Error("room token mint failed (missing token)");
	}
	return payload.token;
}
