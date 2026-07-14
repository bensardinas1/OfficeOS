# Panel Multi-Select Bulk Actions (Cluster B2) — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorm complete)
**Context:** The panel can act on one tile, one sender-cluster, or one row at a time.
Clearing an inbox means clicking through drill-ins serially. B1 shipped the endpoints
bulk actions need (`POST /senders/delete-all`, per-row undo audit accounting, per-id
`failedIds`); B2 puts a selection surface over them: select multiple tiles and
sender-clusters, then Delete / Kill / Delete-and-Kill / Undo the whole selection.

**Decisions locked during brainstorm:**
- Selectable units = tiles (cards) AND sender-clusters (detail-pane group headers),
  sharing ONE selection set.
- Bulk controls live in a sticky footer bar, rendered only while the selection is
  non-empty.
- Soft-delete only, reconfirmed: every bulk delete path funnels through
  `mail.js deleteEmails` (Outlook move→deleteditems / Gmail trash) — B2 adds ways to
  SELECT, never a new delete mechanism.
- Approach A chosen: typed keys in the existing `selected` Set + a pure plan resolver
  (over per-surface selection sets or a "sweep mode" interaction).

---

## Component 1 — Selection model + `resolveBulkPlan` (the heart)

### Typed selection keys
The existing `selected` Set holds typed keys:
- `item:<item.id>` — card checkboxes (existing checkboxes; keys gain the `item:` prefix).
- `cluster:<account>:<senderEmail>` — NEW checkbox on each sender-group header
  (`.sghdr`) in the detail pane's clustered view (handled/triage items).
`selection.js`'s `toggle` is unchanged (it's key-agnostic). `pendingApprovalsFor`
updates to read `item:`-prefixed keys.

### `resolveBulkPlan(action, selectedKeys, view, acted)` — pure, in `selection.js`
Input: the action (`"approve" | "delete" | "kill" | "delkill" | "undo"`), the selection,
the current panel view (for items/members lookup), and the acted map.
Output: `{ ops: [...], skips: [{label, reason}] }` where each op is one HTTP call:

- `{kind: "approve", proposalId}` — pending proposals of selected items (existing
  bulk-approve semantics).
- `{kind: "delete", account, emailIds, label}` — a selected TILE's member emailIds
  (rendered members; precision — a gateway thread's sender must not be swept).
- `{kind: "deleteBySender", account, sender, label}` — a selected CLUSTER (intent-level:
  everything from that sender within the endpoint's window, not just rendered rows).
- `{kind: "kill", account, sender, emailIds, label}` — each distinct resolvable sender:
  a cluster's sender, or a tile's sender when its members share exactly one. `emailIds`
  = the known member ids (so kill acted-state derives server-side).
- `{kind: "killRemove", account, sender, undoOf, label}` /
  `{kind: "restore", account, emailIds, undoOf, label}` — for `undo`: collect the acted
  entries under the selected units (tile members' and clusters' row entries), dedupe by
  entry id, emit one op per entry (restore ops carry only the ids belonging to that
  entry).

Skip rules (each skip carries a human reason for the summary):
- Delete/delkill: units whose rows are ALL already acted → skipped ("already deleted").
- Kill/delkill: multi-sender tiles → kill half skipped ("multiple senders"); tiles with
  no resolvable sender → skipped.
- Undo: units with no acted entries → skipped.
- Duplicate coverage (a selected cluster whose sender also covers a selected tile's
  rows): ops are deduped — delete ops drop emailIds already covered by a selected
  cluster's `deleteBySender` on the same account+sender; kill ops dedupe by
  account+sender.
- Selections spanning accounts are fine: ops carry their account; execution is
  per-op.

`delkill` = the delete ops followed by the kill ops (same skip/dedupe rules).

## Component 2 — Sticky bulk bar

`renderBulkBar(selectionCount, ui)` replaces `renderSelectControls`:
- Rendered ONLY when `selectionCount > 0`; fixed to the viewport bottom
  (`position: fixed; bottom: 0`), above the snackbar/notice z-order, full-width bar:
  `N selected · ✓ Approve · Delete · Kill list · Delete & Kill · Undo · Clear`.
- Delete / Kill list / Delete & Kill / Undo use the existing two-click `confirmBtn`
  machinery with tokens `bulk:delete`, `bulk:kill`, `bulk:delkill`, `bulk:undo`; while
  a bulk run is executing, ALL bar buttons disable and the bar shows
  `Working (k/n)…` from `ui.bulkBusy = {done, total}`.
- `Clear` empties the selection (and unchecks boxes on next draw).
- Approve keeps its current single-shot behavior (no two-click; it only creates drafts).
- The detail pane's width is accounted for (bar spans the viewport; no overlap issue —
  the pane already overlays with a higher z-index; bar z-index sits below the detail
  pane, above the list).

## Component 3 — Execution loop (app.js)

One handler per bar button → `confirmThen(token, run)` where `run`:
1. `const plan = resolveBulkPlan(action, selected, view, ui.acted)`.
2. `ui.bulkBusy = { done: 0, total: plan.ops.length }`; draw.
3. Sequential `for` over ops (matches the daemon's per-id pacing; no parallel storms):
   each op posts to its endpoint, records per-op results, marks optimistic acted state
   (delete → member ids dimmed with `deleteEntryId`; kill → `killEntryId`; undo →
   removes local keys), increments `ui.bulkBusy.done`, redraws.
4. Aggregate notice from results + skips, e.g.
   `Deleted 214 (2 senders, 1 tile) · kill-listed 2 · 1 refused (protected) · 2 skipped (already deleted)`.
   Refusals (`refused` in a response) and failures (`ok:false` / thrown) are counted,
   never silently dropped; a thrown op aborts remaining ops and reports
   `stopped after k/n: <error>`.
5. Clear the selection, `ui.bulkBusy = null`, `await load()` (server reconciliation).

## Component 4 — Folded-in B1 leftovers

- Tile-level and per-message **Kill buttons gain `data-ids`** (member emailIds), and
  their handlers already send `emailIds` in the killlist POST body — so kill-only acted
  state becomes server-derivable and survives reload. Tile-level kill hydration then
  works via the existing all-members-acted synthesized fallback (no render change
  needed beyond the attrs).

## Component 5 — Testing

- `selection.js` `resolveBulkPlan`: the dense unit suite — every action over mixed
  selections (tiles + clusters, cross-account), skip rules, dedupe rules, undo entry
  collection/dedupe, empty results.
- Render tests: bulk bar hidden at 0 selected, buttons + confirm/armed/working states,
  cluster header checkboxes (`data-select="cluster:..."`), kill button `data-ids`
  presence (tile + per-msg).
- Contract tests: app selects `[data-bulk-delete]` etc.; render emits them.
- api/daemon: no changes needed (all endpoints exist) — no new api tests.
- e2e additions: select two sender-clusters → bulk Delete → aggregate notice + rows
  acted; select acted units → bulk Undo → cleared, and both survive reload. Fake
  connectors already return canned success shapes for every endpoint used.

## Safety rails (unchanged, restated)

- All bulk deletes route through the existing guarded endpoints →
  `mail.js deleteEmails` (move→deleteditems / trash). No new mail-touching code paths.
- Kill list stays config-only with protected/correspondent guards; refusals surface
  per-sender in the summary.
- Two-click confirm before any bulk mutation; Working state prevents double-submit;
  Undo is first-class.

## Out of scope

- Persisting selection across reloads; select-all affordances; keyboard range-select.
- Handled-count tuning + config validator (Cluster C).
- Undo-all snackbar for a just-run bulk (bulk-select Undo covers the need).
