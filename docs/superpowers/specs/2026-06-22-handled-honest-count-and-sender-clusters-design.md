# Handled Tile — Honest "Needs a Reply" Count + Sender-Clustered Drill-In — Design

**Date:** 2026-06-22
**Status:** Approved (design)
**Surface:** Ambient Proposal Panel — `daemon/normalizers/handled.js`, `daemon/web/`

## Problem

The `handled` summary tile shows an unruly count — "269 need a reply or decision" for Brickell Pay. Root cause (confirmed from config + classifier): `brickellpay.prioritySenders` contains `{type:"domain", value:"brickellpay.com"}` ("Internal staff"), so **every own-domain email — including all `noreply@brickellpay.com` / system notifications — is classified `action`**, and broad `urgencyRules.flags` (hold, audit, chargeback, declined, …) sweep in more. The intent (internal staff + account alerts matter) is right, but automated/no-reply mail that needs no reply inflates the count, and the flat 269-row drill-in is unnavigable.

## Goals

- **A —** the handled count reflects only genuinely actionable mail: automated/no-reply senders are demoted from "needs a reply or decision" to "informational" — **in the handled tile only** (the global classifier is untouched).
- **B —** the handled (and triage Cleanup) drill-in is **grouped by sender**, with per-sender bulk **Delete / Kill list / Delete & kill** so a noisy sender is cleared in one go.
- Preserve rails and existing behavior; finding tiles (gateway/audit/exposed/owed_risk) keep their flat thread view.

## Decisions (from brainstorming)

- A is **panel-handled-tile-local** (recommended). The classifier / morning-brief / triage are not changed.
- B applies to the **`handled` and `triage`** job types (the heterogeneous buckets). Findings stay flat.

## Feature A — Honest count (handled-local)

`daemon/normalizers/handled.js` already buckets each non-ignore email into `needsYou` (actionable category) or `waiting` (everything else). Change: within the **actionable** category, an email counts as `needsYou` only if its sender is **not automated**; automated senders count as `waiting`.

- Automated test: the existing pure `looksAutomated(senderEmail, hasListUnsubscribe)` from `scripts/sender-guards.js` (matches `no-reply` / `do-not-reply` / `notifications` / `alerts` / `mailer-daemon` local-parts, or a present List-Unsubscribe). Imported into the normalizer (`../../scripts/sender-guards.js` — daemon already imports from `scripts/`).
- Non-actionable categories (fyi/news) are unchanged (all `waiting`).
- **Members are unchanged** — every email still appears in `group.members` (newest-first, cap 50, `moreCount`). Only the *count split* changes, so the headline ("N need a reply or decision") becomes honest and the demoted mail shows under "+ N informational".
- This is a presentation choice in the summary; the classifier still tags these `action` for other consumers. No config change.

Effect: `Wayne@brickellpay.com` (a person) stays in the count; `noreply@brickellpay.com`, `defender-noreply@`, `azure-noreply@`, GitHub `notifications@`, etc. drop to informational — collapsing 269 to a realistic headline.

## Feature B — Sender-clustered drill-in

`daemon/web/render.js` `renderDetailPanel`: when `item.jobType` is `handled` or `triage`, render the message list **grouped by sender** instead of flat.

- Group members by sender — key on `from` (lowercased) for actionability, label by `fromName || from`. Order groups by descending member count (noisiest first); within a group, newest-first.
- Each group renders a **section header**: `Sender name (N)` plus three two-click-confirm bulk buttons operating on that group:
  - **Delete all** → `data-delete` with `data-ids` = the group's emailIds (token `del:cluster:<account>:<senderKey>`).
  - **Kill list** → `data-killlist` with `data-sender` = the group's `from` (token `kill:cluster:<account>:<senderKey>`).
  - **Delete & kill** → `data-delkill` (token `delkill:cluster:<account>:<senderKey>`).
- Under each header, rows show **subject · date** and the existing **body region** (≤5-tile auto-load vs ">5" click-to-expand still applies across the whole pane). In clustered view, rows do **not** carry per-row Delete/Kill buttons — the per-sender header owns the actions (clears clutter; a single email is reachable by killing/deleting its one-member sender group, or via the flat view on finding tiles).
- The "+ N more not shown" note (from the 50-cap) stays at the bottom.
- Finding tiles (non-handled/triage) are unchanged: flat rows with per-row Delete/Kill/Delete-and-Kill.

### Acted state for cluster actions
`app.js`: a cluster bulk action, on success, marks **each member emailId** in that group into `ui.acted` (`{deleted}` / `{killed}` / both) — reusing the existing per-emailId acted rendering. So after "Delete all (33)", every row in that sender group dims + strikes with its badge and a per-row **Undo** (the existing `data-undo-acted`). No new acted-key scheme; the cluster handler expands to per-email acted entries. Undo of any row reverses just that email (restore / killlist-remove); the sender stays kill-listed until each killed row is undone (or simply remains kill-listed — config persists).

Cluster handlers parse the group's `emailIds` (from `data-ids`) and `sender` (from `data-sender`) and run the same `/messages/delete` / `/senders/killlist` endpoints (delete chunked by the daemon as today), routed through `confirmThen` (so the new failure-reset applies).

## Data Flow

```
A: handled.js → for actionable-category emails, looksAutomated(from) ? waiting++ : needsYou++
   → title "N need a reply or decision" (honest) + "+ M informational"; members unchanged.

B: renderDetailPanel(handled|triage) → group members by sender → per-sender header w/ bulk
   Delete/Kill/Delete&Kill (data-ids = group emailIds, data-sender = group from)
   → confirmThen → POST(s) → ui.acted[eachEmailId]={...} → rows dim + per-row Undo.
```

## Error Handling / Edge Cases

- Member with no `from` → grouped under an "(unknown sender)" cluster; its Kill/Delete-&-kill header buttons are disabled (no sender), Delete-all still works.
- Automated detection has no List-Unsubscribe for Outlook mail → falls back to the local-part regex (catches `noreply`/`notifications`/`alerts`), which covers the dominant senders; a non-obvious automated sender (e.g. `hello@…`) may still count as action — acceptable, tunable later.
- Cluster Delete-all on a large group is chunked by the existing daemon `makeDeleteFn` (argv-safe).
- A failed cluster POST resets the confirm (existing `confirmThen` failure path) and shows a notice.

## Rails (unchanged)

- A is a count/presentation change — no mail/config writes.
- B composes the existing soft-delete + config-only kill-list endpoints; no new connectors, no send/permanent-delete. Detail bodies remain read-only `textContent`.

## Testing

- `handled.test.js`: actionable-category email from a `noreply@` sender counts as `waiting`, not `needsYou`; a person sender stays `needsYou`; members still include both; counts/title reflect the split.
- `render.test.js`: a `handled`/`triage` item renders sender-group headers ("Sender (N)") with `data-delete`/`data-killlist`/`data-delkill` carrying the group's ids/sender; rows under a group have no per-row delete buttons; a non-handled (e.g. gateway) item still renders flat per-row buttons; "(unknown sender)" group disables kill.
- `contract.test.js`: app still handles all the data-attrs (no new ones needed — clusters reuse `data-delete`/`data-killlist`/`data-delkill`/`data-undo-acted`).
- Full suite stays green.

## Build Sequence (one plan, ~3 tasks)

1. **A** — `looksAutomated` demotion in `handled.js` + tests.
2. **B** — sender-clustered `renderDetailPanel` for handled/triage + per-cluster bulk buttons + `app.js` cluster handlers (expand to per-email acted) + styles + render/contract tests.
3. Full suite + manual smoke.
