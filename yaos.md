# YAOS Documentation

## Definitions

**Host** — the Cloudflare Worker (server) that all vaults in a sync network connect to. Every vault requires a host to function. The host stores the CRDT state, relays WebSocket connections between devices, and optionally stores attachments in R2. All vaults in the same sync network share the same host URL and sync token.

**Hub** — a vault that shares its notes outward to one or more spoke vaults. The hub's content is pushed to connected spokes in real time. A vault becomes a hub by clicking "Start sharing" in settings or by having a spoke register with it via an invite link.

**Spoke** — a vault that receives shared notes from a hub vault. A spoke connects to a hub using the hub's vault ID. Because hub and spoke must be on the same host, the spoke uses its existing host connection — no separate host URL or token is needed during spoke registration.

**Vault ID** — a randomly generated 16-byte base64url string that uniquely identifies a vault's CRDT room on the host. All devices syncing the same vault must use the same vault ID.

**Sync token** — the shared secret (password) for the Cloudflare Worker. Worker-global: every vault connecting to the same host uses the same token. Set as `SYNC_TOKEN` on the server, or generated during the browser claim flow.

## Sync modes (`syncMode`)

| Value | Meaning |
|-------|---------|
| `standalone` | Default. Connected to a host but neither sharing notes nor following a hub. |
| `hub` | Sharing notes outward. Connected spokes receive this vault's content. |
| `spoke` | Following a hub. Receives shared content from the hub vault. |
| `hub+spoke` | Both simultaneously — sharing notes to spokes while also following a hub. |

## Invite URL format

```
obsidian://yaos?action=spoke&host=HOST_URL&hubVaultId=VAULT_ID&token=TOKEN
```

- `host` and `token` are only applied if the receiving vault has no server connection yet (bootstrap case). If already connected to the same host, the existing connection is reused.
- A spoke must be on the same host as its hub. Cross-host hub/spoke relationships are not supported.

## Constraints

- A vault can only act as a Hub for **one vault instance**. A single vault cannot simultaneously host multiple independent sync groups.
- Hub and spoke must share the same Cloudflare Worker (host). The invite URL carries the host URL and token for first-time setup only.
- Vault size target: ~50 MB (see `engineering/warts-and-limits.md` for canonical limits).
