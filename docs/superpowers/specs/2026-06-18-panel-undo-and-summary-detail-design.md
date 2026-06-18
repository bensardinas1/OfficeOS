# Panel Refinements — Undo + Summary Drill-In — Design

**Date:** 2026-06-18
**Status:** Approved (design)
**Surface:** Ambient Proposal Panel (`daemon/`, `daemon/web/`)

## Problem

Two panel gaps surfaced in live use:

1. **No undo.** Dismiss (a proposal) and Acknowledge (an item) are one-click and irreversible from the panel — a misclick can't be taken back.
2. **Summary tile's Details is empty.** The `handled` summary tile is a pure count rollup (`members: []`), so clicking Details shows an empty "MESSAGES" panel — a dead affordance. The user wants to see the actual emails behind the counts.

These are two independent features sharing the panel surface; each gets its own implementation plan.

## Goals

- A **snackbar Undo** (no timer) after Dismiss and Acknowledge that reverses the action.
- The **summary tile's Details lists the underlying emails** (sender · subject · date, each expandable to its body).
- Keep the panel zero-dependency vanilla JS/CSS; preserve existing behavior and rails.

## Non-Goals

- No change to what Dismiss/Acknowledge mean; only the ability to reverse them.
- No new delete/triage here (those are the separate Plan B / Plan C of the panel-actions spec).
- No body persistence — bodies stay on-demand (Plan A).

## Decisions (resolved during brainstorming)

- **Undo style:** snackbar, **no timer** — one undo slot, persists until the user clicks Undo or takes another action.
- **Undo immediacy:** **minimal** — undo reverses the persisted state; dismiss-undo is instant (queue state), acknowledge-undo's tile movement follows the next scheduler tick. (The read-time-ack shift was explicitly declined.)
- **Summary Details:** **list the underlying emails** in the detail panel.
- **Body-fetch at scale:** auto-load bodies only when a tile has **≤ 5 messages**; larger tiles render each row collapsed with a **"Show message"** click that lazy-loads that one body. Summary members are **capped at 50 newest**, with a "+N more" note.

---

## Feature 1 — Undo for Dismiss / Acknowledge

### Backend

- **`daemon/proposals.js`** — add a reverse transition so a dismissed proposal can return to the queue:
  ```js
  const TRANSITIONS = {
    pending:   { approve: "approved", dismiss: "dismissed", snooze: "snoozed" },
    approved:  { executed: "executed", failed: "failed" },
    snoozed:   { approve: "approved", dismiss: "dismissed" },
    dismissed: { reopen: "pending" },   // NEW
  };
  ```
  Invalid transitions still throw (unchanged).

- **`daemon/acknowledge.js`** — add `removeAck(itemId)` to the store: read `acknowledged.json`, delete the key, `atomicWrite`. `applyAcks` then stops suppressing that item (next render/tick shows its true status).

- **`daemon/api.js`** — two endpoints:
  - `POST /proposals/:id/reopen` → find proposal, `transition(p, "reopen")` → pending, persist, return `{ proposal }`. 404 if not found.
  - `POST /items/:id/unacknowledge` → `ackStore.removeAck(id)`, return `{ ok: true, itemId }`.

### Frontend

- **`daemon/web/app.js`** — UI state `ui.undo = { label, undoUrl } | null`.
  - On a **successful** dismiss POST: `ui.undo = { label: "Dismissed", undoUrl: "/proposals/<id>/reopen" }`.
  - On a successful acknowledge POST: `ui.undo = { label: "Acknowledged", undoUrl: "/items/<id>/unacknowledge" }`.
  - **One slot, no timer:** every other action handler (approve/dismiss/ack/detail/collapse/select/bulk/undo) sets `ui.undo = null` at its start, so the bar always reflects the most recent dismiss/ack and is cleared by any other interaction.
  - Clicking `data-undo` → POST `ui.undo.undoUrl`, set `ui.undo = null`, `load()`.
- **`daemon/web/render.js`** — `renderUndoBar(undo)` returns `""` when `undo` is null, else `<div class="snackbar"><span class="snacklabel">{esc label}</span><button class="undo" data-undo>Undo</button></div>`. Appended after the sections/detail in `app.js`'s `draw()`.
- **`daemon/web/styles.css`** — `.snackbar` pinned to the panel bottom (`position: fixed; left/bottom`), subtle surface, with `.undo` button styling.

### Reflects

- **Dismiss / undo-dismiss:** instant — the proposal's pending Approve/dismiss buttons disappear/reappear on reload (queue state is read fresh).
- **Acknowledge / undo-acknowledge:** the ack is recorded/removed immediately; the tile's status moves on the next tick (existing acknowledge cadence). The snackbar gives immediate textual confirmation either way.

### Edge cases

- Reopen when the proposal is missing (queue pruned) → 404; app clears the bar.
- Undo bar shows one action at a time; a second dismiss/ack replaces it.

---

## Feature 2 — Summary tile lists its emails in Details

### Normalizer

- **`daemon/normalizers/handled.js`** — in addition to the counts, populate `group.members` from the classified **non-ignore** emails:
  - Collect every email across non-ignore categories (the same buckets the counts use, honoring `lookbackHours`), map each to `{ subject, from, fromName, receivedAt, emailId }` (`emailId` from the email's `id`).
  - Sort **newest-first** by `receivedAt`, take the **first 50**.
  - Set `group.moreCount = max(0, total - 50)`.
  - `group.counts`, `title`, `subtitle`, and `status: "ok"` are unchanged. The tile's subline still uses `subtitle` (not `messageCount`), so the card looks the same; only Details changes.
  - Item shape gains members + `group.moreCount`; `fingerprint` is unaffected (it hashes id/status/title/rootCause only), and `handled` is not acknowledgeable.

### Detail panel — bodies at scale

- **`daemon/web/render.js` `renderDetailPanel`** — compute `autoBodies = (members.length <= 5)`. Per message row:
  - **auto (≤5):** render the existing `<div class="msgbody" data-body-for="<id>"><span class="bodyload">Loading…</span></div>` (app auto-loads on open — unchanged Plan A behavior for finding tiles).
  - **collapsed (>5):** render `<button class="showbody" data-loadbody="<id>">Show message</button>` followed by `<div class="msgbody" data-body-for="<id>" hidden></div>` (no auto-fetch).
  - When `group.moreCount > 0`, append a `<div class="dmore">+ {moreCount} more not shown</div>` after the message list.
- **`daemon/web/app.js`**:
  - `loadBodies(item)` only auto-fetches when `item.group.members.length <= 5` (otherwise the rows are collapsed and fetch on demand).
  - New click handler for `data-loadbody`: fetch that one body, fill the sibling `[data-body-for]`, remove its `hidden`, and hide/disable the button. Uses the same `bodyCache` and `fillBody`.
- **`daemon/web/styles.css`** — `.showbody` button + `.dmore` note styling.

### Reflects

Clicking Details on e.g. "Personal · + 10 informational" lists those emails (sender · subject · date); each row expands to its body on demand. Once Plan B (Delete + Add to Kill List) lands, these rows become directly actionable.

---

## Rails (unchanged)

- Undo only flips local proposal/ack state — no mail send/delete.
- Summary members carry subject/sender/date (already true for other jobs); bodies remain on-demand and read-only.
- No auto-send, no permanent delete.

## Testing

**Feature 1:**
- `proposals.test.js`: `reopen` flips `dismissed → pending`; an invalid event still throws.
- `acknowledge.test.js`: `removeAck` deletes the key; `applyAcks` no longer suppresses the item.
- `api.test.js`: `POST /proposals/:id/reopen` (dismissed→pending, persisted), `POST /items/:id/unacknowledge` (ack removed), 404 for unknown proposal.
- `render.test.js`: `renderUndoBar` shows label + `data-undo`; returns `""` when null.
- `contract.test.js`: app handles `data-undo`; render emits it.

**Feature 2:**
- `handled.test.js`: members populated from non-ignore emails, newest-first, capped at 50, `moreCount` set when truncated; counts/title/subtitle unchanged; empty case → `members: []`, no `moreCount`.
- `render.test.js`: `renderDetailPanel` emits auto `data-body-for` placeholders when ≤5 members; emits `data-loadbody` "Show message" + `hidden` body when >5; shows the `+N more` note when `moreCount > 0`.
- `contract.test.js`: app handles `data-loadbody`.

Full suite stays green.

## Build Sequence (two plans)

1. **Plan — Undo** (smallest, self-contained): proposals transition, `removeAck`, two endpoints, snackbar UI, tests.
2. **Plan — Summary drill-in**: `handled.js` members + cap, the `≤5 auto / >5 click-to-expand` body refinement, `+N more` note, tests.

Each plan produces working, testable software on its own.
