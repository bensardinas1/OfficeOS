# Unified Mail Connector Layer (Cluster B1) — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorm complete)
**Context:** Four divergent email-fetch implementations exist (`scripts/fetch-emails.js`
paginated Outlook CLI, `scripts/fetch-gmail.js` Gmail CLI hard-capped at 100 with no
pagination, `scripts/triage.js`'s private fetchOutlook/fetchGmail pair, and
morning-brief/daemon shelling the CLIs). Divergence already caused a real bug (triage's
`.top(50)` silently undercounting long windows). Mutating connectors are CLI-only, so the
daemon shells a subprocess per 20-id chunk and regex-scrapes stdout — slow on the click
path and blind to per-id failures. Bulk deletes operate on client-rendered ID lists, so
"Delete all" on a capped 50-member tile deleted 44 of 192 matching emails. This cycle
makes one library the single way to touch mail, moves the daemon in-process, adds
intent-level delete-by-sender, and folds in the Cluster A audit-semantics backlog.

**Decisions locked during brainstorm:**
- Cluster B ships as two cycles; this spec is B1 (connector layer). B2 (panel
  multi-select bulk actions) follows in its own spec, built on B1's endpoints.
- `deleteBySender` default window = 30 days (720h); server caps any requested window at
  1 year (8760h).
- The drill-in's per-sender "Delete all" button switches to the delete-by-sender query
  in B1 (row-level and tile-level buttons stay ID-based).
- Approach A chosen: shared library + thin CLI shims (over daemon-only consolidation or
  a persistent connector service).

---

## Component 1 — `scripts/mail.js`: the one way to touch mail

Exported async functions. All take the **account object** (from `config/companies.json`)
first, not an account id — callers already hold it, and it carries `provider`/`myEmail`.
Auth clients are cached per account id within the process (Graph token cache /
Gmail OAuth reused across calls).

- `fetchMail(account, {hours = 24, folder = "inbox", max = 200, bodyChars = 0})`
  → array of the existing unified email shape (`id, threadId, subject, from, fromName,
  received, receivedAt, isRead, importance, hasAttachments, preview,
  hasListUnsubscribe, precedence, toRecipients, ccRecipients, gmailCategories`, plus
  `body` when `bodyChars > 0`).
  - Outlook: `$filter receivedDateTime ge <since>`, `$orderby desc`, pages via
    `@odata.nextLink` until `max` (page size `min(max, 1000)`).
  - Gmail: `q = in:inbox after:<epoch>`, **paginates via nextPageToken** until `max`
    (fixes today's silent 100 cap); metadata fetched in concurrent batches of 50;
    `folder` ignored (labels, not folders) as today.
- `deleteEmails(account, ids)` → `{trashed, failed, failedIds}`.
  Outlook: `POST /me/messages/{id}/move destinationId: "deleteditems"` per id.
  Gmail: `users.messages.trash` per id. Per-id try/catch; failed ids collected.
- `restoreEmails(account, ids)` → `{restored, failed, failedIds}`.
  Outlook: move deleteditems → inbox. Gmail: `users.messages.untrash`.
- `deleteBySender(account, sender, {sinceHours = 720})` →
  `{matched, trashed, failed, emailIds, refused?}`.
  1. **Guards first**: `isProtectedSender` / correspondent checks from
     `scripts/sender-guards.js` — a protected sender returns
     `{matched: 0, trashed: 0, failed: 0, emailIds: [], refused: "<reason>"}` without
     querying anything (same rails as kill-list).
  2. `sinceHours` clamped to (0, 8760].
  3. Query **inbox only** for the sender within the window: Outlook
     `$filter from/emailAddress/address eq '<sender>' and receivedDateTime ge <since>`
     (paginated, hard cap 1000 matches per invocation); Gmail
     `q = in:inbox from:<sender> after:<epoch>` (paginated, same cap).
  4. Soft-delete the matches via the same per-id path as `deleteEmails`.
  5. Return the actual `emailIds` deleted — the audit log records them, so Undo/restore
     works identically to an ID-list delete.
- `fetchMessageBody(account, emailId)` → `{id, body}` (existing fetch-message behavior,
  including Gmail body extraction).

Provider dispatch lives inside each function (`account.provider === "gmail"`). Errors
propagate as thrown Errors (callers decide; the API layer already catches per-route).
For unit tests, the module accepts injected clients: each function reads its client via
an internal `getClient(account)` that can be overridden with
`_setClientFactoryForTest(fn)` (test-only export, name prefixed with underscore).

## Component 2 — CLI shims + consumer migration

- `fetch-emails.js`, `fetch-gmail.js`, `delete-emails.js`, `delete-gmail-emails.js`,
  `restore-emails.js`, `restore-gmail-emails.js`, `fetch-message.js` become thin shims:
  parse argv → resolve account from config → call the `mail.js` function → print the
  same stdout format they print today (`Done: N trashed…` etc. — skills and any
  scripts parsing them keep working). `stripHtml` stays exported from wherever it lives
  after the move (keep `fetch-emails.js` exporting it to avoid breaking importers).
- `scripts/triage.js`: delete its private `fetchOutlook`/`fetchGmail`; use
  `fetchMail(account, {hours, max: maxResults})`. CLI contract unchanged.
- `scripts/morning-brief.js`: its fetch path switches to `fetchMail` (in-process, no
  subprocess), preserving its existing email-shape expectations.

## Component 3 — Daemon in-process connectors

`daemon/daemon.js` replaces subprocess wiring with direct imports for: tick fetch
(`fetchMail`), `deleteFn` (`deleteEmails`), `restoreFn` (`restoreEmails`),
`fetchBodyFn` (`fetchMessageBody`), plus new `deleteBySenderFn` (`deleteBySender`).
Kill-list add/remove switch to importing `addSenderToKillList`/`removeSenderFromKillList`
directly (already exported). **Stays subprocess:** `triage.js` (heavy pipeline),
`save-draft` scripts, the `claude` reasoner. The fake-connector seam keeps the same
injected interface — `makeFakeConnectors()` gains `deleteBySenderFn` (canned:
`{matched: 3, trashed: 3, failed: 0, emailIds: ["f1","f2","f3"]}`); e2e otherwise
untouched. Subprocess helpers (`runProcess`) remain for the paths that still shell.

## Component 4 — Delete-by-sender endpoint + cluster button rewire

- **New route** `POST /senders/delete-all` body `{account, sender, sinceHours?}`:
  validates account + sender (400 otherwise), clamps `sinceHours` (default 720, max
  8760), calls `deleteBySenderFn`, appends an audit entry — action `delete`, with the
  returned `emailIds` and a `bySender: sender` field — and returns
  `{...result, entryId}`. A guard refusal returns the `refused` reason (no audit acted
  contribution since `emailIds` is empty).
- **Panel**: the drill-in's per-sender "Delete all" button posts to
  `/senders/delete-all {account, sender}` instead of `/messages/delete` with the
  rendered ID list. Its confirm flow, busy state, and notice ("Moved N to Trash")
  are unchanged; acted rows derive from the returned emailIds via the audit log on the
  next `load()` (rows not currently rendered simply aren't shown — correct). Row-level
  and tile-level Delete buttons keep their ID-list behavior.

## Component 5 — Audit semantics fixes (Cluster A deferred backlog)

- **Per-row undo accounting** in `deriveActed`: a restore entry with `undoOf` now
  neutralizes only the emailIds it lists (set intersection); the referenced delete
  entry stops contributing a given emailId once any later restore covers that id. The
  old whole-entry `undone` set is removed. (Undoing 1 of 12 un-dims 1, not 12.)
- **Failed deletes don't mark acted**: entries whose `result.failedIds` includes an id
  don't contribute that id; entries with `result.trashed === 0` (and no legacy shape)
  contribute nothing. Legacy entries without `failedIds` keep today's behavior.
- **`withAudit` helper** in `daemon/api.js`: one function wraps the
  validate → execute → append → respond shape shared by the five (now six) mutating
  routes; behavior byte-compatible with today's responses.
- **`entryId` omitted when the audit write didn't persist** (`entry.persisted ===
  false`) — the client then treats the action as session-only instead of
  server-backed (prevents the acted dim silently vanishing on the next load).

## Component 6 — Rails & testing

- `daemon/executors/rails-guard.test.js` (and the connector rails-guard) extend to
  `scripts/mail.js`: must reference only move-to-deleteditems / `messages.trash` /
  `untrash` verbs; the strings `permanentDelete`, `batchDelete`,
  `users.messages.delete`, and any send-mail API fail the build. `deleteBySender`
  must call the sender-guards module (asserted by test).
- `scripts/mail.js` unit tests use injected fake clients: Outlook + Gmail pagination
  (multi-page, cap), per-id failure collection, deleteBySender guard-refusal path,
  window clamping, provider dispatch.
- `deriveActed` per-row undo + failed-id semantics fully unit-tested (including legacy
  entry shapes).
- API tests: new route validation/audit/entryId; `withAudit` behavior parity for
  existing routes (existing tests must pass unchanged).
- Full suite + `npm run test:e2e` green. Live verification (real cluster delete-all →
  Graph query confirms; Undo restores) stays operator-side.

## Out of scope (B2 and later)

- Panel multi-select + bulk Delete / Kill / Delete-and-Kill / Undo bar (B2).
- Kill button `data-ids` (B2, with the bulk-bar rewire).
- Handled-count tuning, config validator (Cluster C).
