# Panel Multi-Select Bulk Actions + Conversation Drill-in (Cluster B2) — Design

**Date:** 2026-07-14 (amended same day: conversation-grouped drill-in folded in)
**Status:** Approved (brainstorm complete, amendment approved)
**Context:** The panel can act on one tile, one sender-cluster, or one row at a time,
and the `handled` drill-in scatters multi-sender conversations (e.g. a Path Peptides
underwriting thread spanning three senders) across sender-clusters. B1 shipped the
endpoints bulk actions need (`POST /senders/delete-all`, per-row undo audit accounting,
per-id `failedIds`). B2 adds: a selection surface over those endpoints (tiles,
sender-clusters, conversations → bulk Delete / Kill / Delete-and-Kill / Undo), and a
conversation-grouped view for human mail in the handled drill-in.

**Decisions locked during brainstorm:**
- Selectable units = tiles (cards), sender-clusters (detail-pane group headers), and
  conversations (new), sharing ONE selection set.
- Bulk controls live in a sticky footer bar, rendered only while the selection is
  non-empty.
- Soft-delete only, reconfirmed: every bulk delete path funnels through
  `mail.js deleteEmails` (Outlook move→deleteditems / Gmail trash) — B2 adds ways to
  SELECT, never a new delete mechanism.
- Conversation identity comes from PROVIDER ground truth (`conversationId` /
  `threadId`) — subject-based heuristics are explicitly rejected (templated noise
  subjects collide; a heuristic must never widen a delete's blast radius).
- Approach A chosen: typed keys in the existing `selected` Set + a pure plan resolver.

---

## Component 0 — Conversation identity plumbing

- `scripts/mail.js` maps a unified **`conversationId`** field on every fetched email:
  Outlook adds `conversationId` to `OUTLOOK_SELECT` and maps it through; Gmail sets it
  from the existing `threadId`. (Shims/consumers unaffected — superset shape.)
- `daemon/normalizers/handled.js` stamps two new member fields:
  `conversationId` (pass-through) and `automated` (the `looksAutomated` verdict it
  already computes for the honest count — now recorded per member, not just counted).
- Fingerprints unaffected (they hash id/status/title/rootCause only). Daemon restart
  required at ship time (fetch layer + normalizer changed).

## Component 1 — Selection model + `resolveBulkPlan` (the heart)

### Typed selection keys (one shared `selected` Set)
- `item:<item.id>` — card checkboxes (existing checkboxes; keys gain the prefix;
  `pendingApprovalsFor` updated accordingly).
- `cluster:<account>:<senderEmail>` — NEW checkbox on each sender-group header
  (`.sghdr`) in the drill-in's Bulk senders section.
- `conv:<account>:<conversationId>` — NEW checkbox on each conversation header in the
  drill-in's Conversations section.

### `resolveBulkPlan(action, selectedKeys, view, acted)` — pure, in `selection.js`
Input: action (`"approve" | "delete" | "kill" | "delkill" | "undo"`), selection, panel
view (items/members lookup), acted map.
Output: `{ ops: [...], skips: [{label, reason}] }`, each op one HTTP call:

- `{kind: "approve", proposalId}` — pending proposals of selected items (existing
  bulk-approve semantics).
- `{kind: "delete", account, emailIds, label}` — a selected TILE's member emailIds, or
  a selected CONVERSATION's member emailIds (precision: multi-sender threads and
  conversation-shaped tiles must never become sender queries).
- `{kind: "deleteBySender", account, sender, label}` — a selected CLUSTER (intent:
  everything from that sender within the endpoint's window, not just rendered rows).
- `{kind: "kill", account, sender, emailIds, label}` — each distinct resolvable sender:
  a cluster's sender; a tile's or conversation's sender when its members share exactly
  one. `emailIds` = known member ids (so kill acted-state derives server-side).
- `{kind: "killRemove", account, sender, undoOf, label}` /
  `{kind: "restore", account, emailIds, undoOf, label}` — for `undo`: collect acted
  entries under the selected units, dedupe by entry id, one op per entry (restore ops
  carry only the ids belonging to that entry).

Skip rules (every skip carries a human reason for the summary):
- Delete/delkill: units whose rows are ALL already acted → "already deleted".
- Kill/delkill: multi-sender tiles/conversations → kill half skipped
  ("multiple senders"); units with no resolvable sender → skipped.
- Undo: units with no acted entries → skipped.
- Dedupe: delete ops drop emailIds already covered by a selected cluster's
  `deleteBySender` on the same account+sender; kill ops dedupe by account+sender;
  overlapping conversation/tile selections dedupe by emailId.
- Cross-account selections are fine: ops carry their account.

`delkill` = the delete ops followed by the kill ops (same skip/dedupe rules).

## Component 2 — Conversation-grouped drill-in (handled tiles)

Pure `groupHandledMembers(members)` in `daemon/web/view-model.js` →
`{ conversations: [...], senders: [...] }`:
- **Conversations**: members with `automated === false`, grouped by `conversationId`,
  groups ordered newest-activity-first, rows within a group oldest-first (thread
  order). Group header: latest message's subject with a display-only `Re:/Fwd:` prefix
  strip, plus `N messages · M senders`. Members lacking `conversationId` become
  singleton conversations keyed by their emailId.
- **Senders**: the `automated === true` remainder, grouped by sender exactly as today
  (per-cluster Delete-all / Kill / Delete-and-Kill buttons live here, unchanged).
- Members missing the `automated` field entirely (stale model from an old daemon)
  fall back to the senders section (today's behavior — graceful pre-restart).

`renderDetailPanel` renders the two sections for `handled` items ("Conversations",
"Bulk senders" headings; either section omitted when empty). `triage` items keep
sender-clusters only (their members are deletion candidates by definition). Non-
clustered job types (gateway/audit/exposed/owed_risk) are unchanged — they are already
conversation-shaped tiles.

## Component 3 — Sticky bulk bar

`renderBulkBar(selectionCount, ui)` replaces `renderSelectControls`:
- Rendered ONLY when selection is non-empty; `position: fixed; bottom: 0`, full width,
  z-order above the list, below the detail pane:
  `N selected · ✓ Approve · Delete · Kill list · Delete & Kill · Undo · Clear`.
- Delete / Kill list / Delete & Kill / Undo use the existing two-click `confirmBtn`
  machinery (tokens `bulk:delete`, `bulk:kill`, `bulk:delkill`, `bulk:undo`); during a
  run all bar buttons disable and the bar shows `Working (k/n)…` from
  `ui.bulkBusy = {done, total}`. `Clear` empties the selection. Approve keeps its
  single-shot behavior (drafts only).

## Component 4 — Execution loop (app.js)

One handler per bar button → `confirmThen(token, run)` where `run`:
1. `resolveBulkPlan(action, selected, view, ui.acted)`.
2. `ui.bulkBusy = {done: 0, total: ops.length}`; draw.
3. Sequential loop over ops: post to the op's endpoint, record the result, mark
   optimistic acted state (delete → member ids dimmed with `deleteEntryId`; kill →
   `killEntryId`; undo → remove local keys), increment `done`, redraw.
4. Aggregate notice, e.g. `Deleted 214 (2 senders, 1 tile, 1 conversation) ·
   kill-listed 2 · 1 refused (protected) · 2 skipped (already deleted)`. Refusals and
   failures are counted, never dropped; a thrown op aborts the remainder and reports
   `stopped after k/n: <error>`.
5. Clear selection, `ui.bulkBusy = null`, `await load()` (server reconciliation).

## Component 5 — Folded-in B1 leftovers

Tile-level and per-message **Kill buttons gain `data-ids`** (member emailIds) and their
handlers send `emailIds` in the killlist POST — kill-only acted state becomes
server-derivable and survives reload; tile-level kill hydration then works via the
existing all-members-acted synthesized fallback.

## Component 6 — Testing

- `resolveBulkPlan`: dense unit suite — every action over mixed selections (tiles +
  clusters + conversations, cross-account), skip rules, dedupe rules, undo entry
  collection, empty results.
- `groupHandledMembers`: split correctness (automated routing), conversation grouping/
  ordering, singleton fallback, missing-`automated` fallback, header label derivation.
- `mail.js`: conversationId mapped on both providers (fake-client tests).
- `handled` normalizer: members carry conversationId + automated.
- Render: bulk bar states (hidden at 0, armed, working), two-section drill-in,
  conversation + cluster checkboxes, kill `data-ids` (tile + per-msg).
- Contract: app selects the new data- attributes; render emits them.
- e2e additions: multi-sender conversation renders as ONE group; select it + a sender
  cluster → bulk Delete → aggregate notice + acted rows; bulk Undo on the selection →
  cleared; both survive reload.

## Safety rails (unchanged, restated)

- All bulk deletes route through existing guarded endpoints → `mail.js deleteEmails`
  (move→deleteditems / trash). No new mail-touching code paths.
- Conversations and tiles always delete by precise emailId list; only sender-clusters
  use the (guarded, windowed, capped) sender query.
- Kill list stays config-only with protected/correspondent guards; refusals surface
  per-sender in the summary. Two-click confirm before any bulk mutation.
- No subject-based grouping anywhere in action logic (display-only prefix strip on
  conversation headers).

## Out of scope

- Persisting selection across reloads; select-all; keyboard range-select.
- Conversation grouping for triage tiles or non-handled job types.
- Undo-all snackbar for a just-run bulk (bulk-select Undo covers it).
- Handled-count tuning + config validator (Cluster C).
