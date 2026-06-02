# Room Sync Bug Fix Log — June 2025 (2.5.8 / 2.5.9)

This document summarizes the hub/spoke room sync bugs found during first real-world testing
with Aaron (spoke) and the fixes shipped in 2.5.8 and 2.5.9.

---

## Background

Room sync is the multi-vault collaboration feature in YAOS. A "hub" vault shares one or more
folders via a room (Durable Object). "Spoke" vaults join via an invite URL and receive a
mirror of those folders. Both hub and spoke connect to the **same** Durable Object room Y.Doc
as peers in a y-partyserver session.

---

## Bugs fixed in 2.5.8

### Bug A — Ghost files on spoke join

**Symptom:** Spoke joins and receives files that were long since deleted from the hub.

**Root cause:** `seedRoomFromDisk` only ever added entries to the room Y.Doc (additive). Files
deleted from the hub's disk while the plugin was unloaded accumulated as stale live entries.
When Aaron joined, his DiskMirror created those stale files on his disk.

**Fix:** After `seedRoomFromDisk` seeds all present files, iterate the room Y.Doc's active
(non-tombstoned) paths. For any path inside `room.includePaths` that isn't on disk, call
`roomSync.handleDelete()` to tombstone it. Location: `seedRoomFromDisk` in `src/main.ts`.

---

### Bug B — New notes not propagating hub → spoke

**Symptom:** Hub creates a new file in a shared folder. Spoke never sees it.

**Root cause:** `syncFileFromDisk` room branch called `vaultSync.getTextForPath(crdtPath)`.
When the file was new (Y.Text didn't exist yet), `existingText` was null and the function
silently returned, leaving the room Y.Doc untouched.

**Fix:** When `existingText` is null, call `vaultSync.ensureFile(crdtPath, content, deviceName)`
to seed the new file into the room Y.Doc. Location: `syncFileFromDisk` in `src/main.ts`.

---

### Bug C — Spoke-created notes not recognized as room files

**Symptom:** Spoke creates a new note inside the hub's shared folder paths. Hub and other
spokes never see it because the spoke's routing falls back to the main VaultSync.

**Root cause:** `getRoomSyncAndCrdtPath` for spoke role called `roomSync.getTextForPath(crdtPath)`.
For a brand-new file not yet in the Y.Doc, this returned null, so the function returned null
and the file was routed to the main vault. Same issue in `isRoomManagedPath` and
`getBindingManagerForFile`.

**Fix:** Store the hub's `includePaths` in the spoke's `RoomConfig` as `hubIncludePaths`.
These are populated at join time by parsing the `paths` param from the invite URL
(which was already embedded in the URL by `buildRoomInviteUrl` but never consumed).
All three routing functions now fall back to a prefix-match against `hubIncludePaths` when
`getTextForPath` returns null.

New field: `hubIncludePaths?: string[]` on `RoomConfig` in `src/settings.ts`.
Locations: `handleRoomInviteUrl`, `joinRoom`, `getRoomSyncAndCrdtPath`, `isRoomManagedPath`,
`getBindingManagerForFile` in `src/main.ts`.

**Note for Aaron:** He must leave and rejoin the room with a fresh invite link so his
`RoomConfig` gets populated with `hubIncludePaths`.

---

### Bug D — Trace logging for hub editor binding routing (diagnostic)

Added trace logging to `bindViewToCorrectManager` so it records which binding manager
(main vs. room) is selected for each file open, and why. This makes future editorBinding
routing issues diagnosable from the debug log without code changes.

---

## Bug fixed in 2.5.9

### Bug E — Close-reopen breaks real-time editor sync and live cursors

**Symptom:** Hub (or spoke) closes a synced note then reopens it. Live cursors disappear
and real-time edits stop flowing in the editor, even though the WebSocket is still active.
Content typed by the remote peer appears in the file on disk (Y.Doc receives it) but
the open editor doesn't render it live.

**Reproduction:** Hub and Aaron edit the same note. Hub closes the tab, waits 3 seconds,
reopens. Aaron's live cursor is gone and his edits don't appear in real-time. Disk will
eventually converge (DiskMirror still works), but the editor is dead for real-time sync.

**Root cause:** When a note is closed, `unbindByPath` is NOT called — the editorBinding
entry remains in `EditorBindingManager.bindings` keyed by leafId. On reopen,
`bindViewToCorrectManager` calls `target.bind(view, deviceName)`. Inside `bind()`:
1. `getCmView()` checks `existing.cm.dom.isConnected` — if the old CM is still attached
   to the leaf's container (Obsidian doesn't always destroy it immediately), the old CM is
   returned.
2. `existing.cm === cm` (same CM reference) → `inspectBindingHealth()` is called.
3. Health check passes structurally → `bind()` returns early with "already bound".
4. The yCollab extension in the old CM is no longer receiving awareness events from the
   current session, but since no new yCollab was created, remote cursor rendering and
   real-time sync are broken.

**Fix:** In `bindViewToCorrectManager`, before calling `target.bind()`, check whether
`file.path` is in `openFilePaths`. If not (the file was closed and is being reopened),
call `unbindByPath` on all binding managers to clear the stale binding. The subsequent
`bind()` then creates a fresh yCollab extension against the current CodeMirror view.

`openFilePaths` is populated by `trackOpenFile`, which is called **after**
`bindViewToCorrectManager` in all call sites (`file-open`, `active-leaf-change`), so the
check reliably detects reopen vs. an already-active editor being re-bound.

Location: `bindViewToCorrectManager` in `src/main.ts`.

---

## What was investigated but NOT a bug

- **CREATE event reverting room Y.Text:** Suspected that when Aaron's room DiskMirror
  creates a file on his disk, the resulting `vault.on('create')` event might call
  `syncFileFromDisk` with empty disk content and revert the hub's Y.Text. Confirmed
  **not a bug**: `processDirtyMarkdownPath` checks `roomMirror.shouldSuppressCreate()`
  for all room DiskMirrors (lines 2169-2175 of `src/main.ts`). The suppression uses a
  content fingerprint (SHA-256 + byte size), so it correctly identifies and suppresses
  the DiskMirror's own writes before they reach `syncFileFromDisk`.

---

## Current known limitations

- **First-note typing lag (partially observed, not fully root-caused):** During Aaron's
  first test session, hub typed in a newly created note and Aaron didn't see the edits
  until hub pressed Enter at Aaron's cursor position. This was observed once and may be
  related to Y.Doc initialization ordering on the first note in a brand-new room. The
  2.5.8 Bug B fix (ensureFile for new room files) likely addresses this path, but it
  wasn't re-tested after the fix.

- **Aaron must rejoin with fresh invite:** His existing `RoomConfig` (saved before 2.5.8)
  doesn't have `hubIncludePaths`. He needs to leave the room and accept a new invite from
  the hub for Bug C's fix to take effect.

---

## Files changed in this work

| File | Change |
|------|--------|
| `src/settings.ts` | Added `hubIncludePaths?: string[]` to `RoomConfig` |
| `src/main.ts` | `seedRoomFromDisk` — stale Y.Doc pruning |
| `src/main.ts` | `syncFileFromDisk` — `ensureFile` for new room files |
| `src/main.ts` | `handleRoomInviteUrl` / `joinRoom` — parse and store `hubIncludePaths` |
| `src/main.ts` | `getRoomSyncAndCrdtPath`, `isRoomManagedPath`, `getBindingManagerForFile` — `hubIncludePaths` fallback for spoke routing |
| `src/main.ts` | `bindViewToCorrectManager` — trace logging + close-reopen unbind fix |
