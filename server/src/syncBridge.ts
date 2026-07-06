import { getServerByName } from "partyserver";
import type { SpokeEntry } from "./hubRegistry";
import type { VaultSyncServer } from "./server";

const LOG_PREFIX = "[lodestone-sync:bridge]";

interface BridgeEnv {
	LODESTONE_SYNC: DurableObjectNamespace<VaultSyncServer>;
	LODESTONE_HUB?: DurableObjectNamespace;
}

/**
 * Propagate a Yjs delta from a spoke to its hub.
 * The hub will filter to paths it already knows, merge, and fan out to other spokes.
 */
export async function propagateSpokeToHub(
	env: BridgeEnv,
	spokeVaultId: string,
	hubVaultId: string,
	update: Uint8Array,
): Promise<{ rejected: boolean }> {
	try {
		const stub = await getServerByName(env.LODESTONE_SYNC, hubVaultId);
		const res = await stub.fetch("https://internal/__lodestone/apply-spoke-update", {
			method: "POST",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Lodestone-Origin": spokeVaultId,
			},
			body: update,
		});
		if (!res.ok) {
			console.warn(`${LOG_PREFIX} spoke→hub failed (${res.status})`);
			return { rejected: false };
		}
		const payload = (await res.json().catch(() => null)) as { rejected?: boolean } | null;
		return { rejected: payload?.rejected === true };
	} catch (err) {
		console.warn(`${LOG_PREFIX} spoke→hub error:`, err);
		return { rejected: false };
	}
}

/**
 * Propagate a Yjs delta from a hub to all registered spokes, skipping the origin spoke.
 */
export async function propagateHubToSpokes(
	env: BridgeEnv,
	hubVaultId: string,
	update: Uint8Array,
	originVaultId: string,
	spokes: SpokeEntry[],
): Promise<void> {
	const targets = spokes.filter((s) => s.spokeVaultId !== originVaultId);
	await Promise.allSettled(
		targets.map(async (spoke) => {
			try {
				const stub = await getServerByName(env.LODESTONE_SYNC, spoke.spokeVaultId);
				const res = await stub.fetch("https://internal/__lodestone/apply-hub-update", {
					method: "POST",
					headers: {
						"Content-Type": "application/octet-stream",
						"X-Lodestone-Origin": hubVaultId,
					},
					body: update,
				});
				if (!res.ok) {
					console.warn(
						`${LOG_PREFIX} hub→spoke ${spoke.spokeVaultId} failed (${res.status})`,
					);
				}
			} catch (err) {
				console.warn(
					`${LOG_PREFIX} hub→spoke ${spoke.spokeVaultId} error:`,
					err,
				);
			}
		}),
	);
}

/**
 * Fetch the list of registered spokes for a hub from HubRegistry.
 */
export async function listHubSpokes(
	env: BridgeEnv,
	hubVaultId: string,
): Promise<SpokeEntry[]> {
	if (!env.LODESTONE_HUB) return [];
	try {
		const hubId = env.LODESTONE_HUB.idFromName(hubVaultId);
		const stub = env.LODESTONE_HUB.get(hubId);
		const res = await stub.fetch("https://internal/__lodestone/hub/spokes");
		if (!res.ok) return [];
		const payload: { spokes?: SpokeEntry[] } = await res.json();
		return Array.isArray(payload.spokes) ? payload.spokes : [];
	} catch {
		return [];
	}
}
