const SPOKES_KEY = "spokes";
const HUB_META_KEY = "hubMeta";

export interface SpokeEntry {
	spokeVaultId: string;
	deviceName: string;
	registeredAt: string;
	lastSeen?: string;
}

interface HubMeta {
	hubVaultId: string;
	createdAt: string;
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

/**
 * Stores spoke registrations for a hub vault.
 * One instance per hub vault, keyed by hubVaultId via `env.YAOS_HUB.idFromName(hubVaultId)`.
 */
export class HubRegistry {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/__yaos/hub/spokes") {
			const spokes = (await this.state.storage.get<SpokeEntry[]>(SPOKES_KEY)) ?? [];
			return json({ spokes });
		}

		if (request.method === "GET" && url.pathname === "/__yaos/hub/meta") {
			const meta = await this.state.storage.get<HubMeta>(HUB_META_KEY);
			const spokes = (await this.state.storage.get<SpokeEntry[]>(SPOKES_KEY)) ?? [];
			return json({ meta, spokeCount: spokes.length });
		}

		if (request.method === "POST" && url.pathname === "/__yaos/hub/spokes") {
			let body: { spokeVaultId?: string; deviceName?: string; hubVaultId?: string } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			if (typeof body.spokeVaultId !== "string" || !body.spokeVaultId) {
				return json({ error: "missing spokeVaultId" }, 400);
			}

			return await this.state.storage.transaction(async (txn) => {
				const spokes = (await txn.get<SpokeEntry[]>(SPOKES_KEY)) ?? [];
				const existing = spokes.findIndex((s) => s.spokeVaultId === body.spokeVaultId);
				const entry: SpokeEntry = {
					spokeVaultId: body.spokeVaultId!,
					deviceName:
						typeof body.deviceName === "string" ? body.deviceName : "Unknown Device",
					registeredAt:
						existing >= 0
							? (spokes[existing]!.registeredAt)
							: new Date().toISOString(),
					lastSeen: new Date().toISOString(),
				};

				if (existing >= 0) {
					spokes[existing] = entry;
				} else {
					spokes.push(entry);
				}

				if (typeof body.hubVaultId === "string") {
					const meta = await txn.get<HubMeta>(HUB_META_KEY);
					if (!meta) {
						await txn.put(HUB_META_KEY, {
							hubVaultId: body.hubVaultId,
							createdAt: new Date().toISOString(),
						} satisfies HubMeta);
					}
				}

				await txn.put(SPOKES_KEY, spokes);
				return json({ ok: true, entry });
			});
		}

		if (
			request.method === "DELETE" &&
			url.pathname.startsWith("/__yaos/hub/spokes/")
		) {
			const spokeVaultId = decodeURIComponent(
				url.pathname.slice("/__yaos/hub/spokes/".length),
			);
			if (!spokeVaultId) {
				return json({ error: "missing spokeVaultId" }, 400);
			}

			await this.state.storage.transaction(async (txn) => {
				const spokes = (await txn.get<SpokeEntry[]>(SPOKES_KEY)) ?? [];
				await txn.put(
					SPOKES_KEY,
					spokes.filter((s) => s.spokeVaultId !== spokeVaultId),
				);
			});
			return json({ ok: true });
		}

		if (request.method === "POST" && url.pathname === "/__yaos/hub/spokes/touch") {
			let body: { spokeVaultId?: string } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}
			if (typeof body.spokeVaultId !== "string") {
				return json({ error: "missing spokeVaultId" }, 400);
			}

			await this.state.storage.transaction(async (txn) => {
				const spokes = (await txn.get<SpokeEntry[]>(SPOKES_KEY)) ?? [];
				const idx = spokes.findIndex((s) => s.spokeVaultId === body.spokeVaultId);
				if (idx >= 0) {
					spokes[idx]!.lastSeen = new Date().toISOString();
					await txn.put(SPOKES_KEY, spokes);
				}
			});
			return json({ ok: true });
		}

		return json({ error: "not found" }, 404);
	}
}

export default HubRegistry;
