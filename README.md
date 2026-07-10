# Lodestone

**A zero-terminal, real-time sync engine for Obsidian, powered by your own Cloudflare Worker.**

Your notes stay in sync instantly across devices, without conflicted copies, delayed file sync, or database-heavy self-hosting.

<img src="https://github.com/user-attachments/assets/ee937050-8a05-4d56-9c5f-3ae5003496fc" alt="Lodestone syncing a note across desktop and mobile in real time" width="720" />

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/austinermish/lodestone/tree/main/server)

[![License: 0-BSD](https://img.shields.io/badge/license-0--BSD-green)](LICENSE)

No terminal, no `.env` files, no database setup required.

## How it compares

Most ways to sync Obsidian pick a trade-off. Lodestone picks none.

| | Conflicts | Real-time | Self-hosted | No terminal | Free |
|---|:---:|:---:|:---:|:---:|:---:|
| **iCloud / Dropbox** | Conflicted copies | No | No | Yes | Yes |
| **Obsidian Sync** | Rare | Delayed | No | Yes | $96/yr |
| **Git / LiveSync** | Manual | Varies | Yes | No | Yes |
| **Relay / Screengarden** | No | Yes | No | Yes | Freemium |
| **Lodestone** | **None** | **Yes** | **Yes** | **Yes** | **$0** |

Lodestone uses [Yjs CRDTs](https://yjs.dev) to keep one live vault state moving across devices instead of asking them to take polite turns uploading files and hoping nothing collides.

If you want the official, fully managed experience, pay for Obsidian Sync and support the team. If you want a fast, self-hosted, local-first alternative that you fully control, this is Lodestone.

## Get started

Lodestone has two parts: an Obsidian plugin and a small Cloudflare server you deploy to your own account. The Worker setup page walks you through the remaining steps, so you don't need to memorize this.

<a href="https://youtu.be/xeS126_XK9Q">
  <img src="https://img.youtube.com/vi/xeS126_XK9Q/maxresdefault.jpg" width="480" alt="Watch the setup walkthrough" />
</a>

**1. Deploy your server**
Click **Deploy to Cloudflare** above. Cloudflare creates a Worker in your account.

**2. Claim your server**
Open the Worker URL. Click **Claim** to lock the server to you and generate your setup token.

**3. Install the plugin**
Lodestone is in the Obsidian Marketplace review queue. To install today, add it through [BRAT](https://github.com/TfTHacker/obsidian42-brat): open BRAT settings → **Add Beta plugin** → paste `austinermish/lodestone`.

**4. Connect your vault**
From the claim page, open the setup link or scan the QR code. Lodestone fills in the connection details automatically.

That's it. Your vault is syncing.

## Attachments and snapshots

Text sync works out of the box. To sync images, PDFs, and other attachments, add a Cloudflare R2 bucket — it takes about a minute.

<a href="https://youtu.be/Z7xCMEYfdFM">
  <img src="https://img.youtube.com/vi/Z7xCMEYfdFM/maxresdefault.jpg" width="480" alt="Watch the R2 setup video" />
</a>

R2 also enables daily automatic snapshots and on-demand point-in-time backups. You can browse snapshots, diff against current state, and selectively restore individual files. If you skip R2, text sync still works perfectly — you just won't have attachment sync or snapshots.

## Rooms — sharing folders across vaults

Rooms let one vault (the **hub**) share specific folders with other vaults (**spokes**) in real time, without merging entire vaults together.

- **Hub** — creates the room, picks which folders to share, and generates invite links/QR codes for spokes to join.
- **Spoke** — joins via an invite link; the shared folders sync live onto that vault.
- **Content editing is fully bidirectional** — hub and spokes both edit file content live, with real-time cursors, using the same CRDT engine as normal device sync.
- **Structure is host-only** — creating, renaming, moving, or deleting files and folders inside a shared room is restricted to the hub. If a spoke creates a file in a shared folder, it stays local to that spoke's vault and does not sync anywhere else. This is a deliberate design choice (see [Origin](#origin)) that keeps folder structure authoritative and avoids conflicting structural edits arriving from multiple vaults at once. It's not a bug — see the FAQ below.
- Today, each hub runs on its own Cloudflare Worker. A vault can be a spoke in someone else's room and a hub of its own room at the same time, on separate infrastructure.

## Updating your server

Lodestone is designed to be zero-terminal, but because you own your infrastructure, you control when updates apply.

A one-time setup installs a GitHub Actions workflow in your deployment repo. After that, updates are a single click.

1. **One-time**: click **Initialize updater** in Lodestone settings → **Advanced**. GitHub opens with a pre-filled workflow file. Commit it.
2. **Update**: Lodestone notifies you when a new version ships. Click **Open update action** → **Run workflow** with `update`.
3. **Rollback**: same workflow, change action to `revert`.

Some releases require manual migration steps. The updater will abort with a clear warning — read the release notes before retrying. Re-clicking Deploy to Cloudflare is not a safe update path for a stateful server; Lodestone uses a Git-driven workflow so the same Worker identity, Durable Object bindings, and history are preserved.

## Works with scripts and AI agents

Because Obsidian vaults are just local Markdown files, Lodestone plays unusually well with scripts, CLI tools, and AI agents that edit files directly on disk. The CRDT state stays aligned with the filesystem, so changes from any source — git, shell scripts, agents writing to disk — propagate cleanly across devices instead of falling back to conflicted-copy workflows.

If you're building agentic workflows on top of Obsidian vaults, Lodestone gives you the sync infrastructure so you don't have to wire up your own.

## How it works

Lodestone keeps your vault as normal local files, while also maintaining a shared real-time state for sync.

1. Each markdown file gets a stable ID and a `Y.Text` CRDT for its content.
2. All per-file CRDTs live inside one shared vault-level `Y.Doc` — this keeps cross-file operations transactional. A folder rename is atomic across all files; the vault structure can't tear.
3. Live editor edits flow through a Yjs + CodeMirror binding.
4. Each vault maps to one Durable Object sync room. The shared state survives server restarts and hibernation.
5. Offline edits are stored in IndexedDB and merge on reconnect.
6. Attachments sync separately via content-addressed R2 storage instead of being forced through the text CRDT.
7. Daily and on-demand snapshots exist as a safety net.

In practice, that means your vault still exists locally as normal files, Obsidian keeps behaving like Obsidian, and Lodestone keeps the disk mirror and the shared CRDT state aligned instead of asking devices to take polite turns uploading files later.

## Engineering

This repository keeps deep architecture notes under [`engineering/`](./engineering). These aren't afterthoughts — they capture the design rationale, trade-offs, and failure modes behind a production CRDT sync engine on Cloudflare Workers.

- **[Monolithic vault CRDT](./engineering/monolith.md)** — Why one vault-level `Y.Doc`, what we gain (ACID cross-file transactions), and what we consciously trade off.
- **[Filesystem bridge](./engineering/filesystem-bridge.md)** — How noisy Obsidian file events are converted into safe CRDT updates with dirty-set draining and content-acknowledged suppression.
- **[Checkpoint + journal persistence](./engineering/checkpoint-journal.md)** — The storage-engine rewrite that removed full-state rewrites and introduced state-vector-anchored delta journaling.
- **[Attachment sync](./engineering/attachment-sync.md)** — Native Worker proxy uploads, capability negotiation, and bounded fan-out under Cloudflare connection limits.
- **[Zero-config auth](./engineering/zero-config-auth.md)** — Browser claim UX, `obsidian://lodestone` deep-link pairing, and env-token override behavior.
- **[Zero-ops update pipeline](./engineering/zero-ops-update-pipeline.md)** — Why detached deploy repos need bootstrap injection, reusable workflows, and migration safety gates.
- **[Warts and limits](./engineering/warts-and-limits.md)** — Canonical limits, safety invariants, and the pragmatic compromises currently in production.

## Limits

Lodestone is optimized for personal or small-team note vaults, not for arbitrarily huge text archives. The monolithic `Y.Doc` design gives excellent real-time ergonomics and simpler cross-file behavior, but it creates a practical ceiling for very large vaults.

If your vault is normal notes, drafts, research, and attachments, Lodestone is a great fit. If you want to sync giant text dumps or archival datasets, a simpler file-sync tool is a better choice.

Rule of thumb: around 50 MB of raw text (not counting attachments like images and PDFs) is a comfortable target.

## Configuration

After enabling, go to **Settings → Lodestone**.

| Setting | Description |
|---------|-------------|
| **Server URL** | Your Worker URL (e.g. `https://sync.yourdomain.com`) |
| **Sync token** | Filled automatically by the setup link after claiming |
| **Device name** | Shown to other devices in live cursors and presence |
| **Exclude paths** | Comma-separated prefixes to skip (e.g. `templates/, .trash/`) |
| **Max text file size** | Skip text files larger than this for live document sync |
| **Sync attachments** | Enable R2 sync for images, PDFs, and other non-markdown files |
| **Max attachment size** | Skip attachments larger than this (default 10 MB) |
| **Parallel transfers** | Number of simultaneous attachment upload/download slots |
| **Show remote cursors** | Display cursor positions and selections from other devices |
| **Edits from other apps** | Control how Lodestone handles changes from git, scripts, or other editors |
| **Debug logging** | Verbose console output for troubleshooting |

`Manual connection` and `Advanced` sections are available in the settings UI when you need to inspect or override connection details.

## Commands

Access via command palette (Ctrl/Cmd+P):

| Command | Description |
|---------|-------------|
| **Reconnect to sync server** | Force reconnect after network changes |
| **Force reconcile** | Re-merge disk state with CRDT |
| **Show sync debug info** | Connection state, file counts, queue status |
| **Take snapshot now** | Create an immediate backup to R2 |
| **Browse and restore snapshots** | View snapshots, diff against current state, selective restore |
| **Reset local cache** | Clear IndexedDB, re-sync from server |
| **Nuclear reset** | Wipe all CRDT state everywhere, re-seed from disk |

## Troubleshooting & FAQ

**"Unauthorized" errors**: Token mismatch between plugin and server. Check both match exactly.

**"R2 not configured"**: The server doesn't have a `LODESTONE_BUCKET` binding yet. See the [R2 setup video](https://youtu.be/Z7xCMEYfdFM).

**Cloudflare deploy/dashboard issues**: If build queue or dashboard behavior is flaky, see [server troubleshooting notes](./server/README.md#transient-cloudflare-deployment-issues), including the `wrangler.toml` R2-binding fallback.

**Sync stops on mobile**: Use "Reconnect to sync server" command. Check you have network connectivity.

**Files not syncing**: Check exclude patterns. Files over max size are skipped. Use debug logging to see what's happening, and then raise an issue on GitHub.

**Conflicts after offline edits**: CRDTs merge automatically but the result depends on operation order. Review merged content if needed.

**I created a file in a shared room folder on a spoke, but it never showed up on the hub or other spokes.** This is intended, not a bug — see [Rooms](#rooms--sharing-folders-across-vaults) above. Structural changes (new files, renames, moves, deletes) inside a room are host-only. The file exists locally on that spoke's vault but won't sync anywhere until it's created on the hub instead. Spoke-side structural permissions may become configurable in a future release — not built today.

**Can spokes edit shared files in a room?** Yes, fully — real-time content editing and live cursors work in both directions between hub and spokes. Only *structural* changes (create/rename/move/delete) are host-only.

**A brand-new file in a room takes a few seconds before live typing/cursors fully engage.** Known rough edge, being investigated. Files already present when you join a room sync instantly; a file created after that can show a short delay (up to ~15 seconds) before both sides see each other's live edits. It always resolves on its own and nothing is lost — just not smoothed over yet.

## Origin

Lodestone started as a fork of [kavinsood/yaos](https://github.com/kavinsood/yaos), an excellent Cloudflare-native real-time sync engine for Obsidian. Full credit to Kavin for the original architecture: Durable Object sync rooms, Yjs CRDTs for conflict-free merges, and R2-backed attachments and snapshots — the hard part of this project.

Upstream YAOS uses a **vault pool** topology, where every connected vault shares every other vault's files and folders symmetrically. This fork changes that to a **hub/spoke** topology instead: one host vault, one or more spoke vaults, with real-time collaborative editing in both directions, but structural changes (creating, renaming, moving, or deleting files and folders) restricted to the host. That's a different sharing model than upstream, not just a feature add-on, which is why this lives as its own repository rather than a PR back upstream.

The 0-BSD license means none of this required permission or attribution to fork — but the credit is owed anyway. If you want the original vault-pool model, go use Kavin's version.

## License

[0-BSD](LICENSE)

**Acknowledgements:** The initial landing page design was heavily inspired by and utilizes assets from the excellent folks at [superwhisper](https://superwhisper.com). Huge thanks to their creator for permitting temporary use while we fully redesign. (P.S. They are hiring!).
