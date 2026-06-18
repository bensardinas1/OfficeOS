# Panel Actions — Delete, Add to Kill List, Run Triage, Message Bodies — Design

**Date:** 2026-06-18
**Status:** Approved (design)
**Surface:** Ambient Proposal Panel (`daemon/`, `daemon/web/`)

## Problem

The panel is read-and-acknowledge plus the single `draft_chase` proposal. To make it act-in-able for inbox hygiene, the user needs to, from the panel: **read an email's body**, **soft-delete** emails, **add a sender to the kill-list**, and **run triage on demand** to surface junk to clean. These four asks form one workflow — *run triage → review what it flags (reading the body when needed) → trash the junk / kill-list the sender*.

## Goals

- Show each message's **body** in the Details panel.
- **Delete** button (soft-delete → recoverable trash) on every tile and every message row.
- **Add to Kill List** button (append sender to the permanent kill-list) on every tile and every message row.
- **Run triage** button that runs the existing triage connector on demand and surfaces its deletion candidates as a per-inbox "Cleanup" tile to act on in the panel.
- Keep the panel zero-dependency vanilla JS/CSS and preserve all existing behavior.

## Non-Goals

- No permanent deletion and no emptying of Trash/Deleted Items — ever, by any code path. That stays the user's manual action in their mail client.
- No auto-send.
- No new triage/classification logic — reuse `scripts/triage.js` as-is.
- No persistence of email bodies to disk (bodies are fetched on demand and kept transient).

## Decisions (resolved during brainstorming)

- **Two separate buttons**, not a combined "purge": **Delete** (move to Trash) and **Add to Kill List** (kill-list the sender). They are independent actions.
- **Add to Kill List is future-facing only** — it appends a rule so *future* mail from the sender auto-deletes on the next triage/tick. It does **not** trash the email currently in view; the user clicks Delete too if they want that now.
- **Run triage surfaces candidates in the panel** (a per-inbox "Cleanup" tile), where they can be Deleted / Kill-listed and their bodies read.
- **Delete / Kill List available everywhere** — every tile and every message row, across all job types.
- **Destructive actions use a two-click inline confirm** (button → "Confirm?"), because they sit on security/financial finding tiles too. No modal.
- **Bodies are fetched on demand** (not persisted), keeping `world-model.json` lean and email content off disk.

## Architecture

User-initiated commands get **direct API endpoints** (parallel to `/proposals/:id/approve`), each backed by an injected connector function wired in `daemon.js` exactly like `makeSaveDraftFn`. No new executor registry entries — these are commands, not staged proposals.

### New API endpoints (`daemon/api.js`)

| Method + path | Body / query | Behavior |
|---|---|---|
| `POST /messages/delete` | `{ account, emailIds: [...] }` | soft-delete each id via the delete connector; returns `{ trashed, failed }` |
| `POST /senders/killlist` | `{ account, sender }` | append an email-exact kill-list rule (guarded); returns `{ added: bool, reason? }` |
| `POST /actions/triage` | `{ account? }` (omit = all) | run `triage.js`, then trigger a tick; returns `{ ok, candidates: <per-account counts> }` |
| `GET /messages/:emailId/body` | `?account=` | fetch one message's body via the body connector; returns `{ body, isHtml }` |

All POST handlers validate `account` against the loaded accounts and return `400` on unknown account / missing fields. Errors return `200 { ok:false, error }` for the panel to surface inline (matching the existing approve-failure convention), except malformed requests which are `400`.

### New / reused connectors (`scripts/`)

- **Delete** — reuse existing `scripts/delete-emails.js` (Outlook → `move` to `deleteditems`) and `scripts/delete-gmail-emails.js` (Gmail → `trash`). Already rails-guard tested. `daemon.js` adds `makeDeleteFn(account)` choosing the script by provider, mirroring `makeSaveDraftFn`.
- **Kill list** — new `scripts/killlist-add.js <accountId>` reading a sender from stdin (JSON `{ sender }`). It loads `config/companies.json`, applies the **same guards as `promote-senders.js`** (`isProtectedSender`, correspondent set, `alreadyHasRule` dedup, and the `DEFAULT_RISKY` dual-use pattern), appends `{ type:"email", value:<lowercased sender>, label:"added from panel <ISO date>" }` to that account's `company.alwaysDelete`, and `atomicWrite`s the file. Refuses (no write) with a reason when guarded. Pure selection logic extracted to a testable `addSenderToKillList(cfg, accountId, sender, opts)` returning `{ cfg, added, reason }`; the CLI persists.
- **Triage** — reuse `scripts/triage.js` (already writes `data/pending-deletions.json`). `daemon.js` adds `runTriageFn(accountId?)` shelling it via `runProcess` (async, non-blocking).
- **Body** — new `scripts/fetch-message.js <accountId> <messageId>` returning `{ id, body, isHtml }`. Outlook: Graph `GET /me/messages/{id}?$select=body` (strip to text via the existing `stripHtml` from `fetch-emails.js`). Gmail: `messages.get` format `full`, decode the text/plain (or stripped text/html) part. Read-only.

### Triage candidates as a job (`daemon/normalizers/triage.js`)

A new normalizer (registered in `daemon/normalizers/index.js`) emits one per-account **Cleanup** item:

- Reads `data/pending-deletions.json` (the file `triage.js` writes). The plan confirms the exact on-disk shape; the normalizer maps each candidate to a member `{ emailId, subject, from, fromName, receivedAt, reason }`.
- Item shape: `{ id: "<account>:triage", jobType: "triage", account, title: "<N> to clean up" (or "Nothing to clean up"), status: "ok" (never inflates "need you"), group: { rootCause: "cleanup", members:[...] }, source: [], proposedActions: [], lastChanged: null }`.
- Status is always `ok` (like `handled`) — junk isn't "at risk." The count lives in the title; the members are the actionable rows.
- Config: a `triage` block under each account type's `jobTypes` in `config/account-types.json` (gitignored, hand-edited by the operator). Absent config = job not run for that type.

### `daemon.js` wiring

`createApiServer` deps gain `deleteFn`, `killlistFn`, `runTriageFn`, `fetchBodyFn`, plus `accounts` (for validation) and an `onTriage` callback to trigger a tick after a triage run. Each fn is built per the provider, reusing `runProcess`. The triage run and a follow-up tick are fire-and-forget with progress emitted over SSE.

## Data Flow

```
Run triage button → POST /actions/triage → runTriageFn → scripts/triage.js
  → writes data/pending-deletions.json → tick → triage normalizer reads it
  → Cleanup item (members = candidates) → panel renders tile + Details rows

Details opens → GET /messages/:id/body → fetch-message.js → body shown (lazy)

Delete button → POST /messages/delete {account, emailIds} → delete-*.js → Trash
Add to Kill List → POST /senders/killlist {account, sender} → killlist-add.js
  → company.alwaysDelete += rule (guarded) → future mail auto-deletes next triage
```

## UX (`daemon/web/`)

- `render.js`:
  - Tile actions gain **Delete** and **Add to Kill List** buttons (`data-delete`, `data-killlist`) carrying the account + the target email ids / sender. On a tile, Delete targets all member `emailId`s; kill-list uses the **most-common member `from` email address** (never the display name — `owed_risk`'s `primarySender` is a vendor label, so the address must come from `member.from`). When members span more than one sender address, the tile-level kill-list button is disabled and the user kill-lists per-message in Details instead.
  - Detail panel: each message row gains its own **Delete** / **Add to Kill List** (targeting that one `emailId` / that message's `from`) and a **body** region that the panel fills after a lazy `GET /messages/:id/body`.
  - Header gains a **Run triage** button (`data-run-triage`), plus a per-section Run-triage affordance.
  - Destructive buttons render a **two-click confirm**: first click swaps the button to a "Confirm?" state (`data-confirm-delete` / `data-confirm-killlist`); second click within the same render fires the request. Any other click resets it.
- `app.js`:
  - New handlers for `data-delete` / `data-killlist` (with the confirm two-step), `data-run-triage`, and detail-body lazy fetch on panel open. POST then `load()`; show inline result/toast on failure or guard-refusal.
  - Run triage sets a "running" UI flag (disables the button, shows a spinner) until the response returns.
- `styles.css`: button variants (danger for Delete, warning for Kill List), confirm state, body block (mono-ish, scrollable, max-height), spinner.

## Error Handling / Edge Cases

- **Unknown/again-deleted message**: the delete connector already tolerates per-id failure (`failed` count); the panel reports "N trashed, M failed."
- **Kill-list refusal**: protected sender / correspondent / already-present → `{ added:false, reason }`, surfaced inline ("Not kill-listed: <reason>"); no config write.
- **Body fetch failure / not found**: detail row shows "Couldn't load body" rather than breaking the panel.
- **Triage already running**: the button is disabled while running; a second trigger is ignored.
- **Empty candidates**: Cleanup tile shows "Nothing to clean up" (status ok), or is omitted if the section is empty after filtering.
- **HTML bodies**: stripped to text before display; never rendered as HTML (no injection, consistent with `esc`).

## Rails (non-negotiable, enforced by tests)

- Delete paths only ever move to `deleteditems` / `trash`. No `DELETE`, `messages.delete`, `batchDelete`, or trash-emptying — the rails-guard connector test is extended to the new delete invocation and the body/killlist connectors.
- Add to Kill List performs a **config write only**; it never calls a delete or send API.
- Run triage is read-only plus the candidate-file write.
- No code path sends mail.

## Testing

- **Pure units**: `addSenderToKillList` (guards: protected/correspondent/risky/dedup; happy-path append shape); `triage` normalizer (candidates JSON → Cleanup item, empty case, member mapping); `render` of Delete/Kill-list buttons + the two-click confirm state; detail body region render (escaping, loading, error); body-connector arg shape.
- **API endpoint tests** (injected fns, no real network): `/messages/delete` (calls deleteFn with ids, returns counts), `/senders/killlist` (calls killlistFn, surfaces refusal), `/actions/triage` (calls runTriageFn + triggers tick), `/messages/:id/body` (calls fetchBodyFn), plus 400s on bad input.
- **Rails-guard**: extended `scripts/test` guard asserting `fetch-message.js`, `killlist-add.js`, and the delete dispatch contain no send/permanent-delete calls.
- Full suite stays green.

## Build Sequence (separate implementation plans)

1. **Plan A — Message bodies in Details**: `fetch-message.js`, `GET /messages/:id/body`, `daemon.js` `fetchBodyFn`, detail-panel lazy body + styles + tests. Independent and immediately useful.
2. **Plan B — Delete + Add to Kill List**: `killlist-add.js` + `addSenderToKillList`, `makeDeleteFn`, `POST /messages/delete` + `POST /senders/killlist`, tile/message buttons + two-click confirm, rails-guard extension, tests.
3. **Plan C — Run triage + Cleanup surface**: `triage` normalizer + config, `runTriageFn` + `POST /actions/triage` + tick trigger, Run-triage button + running state, tests.

Each plan produces working, testable software on its own; B and C build on the action plumbing but A ships alone.
