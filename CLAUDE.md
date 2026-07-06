# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Lodestone is a self-hosted, zero-terminal Obsidian sync plugin backed by a Cloudflare Worker. It uses Yjs CRDTs to eliminate merge conflicts across devices. The repo contains two deployable units:

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

### Creating a GitHub Release (tag-driven — the ONLY release path)

Do **not** run `gh release create` manually — a hand-made release skips
`release.yml` and omits `lodestone-server.zip` + `update-manifest.json`, which
breaks the zero-terminal server auto-update for that version. Pushing the tag is
what creates the release:

```bash
git tag X.Y.Z
git push origin X.Y.Z
# release.yml builds, tests, verifies tag == manifest version, and publishes:
# lodestone.zip, lodestone-server.zip, update-manifest.json, main.js, manifest.json, styles.css
```

Wait for the workflow to go green (`gh run watch` or poll `gh run list`), then
verify assets with `gh release view X.Y.Z`.

### Patch notes (REQUIRED for every release)

The workflow creates the release with auto-generated commit lists — always
replace those with **human-readable patch notes** once the workflow completes:

```bash
cat > /tmp/lodestone-X.Y.Z-notes.md << 'EOF'
## What's changed
<user-facing summary: what broke, what's fixed, what's new — written for a
plugin user, not a contributor. Group as "Fixed" / "Added" / "Changed".>

## Upgrade notes
<anything the user must DO: server redeploy required? leave/rejoin a room?
re-pair a device? If nothing, say "None — plugin update only.">
EOF

gh release edit X.Y.Z --notes-file /tmp/lodestone-X.Y.Z-notes.md
rm /tmp/lodestone-X.Y.Z-notes.md
```

Guidelines: lead with the most user-visible change; name symptoms the user may
have hit ("notes duplicated after a rename") rather than internal mechanisms;
always state whether a **server redeploy** is needed.

### Release after every commit

**After every feature or bugfix commit, bump the version and create a GitHub release** so the changes can be tested in Obsidian immediately:

1. Bump patch (X.Y.**Z+1**) for bugfixes, minor (X.**Y+1**.0) for new features
2. Edit `package.json`, `manifest.json`, `versions.json`
3. `git add package.json manifest.json versions.json && git commit -m "X.Y.Z"`
4. `git push origin main`
5. `git tag X.Y.Z && git push origin X.Y.Z` — release.yml does the rest
6. After the workflow is green: **write patch notes** (see above)

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
- `hubRegistry.ts` (`HubRegistry` DO, `LODESTONE_HUB` binding) — stores spoke registrations per hub vault
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

## lodestone.md — one-page documentation

`lodestone.md` is the canonical single-page reference for Lodestone. Keep it up to date as the plugin evolves. Add entries for:

- New terminology or redefined terms (e.g., when "host" vs "hub" distinction was formalized)
- New sync modes or topology changes
- New URL formats or protocol changes (invite links, deep links, obsidian:// actions)
- Constraints that are non-obvious from the code — limits, unsupported topologies, required conditions
- Settings fields that have non-trivial semantics worth documenting

Do **not** add ephemeral details (current bug status, in-progress work, version-specific notes). The file is meant to be a durable reference that survives cleanup.

## Engineering docs

Deep design rationale lives in `engineering/`. Key reads before touching a subsystem:
- `monolith.md` — why one Y.Doc per vault
- `filesystem-bridge.md` — how noisy Obsidian FS events are safely funneled into CRDT writes
- `checkpoint-journal.md` — server-side persistence model
- `do-hardening-rfc.md` / `do-hardening-implementation.md` — Durable Object safety invariants
- `frontmatter-integrity-rfc.md` — frontmatter validation design
- `warts-and-limits.md` — canonical known constraints
