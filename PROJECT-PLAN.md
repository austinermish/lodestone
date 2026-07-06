# Lodestone Project Plan

> Output of a full codebase review (July 2026, at v2.6.1). This is the execution
> plan for (1) fixing everything the review found, (2) renaming YAOS → **Lodestone**,
> (3) overhauling onboarding/UX, and (4) dependency hygiene.
>
> Written for execution by Claude (Sonnet/Opus) in later sessions. Each item has
> file:line anchors (valid as of v2.6.1 — re-verify before editing) and a concrete
> fix direction. Work top-to-bottom by phase; phases 1–2 ship before the rename so
> critical fixes aren't blocked on churn.
>
> Per CLAUDE.md: after every feature/bugfix commit, bump the version and cut a
> GitHub release — but see Phase 9 first, which changes the release process to
> tag-driven only.

---

## Phase 1 — Critical data-loss & correctness fixes (plugin core)

Ship these as one or two patch releases before anything else.

### 1.1 `migrateSchemaToV2` aborts mid-transaction *(one-word fix — do first)*
- **Where:** `src/sync/vaultSync.ts:563-575`
- **Bug:** `return` inside the arrow function passed to `ydoc.transact()` exits the
  entire migration when a `pathToId` entry lacks meta. Partial writes commit;
  tombstone conversion, loser-path tombstones, and `sys.set("schemaVersion", 2)`
  are all skipped. Migration limps forward one created meta per invocation.
- **Fix:** change `return` → `continue`. Add a regression test: legacy doc with one
  missing meta entry must fully migrate and set schemaVersion 2 in one pass.

### 1.2 Remote delete/rename bypass the per-path write lock → permanent ghost files
- **Where:** `src/sync/diskMirror.ts:546` (`handleRemoteDelete`), `:594`
  (`handleRemoteRename`) vs `runPathWriteLocked` at `:955`
- **Bug:** only `flushWrite` uses the lock. Sequence: remote edit schedules a write →
  flush in flight → remote tombstone arrives → `handleRemoteDelete` deletes the disk
  file → flush resumes, sees no file, **recreates it**. CRDT path is tombstoned so
  `reconcileVault` skips it forever (`vaultSync.ts:829-832`) — ghost file that never heals.
- **Fix:** route the disk ops in `handleRemoteDelete`/`handleRemoteRename` through
  `runPathWriteLocked(path, …)`; in `flushWriteUnlocked`, re-check tombstone state
  after acquiring the lock and abort the write if tombstoned.
- **Note:** this violates the documented invariant in `engineering/filesystem-bridge.md`
  ("one path, one active write chain") — update the doc if semantics change.

### 1.3 v2 orphan GC destroys the losing side of path collisions
- **Where:** `src/sync/vaultSync.ts:711-758` (GC) with `:466-482` (collision resolution)
- **Bug:** `ensurePathIndexes` picks a collision winner; `runIntegrityChecks` computes
  `referencedIds` from `_pathIndex.values()` only, so the loser's meta **and Y.Text
  are deleted**. Two devices creating the same path offline → one side's content
  permanently discarded. The v1 branch (`:664-709`) cloned duplicates instead.
- **Fix:** before GC-ing a collision loser, write its content to a conflict-copy path
  (e.g. `Name (conflict from <device>).md`), matching v1 behavior. Reserve pure GC
  for texts with no meta at all. Regression test: concurrent-create merge must
  preserve both contents.

### 1.4 Remote blob delete permanently destroys local attachments
- **Where:** `src/sync/blobSync.ts:1026`
- **Fix:** replace `this.app.vault.delete(file)` with `this.app.fileManager.trashFile(file)`
  (respects user trash preference; also Obsidian plugin-guideline behavior). Audit
  diskMirror for the same pattern on markdown deletes.

### 1.5 Editor can seed a file's Y.Text with the *previous* file's content
- **Where:** `src/sync/editorBinding.ts:1093-1100`
- **Bug:** leaf-reuse guard only covers `file.stat.size === 0`; a non-empty untracked
  file opened via a reused leaf can be seeded with the prior file's `getValue()` and
  propagate everywhere.
- **Fix:** before seeding, validate `getValue().length` against `file.stat.size`
  (allow encoding slack, e.g. ±10% + 64 bytes); on mismatch, seed from an async
  `vault.read` instead.

### 1.6 `destroy()` drops a pending rename batch → duplicate notes
- **Where:** `src/sync/vaultSync.ts:1447-1455`
- **Fix:** call `flushRenameBatch()` synchronously at the top of `destroy()` instead
  of `clearPendingRenames()`.

### 1.7 Pre-restore snapshot backups always fail silently
- **Where:** `src/main.ts:5089-5111`
- **Bug:** backups use `vault.create`/`createFolder` into `configDir/plugins/...` —
  the Vault API can't write hidden paths; per-file catch logs "Backup skipped" and
  the destructive restore proceeds with no backup.
- **Fix:** use `vault.adapter.mkdir` + `adapter.write` (the diagnostics exporter at
  `main.ts:4680` already does this correctly). If backup fails, warn and require
  explicit confirmation before restoring.

### 1.8 Nuclear reset trusts a 500 ms sleep
- **Where:** `src/main.ts:2000-2001`
- **Fix:** replace `sleep(500)` with an explicit flush/ack — wait for provider
  `synced` after `clearAllMaps()`, with a timeout that aborts the reset and warns
  ("Reset could not reach the server — aborting to avoid a partial reset").

### 1.9 Same-size offline attachment edits never sync
- **Where:** `src/sync/blobSync.ts:554-561`; compounded by `src/sync/blobHashCache.ts:35`
  (exact mtime+size trust — FAT mtime granularity)
- **Fix:** during authoritative reconcile, hash size-matching files that have no
  hash-cache entry (bounded by existing concurrency limiter). One-time cost that
  populates the cache.

### 1.10 Frontmatter guard calibration
- **Where:** `src/sync/frontmatterGuard.ts:78-85` (growth-burst false positive) and
  `:53-60` (deletion false negative)
- **Fix:** (a) downgrade `frontmatter-growth-burst` from block → warn when the new
  frontmatter parses as clean YAML with no duplicate keys (parse already happens);
  keep block for growth + structural anomaly. (b) When `next.kind === "none"` and
  previous frontmatter was large, return `warn` (not `ok`) recording the length delta.
  Update `tests/frontmatter-guard-regressions.mjs` accordingly.

---

## Phase 2 — Server security & hardening

### 2.1 Spoke seeding silently fails for hub docs over ~100 KB
- **Where:** `server/src/index.ts:588-604`
- **Bug:** `btoa(String.fromCharCode(...hubDocBytes))` throws `RangeError` (V8 arg
  limit) above ~100 KB; the surrounding `try` swallows it, registration returns
  `ok: true` with `initialStateUpdate: null`, and the DO-to-DO seed push at 595-600
  never runs. Hub→spoke initial sync silently does nothing on real vaults.
- **Fix:** move the `spokeStub.fetch` seed push *before* any base64 encoding; chunk
  the base64 encode in ≤8 KB slices if the inline payload is kept at all (prefer
  dropping it and relying solely on the DO-to-DO push). Add a regression test with a
  >200 KB hub doc.

### 2.2 Unauthenticated requests wake/write arbitrary DOs
- **Where:** `server/src/index.ts:776-794, 909-929` (`recordVaultTrace` on rejection paths)
- **Attack:** loop over `/vault/<random>/...` with no token → unbounded DO creation,
  full hydration (see 2.3), and storage writes on the owner's bill; against a known
  vaultId, floods the 200-entry trace ring and evicts real diagnostics.
- **Fix:** only record vault traces after successful auth. If rejection telemetry is
  wanted, write to a single fixed-name diagnostics DO with rate limiting.

### 2.3 Hardening invariant #4 regressed: cheap routes hydrate the full doc
- **Where:** `server/src/server.ts:106-109` (`onLoad` → `ensureDocumentLoaded`);
  partyserver calls `onStart` before routing `onRequest`
- **Fix:** handle `/__yaos/trace`, `/__yaos/debug`, `/__yaos/meta` inside the
  existing `fetch()` override (`server.ts:133`) *before* `super.fetch(request)`.
  Re-verify against `engineering/do-hardening-implementation.md` §4 and update the doc.

### 2.4 Validate `vaultId` at the router
- **Where:** `server/src/index.ts:125, 137`
- **Fix:** reject unless `^[A-Za-z0-9_-]{8,64}$` (400). Also wrap
  `decodeURIComponent` (malformed percent-encoding currently throws an unhandled 500).
  Prevents `/`-bearing vaultIds from reaching R2 key construction.

### 2.5 Constant-time env-token comparison
- **Where:** `server/src/index.ts:270-271`
- **Fix:** hash the presented token and compare SHA-256 digests, same code path claim
  mode already uses.

### 2.6 Token in WS query string + observability logs
- **Where:** `server/src/index.ts:104-108`; `server/wrangler.toml:25-26`
- **Fix (near-term):** redact `?token=` from any URL that reaches logging/trace paths.
  **Proper fix:** move WS auth to the `Sec-WebSocket-Protocol` header. Coordinate
  with the plugin's provider connection code.

### 2.7 Setup page loads QR lib from CDN with no SRI/CSP
- **Where:** `server/src/setupPage.ts:399` (script tag), token handling at `:505-530`
- **Fix:** inline a small QR generator into the served HTML (the plugin already
  bundles the `qrcode` npm package — reuse or vendor a minimal encoder into the
  worker bundle at build time). Add a restrictive CSP header on setup pages either way.
  This also fixes the silent-QR-failure UX issue (Phase 7.4).

### 2.8 DO-to-DO apply paths can drop a journal delta range
- **Where:** `server/src/server.ts:281-293, 324-337, 407-433`
- **Bug:** `apply-spoke-update`/`apply-hub-update` compute persisted delta from
  `svBefore` and advance `lastSavedStateVector` to `svAfter`; a failed/pending prior
  save leaves the range `lastSavedStateVector → svBefore` never journaled. DO
  eviction before next compaction loses broadcast-but-unpersisted data.
- **Fix:** inside the save chain, compute the delta relative to
  `this.lastSavedStateVector` at write time, not the captured `svBefore`.

### 2.9 Pin the reusable ops workflow
- **Where:** `buildGithubOpsBootstrapWorkflowYaml` in `src/main.ts:124-197`
  (generates `uses: austinermish/yaos/.github/workflows/yaos-ops-reusable.yml@main`
  with `contents: write`)
- **Fix:** pin to a release tag (bump the generated YAML on each release via the
  release workflow) or a commit SHA. Rename target repo path during Phase 3.

### 2.10 Update-action URL validation (phishing surface)
- **Where:** `src/main.ts:4088` (`inferUpdateProvider` uses `hostname.includes("github.")`),
  `:4179`, opened at `src/settings.ts:987`
- **Fix:** require `https:` and exact-host match (`github.com`, `gitlab.com`, or a
  user-confirmed custom host); show the URL in the confirm before opening. Note
  `hydrateUpdateMetadataFromCapabilities` (`main.ts:3941`) silently persists the
  server-supplied repo URL — gate that behind the same validation.

---

## Phase 3 — Rename: YAOS → Lodestone

> **STATUS: EXECUTED 2026-07-06** (ahead of schedule, on the `project-plan-lodestone`
> branch, as v3.0.0). Austin confirmed no live installs existed, so the data.json
> migration shim (3.1) and all legacy-compatibility windows (dual protocol actions,
> dual route prefixes, old binding names) were **intentionally skipped** — this was
> a clean-break rename: plugin id `lodestone`, `obsidian://lodestone`,
> `/__lodestone/*` routes, `LODESTONE_*` bindings, `lodestone-server.zip`,
> workflow files renamed. The GitHub repo was renamed to `austinermish/lodestone`
> (old URLs redirect). Sections below are retained for reference; treat 3.1's shim
> as NOT needed unless supporting pre-3.0 installs ever becomes a goal.

**Decision made: the new name is Lodestone.** Do this after Phases 1–2 ship, before
the large refactors (so the refactors land under the new name without double churn).

Fork provenance: the upstream base was a ~100-line scaffold (initial commit
`3e23c65`); 268 commits / ~18k lines since are original work and LICENSE is already
in Austin's name. No attribution obstacle; optionally keep a one-line "originally
scaffolded from Kavinsood's yaos" credit in README.

### 3.1 The critical constraint: plugin ID migration
Changing `manifest.json` `id` (`yaos` → `lodestone`) makes Obsidian treat it as a
**brand-new plugin**: `.obsidian/plugins/lodestone/` starts empty — no `data.json`,
meaning no token, host, vault ID, disk index, or blob queue on every device.

**Required migration shim** (in `onload`, before `loadSettings`):
1. If own `data.json` is absent/empty AND `configDir/plugins/yaos/data.json` exists
   (check via `vault.adapter.exists`), read it with `adapter.read`, write it as own
   `data.json`, and show a one-time notice ("Settings migrated from YAOS").
2. Do NOT delete the old plugin dir automatically; tell the user to uninstall YAOS.
3. Keep the shim for several releases; document removal criteria.

### 3.2 Rename inventory
- `manifest.json`: `id: lodestone`, `name: Lodestone`
- `package.json` (root + `server/`): name fields
- ~119 `yaos`/`YAOS` references across `src/` and `server/src/`, including:
  - `obsidian://yaos` protocol action(s) in `main.ts` — register **both**
    `lodestone` and legacy `yaos` actions for a deprecation window (old QR codes,
    bookmarked setup links, and already-deployed servers emit `obsidian://yaos`).
  - Server route prefixes `/__yaos/*` — support both prefixes for one server
    release cycle; plugin should prefer the new one and fall back.
  - `YAOS_BUCKET` / `YAOS_HUB` bindings in `wrangler.toml` — **keep the old binding
    names** or existing deployments break on redeploy; if renaming, accept both in
    `env` lookups (`config.ts`) permanently.
  - Trace/log dir `.obsidian/plugins/yaos/logs/` → follows the plugin dir automatically.
- `.github/workflows/yaos-ops-reusable.yml` → `lodestone-ops-reusable.yml`; keep the
  old filename as a thin wrapper calling the new one (self-hosters' generated
  workflows reference it `@main` — see 2.9).
- Release artifacts: `yaos-server.zip` → `lodestone-server.zip`; the plugin's server
  auto-update flow and `update-manifest.json` must agree — update
  `src/update/updateManifest.ts` URL and `build-server-release.mjs` together.
- Repo rename `austinermish/yaos` → `austinermish/lodestone` (GitHub redirects old
  URLs, including raw content and `gh release` asset URLs — verify updateManifest's
  hardcoded URL still resolves, then update it).
- Docs: `yaos.md` → `lodestone.md`, README, CLAUDE.md, engineering/*.md references,
  setup page copy/branding in `setupPage.ts`, settings tab headings, BRAT slug docs.
- CSS classes in `styles.css` (`yaos-*` → `lodestone-*`) and their usages.
- **Naming collision note:** avoid any confusion with "Relay" (existing Yjs Obsidian
  collab plugin) in marketing copy. "Lodestone" has no known Obsidian plugin collision
  as of July 2026 — re-verify against the community plugin registry before submission.

### 3.3 Rename release
- Ship as a **minor** version bump with prominent release notes covering: install
  the new plugin, migration shim behavior, uninstall old plugin, server redeploy
  guidance (bindings unchanged).

---

## Phase 4 — Rooms (hub/spoke) privacy & correctness

The rooms feature has the highest defect density (consistent with 2.5.x history).
Treat 4.1–4.2 as security work.

### 4.1 `buildFilteredUpdate` pass-through → cross-vault content leak
- **Where:** `server/src/server.ts:607-615`; fan-out at `:299-308, 575-583`
- **Bug:** `_knownPaths` is ignored; body edits to spoke-private files (pre-existing
  in the spoke, so never structurally rejected) merge into the hub doc as orphan
  structs and fan out to every other spoke — recoverable from any spoke's document
  endpoint. Also unbounded hub-doc growth.
- **Fix:** implement real path filtering: decode the update, drop ops targeting
  Y.Text instances whose fileId is not in the room's known-path set, re-encode.
  Until implemented, document loudly (yaos.md/lodestone.md + room UI) that spoke
  content is not isolated.

### 4.2 Room invites embed the vault-wide server token
- **Where:** `src/settings.ts:717-729` (`buildRoomInviteUrl`); rooms reuse
  `settings.token` (`main.ts:3394-3404`); also `/hub/{id}/invite` reflects the env
  token (`server/src/index.ts:883-889`)
- **Fix (proper):** server-minted, room-scoped tokens — a `/pair` or
  `/room/{id}/token` endpoint issuing scoped credentials; auth middleware accepts
  either the master token or a room token scoped to that room's DO + blobs.
  This same mechanism serves onboarding items 7.10/7.12.
- **Fix (interim):** bold warning in the invite modal that the link grants
  full-server access.

### 4.3 Structural-rejection revert loop
- **Where:** `server/src/server.ts:257-266, 559-571, 687-731`
- **Risk:** slow save chain → spoke's debounced `onSave` echoes hub-originated
  structural changes → hub rejects → `revertRejectedStructuralChange` soft-deletes a
  hub-created file → revert generates a fresh structural delta → livelock.
- **Fix:** track the state vector of the last cross-vault apply and exclude that
  range from propagation. **First write the regression test**: delay `appendUpdate`
  and assert the echoed hub delta is never re-proposed.

### 4.4 `setVaultMode` fire-and-forget at registration
- **Where:** `server/src/index.ts:581-583`
- **Fix:** await it; fail registration loudly if the mode write fails.

### 4.5 Per-update full-document clone in the spoke gate
- **Where:** `server/src/server.ts:631-670` (`extractStructuralKeys`)
- **Fix:** cache one probe doc per burst, or inspect the update's target parents via
  `Y.decodeUpdate` instead of full replay. Matters at the 50 MB vault target.

### 4.6a Per-room server credentials / multi-server topology *(added 2026-07-06 from live testing)*
- **Today**: rooms are pinned to the vault's single connection (`settings.host`/`token`).
  A vault with no connection that joins a room **adopts the inviter's server as its
  own vault sync server** (whole vault syncs there, not just the shared folder) —
  now gated behind an explicit ConfirmModal in `handleRoomJoinParams`. A vault whose
  connection differs from the invite's host cannot join at all (join now aborts with
  an honest notice; previously it silently "joined" a nonexistent room on the wrong
  server).
- **DECIDED (Austin, 2026-07-06): each hub runs its own worker.** Every hub↔spokes
  relationship is fully independent — a spoke that becomes a hub deploys its own
  worker for its own room; that instance is completely separate from the room it
  spokes into. Implementation: store `host`/`token` per room in `RoomConfig`, route
  each room's VaultSync/DiskMirror/blob traffic to its room's server, and keep the
  Connection section strictly for the vault's own device sync. Depends on
  room-scoped tokens (4.2) to avoid handing every spoke the master token of every
  server in the chain.
- **Status note**: seeding bug 2.1 was FIXED in 3.0.3 (chunked base64 + seed push
  moved ahead of the encode) — spokes now receive existing hub files at
  registration, not just new deltas. Existing broken rooms heal by leaving and
  rejoining after the server update.

### 4.6 Room sync regression tests
- No tests reference the 2.5.8/2.5.9 room fixes. Add a `tests/room-sync-*` suite
  covering: seeding (incl. >200 KB docs, per 2.1), echo suppression, structural
  rejection/revert, spoke-private content isolation (per 4.1), ghost-file scenarios
  from the 2.5.x fix log.

---

## Phase 5 — Robustness & performance

### 5.1 Editor extensions accumulate across sync restarts
- **Where:** `src/main.ts:548` and `:3425` (rooms); `teardownSync` at `:1689` never
  unregisters
- **Fix:** register one stable CM6 `Compartment` per slot at `onload`; on restart,
  reconfigure contents and call `app.workspace.updateOptions()`. Every
  `restartSync`/reset/room-update currently leaks an extension.

### 5.2 Full-vault read on every reconnect
- **Where:** `src/main.ts:1013-1015` + `src/sync/vaultSync.ts:786-864`
- **Fix:** in authoritative mode, use `filterChangedFiles`/`diskIndex` for the disk
  side; only read stat-changed files plus paths whose Y.Text changed since the last
  reconciled state. Critical for mobile on flappy networks.

### 5.3 O(n·m) reverse text lookups on large remote transactions
- **Where:** `src/sync/diskMirror.ts:179-227` (`findFileIdForText` fallback scan,
  unmemoized)
- **Fix:** memoize fallback hits into the WeakMap, or build one reverse map per
  transaction when `txn.changed` is large.

### 5.4 Awareness-GC alarm defeats DO hibernation
- **Where:** `server/src/server.ts:37, 78-80, 166-172`
- **Fix:** stop rescheduling when awareness states ⊆ live-connection-controlled IDs;
  otherwise lengthen the interval substantially. Currently every connected vault
  wakes (and bills) its DO every 30 s forever.

### 5.5 Journal compaction write-amplification
- **Where:** `server/src/server.ts:41-42, 411-418`
- **Fix:** scale thresholds with checkpoint size — compact when journal bytes >
  max(1 MB, ~10% of checkpoint) rather than fixed 50 entries / 1 MB.

### 5.6 Smaller items
- Delete-suppression entries never expire (`diskMirror.ts:891-895`): verify file
  absence when consuming, or add a generation counter — a lingering entry swallows a
  later genuine user delete.
- `notifyFileOpened` drops the forced-write flag (`diskMirror.ts:237-241`).
- Unbounded concurrency for remote renames (`diskMirror.ts:153-156`): bound like
  `MAX_CONCURRENT_WRITES`.
- `queueRename` source-reuse can lose a rename within one 50 ms batch
  (`vaultSync.ts:1457-1475`) — add regression test.
- `initSync` overlap: add an epoch/generation token checked after each `await`; bail
  if stale (`main.ts` initSync + `restartSync`/`handleRoomJoinParams`/`handleSetupLink`).
- Untitled-rename `setTimeout` survives teardown (`main.ts:2167-2171`) — track/clear it.
- Blob-queue persistence rewrites all of `data.json` every 3 s during transfers
  (`main.ts:600-607`) — dirty-flag or lengthen.
- Delete dead-and-dangerous `heal()` (`src/sync/editorBinding.ts:294-320`); its
  origin string isn't in `LOCAL_STRING_ORIGINS`.
- Invert `isLocalOrigin` default-remote allow-list (`diskMirror.ts:46-52`) into a
  shared origin registry in `types.ts` so novel origins fail safe.
- Case-insensitive filesystem collisions (`Foo.md` vs `foo.md` → content ping-pong):
  add case-folded collision detection in `ensurePathIndexes` on macOS/Windows.
- Offline deletes resurrect on next start (design gap): `diskIndex` knows the path
  existed and is now absent — propagate a delete instead of recreating. If accepted
  as a wart instead, document in `engineering/warts-and-limits.md`.
- `loadSettings` migration force-enables attachment sync over a possible explicit
  user opt-out (`main.ts:3246-3252`) — only flip when the old toggle was never set.
- Snapshot retention: no pruning, and `getSnapshotPayload` lists all snapshots to
  resolve one ID (`server/src/snapshot.ts:92-173`). Add retention policy + direct key lookup.
- R2 blob GC does not exist (no `bucket.delete` in `server/src`) — document in
  warts-and-limits.md now; when GC is added, the dedup path (`blobSync.ts:690-704`)
  becomes a dangling-reference hazard — design refcounting first.
- `transferStatus` counters can show "↑3/2" (`blobSync.ts:1078-1095`) — cosmetic.

---

## Phase 6 — main.ts decomposition

`src/main.ts` is 5,532 lines; CLAUDE.md claims "intentionally minimal — lifecycle
only". Extract in this order (each step: move, wire, run `npm run build` +
`npm run test:regressions`, commit):

1. `src/ui/modals.ts` — ConfirmModal, SnapshotListModal, SnapshotDiffModal
   (lines ~5227-5532, ~310 LOC, zero coupling — warm-up).
2. `src/sync/roomManager.ts` — rooms Maps, create/join/leave/update/seed, invite
   parsing, `getRoomSyncAndCrdtPath`/`isRoomManagedPath`/`getBindingManagerForFile`
   (lines ~3349-3658 plus alias logic ~199-412; ~600 LOC). **Highest value** — room
   logic is currently smeared across reconciliation, vault events, and binding
   routing, which is plausibly why rooms keep sprouting bugs.
3. `src/update/updateService.ts` — capabilities refresh, compatibility guard,
   manifest refresh, notices, update state/URL builders, metadata push, ops-workflow
   YAML (lines ~3753-4283 + 124-197; ~900 LOC).
4. `src/sync/reconciler.ts` — `runReconciliation`, `importUntrackedFiles`, safety
   brake, disk-index updates (lines ~950-1268; ~380 LOC).
5. `src/sync/markdownIngest.ts` — dirty-set drain, `processDirtyMarkdownPath`,
   `syncFileFromDisk`, `handleBoundFileSyncGap`, frontmatter-guard glue
   (lines ~2090-2800; ~700 LOC).
6. `src/debug/diagnostics.ts` — trace snapshot builders, `exportDiagnostics`,
   `buildDebugInfo`, VFS torture test (lines ~2920-3216 + 4478-4975; ~800 LOC).
7. `src/sync/snapshotFlows.ts` — daily trigger, list/diff/restore orchestration
   (lines ~4977-5160; ~200 LOC).
8. `src/sync/connectionLifecycle.ts` — reconnect, visibility/network handlers, fast
   reconnect, status computation (lines ~753-948 + 2802-2918; ~350 LOC).

Target: main.ts at ~800-1,000 lines of genuine lifecycle + wiring. Then update
CLAUDE.md's description to match reality.

---

## Phase 7 — Onboarding, settings & UX

Context from the onboarding walkthrough: "zero-terminal" holds (no shell required),
but zero→two-devices-syncing is **~24 discrete user actions** across four surfaces
(Cloudflare deploy, dashboard, browser claim page, BRAT in Obsidian), +5 more for R2
attachments. The claim-page → deep-link → auto-configure spine is well designed;
the two biggest drop-off fixes are 7.1 and 4.2.

### Flow fixes (highest impact)

**7.1 Wire up the dead `PairDeviceModal`** — `src/settings.ts:183-287` and
`buildMobileSetupUrl()` (`src/main.ts:3319`) have **zero callers**. The claim page
QR is the only QR in the product and only exists pre-claim; pairing a phone later
means hand-typing host + 64-hex token + vault ID. Fix: add a "Pair another device"
button on the Connected status card that opens `PairDeviceModal` with
`buildMobileSetupUrl()`. ~One-day fix that rescues the mobile story.

**7.2 HTTPS trampoline for room invites** — `obsidian://…` links don't linkify in
Slack/Discord/iMessage. Reuse the `/mobile-setup#…` trampoline pattern: serve
`https://<host>/room-join#…` from the worker. (Token scoping per 4.2.)

**7.3 Mobile-setup page scrubs the token too early** — `setupPage.ts:697` runs
`history.replaceState` on load; a refresh after app-switching to install the plugin
permanently loses the token. Defer the scrub until after "Connect" is tapped, or
stash in `sessionStorage`.

**7.4 QR generation fails silently** — `renderQr()` (`setupPage.ts:439-452`) returns
silently if the CDN script didn't load; user sees an empty box. Fixed structurally
by inlining the QR lib (2.7); add a copyable-URL fallback regardless.

**7.5 First-run guided setup** — today: a vanishing `Notice` (`main.ts:473`) then a
wall of settings. Add a one-time setup modal with three states: no server → Deploy
button; deployed → paste Worker URL; claimed → use setup link. The settings tab
already has all the pieces; it needs sequencing, not new machinery.

**7.6 R2 setup as first-class flow** — replace the YouTube-link guidance
(`settings.ts:1074-1080`) with an in-plugin copy-paste block (exact `[[r2_buckets]]`
TOML / dashboard binding name `YAOS_BUCKET` — post-rename, keep binding name, see
3.2). Have the worker's running page detect and report "no binding" vs "binding but
bucket missing". Longer term: ship the binding commented-out in `wrangler.toml` or
an "Enable attachments" API-token flow.

**7.7 Commands should register unconditionally** — `registerCommands` only runs
inside `initSync` (`main.ts:627`), so an unconfigured/broken install has zero
commands, including the diagnostics ones you need precisely when setup fails. Move
to `onload` with per-command guards.

### Settings fixes

**7.8 Host/token changes silently don't apply** (`settings.ts:1216-1227`;
`maybeStartSync` no-ops when running) — call a debounced `restartSync()` on change,
and do the same in `handleSetupLink` (`main.ts:4366-4372`) instead of "reload the
plugin".

**7.9 Settings tab re-renders per keystroke, dropping focus**
(`settings.ts:1237-1242, 1265-1270`) — re-render on blur/debounce, or update the
warning element in place.

**7.10 Token field plaintext** (`settings.ts:1261`) — `inputEl.type = "password"`
with reveal toggle; RecoveryKitModal remains the deliberate export path.

**7.11 Vault ID edit needs the same guard as the deep link** (`settings.ts:1137-1148`
vs `confirmVaultIdSwitch` at `main.ts:4285`) — confirm + `restartSync()`. Also add a
one-line notice in the <5-file silent-switch case (`main.ts:4340`).

**7.12 Attachment settings don't apply until engine restart**
(`settings.ts:1101-1129`; captured at construction `main.ts:3663-3677`) — call
`refreshAttachmentSyncRuntime` on change, or say so in the description.

**7.13 Client attachment size cap vs server 10 MiB hard cap** (`settings.ts:91` vs
`server/src/index.ts:26`) — clamp to the server-advertised cap via
`serverCapabilities`; surface permanent upload failures (post-retry 413) as a Notice,
not just console.

**7.14 Add "Test connection" button** next to the manual host/token fields — a bad
host currently just never connects with no feedback.

### Copy fixes (quick wins)

- `already_claimed` surfaces raw (`setupPage.ts:515-517`) → map to actionable copy
  ("This server was already claimed. If that was you, use the setup link from your
  existing device (Settings → Backup connection details). Otherwise redeploy.").
- "Deployment is free and takes about 15 seconds" (`settings.ts:758`) → "a few
  minutes", and disclose that Deploy-to-Cloudflare requires connecting a
  GitHub/GitLab account.
- README: substantiate the "$0" claim — 3 lines on Workers free plan + DO + R2 free
  tier and what happens at the limits. A no-dev user's first fear is a surprise bill.
- "Server misconfigured." (`main.ts:4385`) → say what to check (env token vs claim
  state; link the worker URL).
- "This may create a separate sync room on this device" (`main.ts:4328`) → "your
  devices may not see each other's notes. Re-scan the QR from the setup page."
- `IS_MARKETPLACE_APPROVED` hardcoded `false` (`setupPage.ts:26`) requires every
  self-hoster to redeploy when it flips — drive from the update manifest instead.
- Trace toggle: add "logs may contain note excerpts" warning + retention sweep
  (delete day-dirs older than N days on startup) — trace logs currently grow forever
  and include 160-char note excerpts (`main.ts:3205-3206`).

### Settings tab redesign (follow-up review, 2026-07-04)

**7.15 Add an "Excluded folders" setting — the engine supports it but no UI exists.**
`excludePatterns` is defined and persisted (`settings.ts:46, 85`) and consumed
throughout `main.ts` (`:406, 491, 526, 1208, 3701, 4360`), but `display()` never
renders a field for it — users must hand-edit `data.json`. Add under Sync filters
as a folder-picker with removable chips (not a raw comma-string — also dodges the
comma-in-path parsing limitation in `exclude.ts:53`). Coordinate with Phase 9.3
(glob vs prefix semantics).

**7.16 Host/token editing → explicit "Apply" button** (supersedes the debounce
approach in 7.8/7.9). `renderConnectionFields` (`settings.ts:1229-1273`) saves per
keystroke and re-renders. Replace with: edit fields freely, one "Apply" button that
saves + `restartSync()`. Fixes focus loss, the silent no-op, and half-typed hosts
triggering connection attempts, in one change.

**7.17 Vault ID → read-only row with "Change…" button** behind the same confirm
dialog as the deep-link guard (refines 7.11). Free-text editing of the most
dangerous setting is a trap.

**7.18 Demote deployment repo URL/branch out of Advanced** (`settings.ts:1150-1175`).
They're auto-hydrated from server capabilities and only serve the update flow —
surface them inside the Updates card behind an "edit" affordance. Advanced shrinks
to: external edits policy, frontmatter guard, debug logging.

**7.19 Connected status card additions**: "Pair another device" as the primary CTA
(7.1), "Test connection" (7.14), a server-version row (capabilities are already
fetched), and danger styling on "Reset connection".

**7.20 Rooms section polish**: collapse by default when `rooms.length === 0`
(currently `open: true`, `settings.ts:849`); empty state should explain what a room
is in one sentence before offering "Create".

**7.21 Desktop claim-from-plugin.** On desktop, let the user paste just the Worker
URL; the plugin calls the server's claim endpoint directly and stores the minted
token — no browser round-trip, no deep-link approval, one field instead of three.
The browser claim page remains the mobile/discovery path (it hosts the QR
trampoline). Same one-shot first-come claim semantics; reuse the existing claim
endpoint in `server/src/index.ts`.

**7.22 Post-claim pairing lives in the plugin, not the website.** The running page
(`renderRunningPage`) stays a pure status page; all pairing/QR/recovery affordances
live in settings (`PairDeviceModal` + bundled `qrcode` package renders offline, no
CDN). Add a small "Open server page" link on the status card for diagnostics.

**7.23 One-time "you're synced" success modal.** After the first successful initial
sync, show: "This vault is syncing. Next: pair your phone" with a button opening
`PairDeviceModal`. Device #2 is the highest-stall step; this closes the loop.
Persist a `hasShownFirstSyncSuccess` flag.

**7.24 "Sync health" dialog for persistent failures.** Notices vanish; wrong-token/
unreachable-host are persistent states. Make the status-bar item clickable in error
states → modal with the actual error, plain-language meaning, and the single action
to take (Test connection / open setup). Same surface lists frontmatter-quarantined
files with approve/dismiss actions (quarantine currently has no UI home).

**Explicit non-goal:** no multi-step wizard framework. The three-state welcome modal
(7.5) + button-first Connection section achieves the same without a wizard in a
settings tab.

---

## Phase 8 — Tests

Priority order:
1. **`blobSync.ts` — zero coverage on 1,320 lines.** Cover: drain loop + `needsRerun`
   re-entry, retry/`readyAt` scheduling, suppression windows (incl. the 1 s
   `SUPPRESS_MS` edit-swallow at `blobSync.ts:894, 1050-1060`), queue import/export,
   create-race (`:913-941`), and the Phase 1.9 same-size fix.
2. **Room sync** — see 4.6.
3. **Snapshot restore at schemaVersion 2** — `tests/snapshots.ts` only exercises v1
   (`tests/snapshots.ts:124`); the v2 branches in
   `snapshotClient.ts:109-124, 431, 474-523` (incl. stale-tombstone cleanup) are uncovered.
4. **`exclude.ts` + `isBlobSyncable`/`isMarkdownSyncable`** (`src/types.ts:84-99`) —
   the sync-eligibility choke point has no tests.
5. Regression tests for each Phase 1 fix (1.1, 1.2, 1.3, 1.6 especially) and 5.6's
   `queueRename` batch loss.
6. `blobHashCache.ts` (cheap, alongside #1).
7. Un-ignore `tests/` in `eslint.config.mts` (`globalIgnores`) so test code is linted.

---

## Phase 9 — Build, release & docs hygiene

1. **Kill the release split-brain.** The CLAUDE.md manual `gh release create` flow
   never pushes a tag and omits `yaos-server.zip` + `update-manifest.json` that only
   the tag-triggered `release.yml` produces — manually cut releases **break the
   zero-terminal server auto-update** for that version. Make the documented flow:
   bump three files → commit → push tag → `release.yml` is the only release
   producer. Rewrite the CLAUDE.md release section (also delete the contradictory
   `sudo rm` line).
2. **CI version-consistency check**: `package.json` == `manifest.json` ==
   `versions.json` latest key; fail CI otherwise. Delete vestigial `version-bump.mjs`
   or wire it back in properly.
3. **`exclude.ts` docs vs behavior**: CLAUDE.md says "glob-based"; `exclude.ts:45-50`
   is prefix-only, case-sensitive, comma-separated. Either implement globs (bundle a
   tiny matcher) or fix the docs + settings placeholder and warn on `*` in patterns.
   Consider case-insensitive matching on macOS/Windows.
4. **`yaos.md` (→ `lodestone.md`) fixes**: hub/spoke is defined twice with different
   semantics — reconcile; add rooms security constraint (4.1/4.2) and R2 no-GC note.
5. **Dependency placement** (see also Phase 10): move `obsidian` to devDependencies
   (it's externalized); check whether `partyserver` is actually imported by plugin
   code or dead weight in the 400 KB bundle; bump `@types/node` from ^16.
6. Update CLAUDE.md architecture section after Phase 6 (main.ts description) and
   Phase 3 (all names).

7. **README revision** (coordinate with the Phase 3 rebrand — do the content pass
   in the same PR as the rename or just before it):
   - **Remove both YouTube embeds** — the setup walkthrough (`README.md:35-37`) and
     the R2 setup video (`README.md:57-59`), plus the R2 video link in
     Troubleshooting (`README.md:153`). They're the original author's videos and
     will rot. Replace with written steps: the setup walkthrough is mostly
     redundant with the numbered "Get started" list already present; the R2 video
     must be replaced by a short written subsection (create bucket → add binding
     named `YAOS_BUCKET` → redeploy/refresh), which also feeds item 7.6's
     in-plugin instructions.
   - **Remove the superwhisper acknowledgement** (`README.md:175`) — stale upstream
     text crediting a "landing page" that doesn't exist in this repo, with a
     "temporary use" caveat that reads as an unresolved obligation.
   - **Keep**: the hero screenshot and deploy button, the "How it works",
     "Engineering", and "Limits" sections (genuinely good docs), the
     Troubleshooting section, and the **Origin** section (Austin's deliberate
     attribution — do not shorten it away during the rename; update repo links in
     it if upstream moves).
   - **Soften the comparison table's "Conflicts: None" claim** (`README.md:25`) —
     CRDTs eliminate conflicted copies, not surprising merges; the Troubleshooting
     section itself says merged results may need review. "Automatic (CRDT)" is
     accurate and still differentiating.
   - **Fix the Configuration table** (`README.md:119-133`): it documents an
     "Exclude paths" setting that has no UI (see 7.15) and will keep drifting from
     the real settings tab. Either sync it after the Phase 7 settings work, or slim
     it to the 3-4 settings users actually search for and point at the settings tab
     for the rest. Same consideration for the Commands table.
   - Fold in the copy items already listed under Phase 7 quick wins (substantiate
     "$0" with free-tier specifics; disclose the GitHub-account requirement for
     Deploy-to-Cloudflare).
   - All `austinermish/yaos` links, the BRAT slug, badge URLs, and the deploy
     button URL change during Phase 3 — grep the README as part of the rename
     inventory (3.2).

---

## Phase 10 — Dependabot & dependency hygiene *(saved for last per Austin)*

State as of 2026-07-04: **no `.github/dependabot.yml` exists.** Open alerts:

### 10.1 Runtime fix (do immediately even though this phase is last)
- **`js-yaml` <=4.1.1 — moderate, GHSA-h67p-54hq-rp68** (quadratic DoS in merge-key
  handling). Runtime-relevant: js-yaml parses frontmatter of synced files, which in
  shared rooms is *other people's input*. Fix: `npm audit fix` at root (bumps within
  `^4.1.1`), rebuild, release. Consider folding into a Phase 1 patch release.

### 10.2 Server dev-dependency alerts
- 4 high + 1 low (`undici`, `ws`, `esbuild`, via `miniflare`) — all transitively from
  `wrangler` 4.92.0. Dev-only exposure (`wrangler dev`). Fix: bump
  `server/package.json` wrangler to ≥4.107.0, run `npm i`, verify
  `npm run dev` + `npm run test:integration:worker` still pass, `npm typecheck`.
- Root dev alert for `ws` (test harness only): bump within ^8 to ≥8.21.

### 10.3 Add `.github/dependabot.yml`
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    open-pull-requests-limit: 5
    groups:
      dev-deps:
        dependency-type: development
  - package-ecosystem: npm
    directory: /server
    schedule: { interval: weekly }
    open-pull-requests-limit: 5
    groups:
      dev-deps:
        dependency-type: development
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```
- Grouping dev deps keeps PR noise tolerable for a solo maintainer; runtime deps
  (yjs, y-partyserver, fflate, js-yaml, …) get individual PRs since they ship to users.
- Ensure CI (`ci.yml`) runs on Dependabot PRs so `test:ci` gates merges; enable
  auto-merge for grouped dev-dep PRs if desired.
- Also enable GitHub secret scanning + push protection on the repo (Settings →
  Code security) while in there.

---

## Suggested release sequencing

| Release | Contents |
|---|---|
| 2.6.2 (patch) | Phase 1.1–1.4 + 10.1 (js-yaml) |
| 2.6.3 (patch) | Phase 1.5–1.10 |
| 2.7.0 (minor) | Phase 2 (server security batch — server redeploy required) |
| **3.0.0** | **Phase 3 rename to Lodestone** (+ migration shim) |
| 3.1.x | Phase 4 rooms fixes (4.1/4.2 may warrant their own minor) |
| 3.2.x | Phases 5–7 incrementally (decomposition commits carry no user-facing change; batch with UX items) |
| ongoing | Phases 8–10 alongside |
