# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

YAOS is a self-hosted, zero-terminal Obsidian sync plugin backed by a Cloudflare Worker. It uses Yjs CRDTs to eliminate merge conflicts across devices. The repo contains two deployable units:

- **Plugin** (`src/`) — TypeScript compiled to `main.js` and loaded by Obsidian
- **Server** (`server/`) — Cloudflare Worker with Durable Objects, deployed via Wrangler

## Commands

### Plugin (root)

```bash
npm install
npm run dev              # Watch mode (esbuild)
npm run build            # Type-check + production bundle
npm run lint             # ESLint across src/ and server/src/
```

### Tests

```bash
npm run test:regressions          # All unit/regression suites (15+ files via jiti)
npm run test:integration:worker   # Worker integration (requires local wrangler dev)
npm run test:e2e:obsidian         # End-to-end via WebdriverIO
npm run test:ci                   # regressions + integration (what CI runs)
```

To run a single regression file:
```bash
node --import jiti/register tests/frontmatter-guard-regressions.mjs
node --import jiti/register tests/chunked-doc-store.ts
node tests/disk-mirror-regressions.mjs   # plain .mjs files don't need jiti
```

### Server (`server/`)

```bash
npm run dev       # Local dev server at http://localhost:8787 (wrangler)
npm run deploy    # Deploy to Cloudflare Workers
npm typecheck     # Type-check only
```

### Versioning

Do **not** use `npm version` — it auto-commits and is blocked by the harness. Do it manually with git:

```bash
# 1. Edit the version string in three files:
#    package.json        → "version": "X.Y.Z"
#    manifest.json       → "version": "X.Y.Z"
#    versions.json       → add "X.Y.Z": "1.5.0"   (append to end of object)

# 2. Commit the version bump
git add package.json manifest.json versions.json
git commit -m "X.Y.Z"

# 3. Push
git push origin main
```

### Creating a GitHub Release

After pushing, build the artifacts and create the release with `gh`:

```bash
# Build production artifacts
npm run build

# Create GitHub release and attach artifacts
gh release create X.Y.Z \
  --title "X.Y.Z" \
  --notes "Brief description of changes." \
  main.js manifest.json styles.css
```

Release artifacts: `main.js`, `manifest.json`, `styles.css`.

## Architecture

### Sync model

One `Y.Doc` per vault ("monolithic vault CRDT"). All file contents are sub-documents of that single shared doc, so cross-file operations are transactional. Attachments are handled separately via content-addressed R2 blob storage.

### Plugin sync pipeline (`src/sync/`)

| File | Role |
|------|------|
| `vaultSync.ts` | Top-level orchestrator — manages CRDT connection, brings disk and CRDT into agreement |
| `diskMirror.ts` | Drains a dirty-set of disk events into CRDT writes; suppresses echo events on the way back |
| `editorBinding.ts` | Binds a live CodeMirror 6 editor buffer to a `Y.Text` via `y-codemirror.next` |
| `blobSync.ts` | Upload/download attachments to R2 with bounded concurrency |
| `frontmatterGuard.ts` | Validates YAML frontmatter state transitions before applying CRDT updates |
| `externalEditPolicy.ts` | Decides whether to ingest edits from git/CLI ("always" / "closed-only" / "never") |
| `snapshotClient.ts` | Daily and on-demand gzipped snapshots to R2; selective restore |
| `exclude.ts` | Path exclusion patterns (glob-based) |

### Server (`server/src/`)

- One Durable Object (`VaultSyncServer`) per vault — persistent WebSocket relay via `y-partyserver`
- Persistence: **checkpoint** (full CRDT snapshot, infrequent) + **journal** (state-vector-anchored deltas, frequent) — see `chunkedDocStore.ts`
- R2 used for blob storage and snapshot archives
- Auth: setup token (one-time claim via browser UI) or `SYNC_TOKEN` env var
- `setupPage.ts` renders the browser claim UI; deep-links back via `obsidian://` protocol
- `hubRegistry.ts` (`HubRegistry` DO, `YAOS_HUB` binding) — stores spoke registrations per hub vault
- `syncBridge.ts` — DO-to-DO propagation functions for hub→spoke and spoke→hub cross-vault sync

### Data flow

```
Obsidian file event
  → diskMirror (debounce/suppress)
  → vaultSync (apply to Y.Doc)
  → y-partyserver WebSocket
  → Durable Object (chunkedDocStore: journal append)
  → broadcast to other clients
  → editorBinding (live editor) or diskMirror (closed file)
```

## Key constraints

- Vault size target: ~50 MB (see `engineering/warts-and-limits.md` for canonical limits)
- `main.ts` is intentionally minimal — lifecycle only; all feature logic is in `src/sync/` and `src/utils/`
- All Obsidian and CodeMirror 6 libraries are **externalized** by esbuild (not bundled); they are provided by Obsidian at runtime
- Mobile compatibility is required (`isDesktopOnly: false`) — avoid Node/Electron APIs in plugin code
- Use `this.registerEvent`, `this.registerDomEvent`, `this.registerInterval` for all listeners so they're cleaned up on unload

## Engineering docs

Deep design rationale lives in `engineering/`. Key reads before touching a subsystem:
- `monolith.md` — why one Y.Doc per vault
- `filesystem-bridge.md` — how noisy Obsidian FS events are safely funneled into CRDT writes
- `checkpoint-journal.md` — server-side persistence model
- `do-hardening-rfc.md` / `do-hardening-implementation.md` — Durable Object safety invariants
- `frontmatter-integrity-rfc.md` — frontmatter validation design
- `warts-and-limits.md` — canonical known constraints
