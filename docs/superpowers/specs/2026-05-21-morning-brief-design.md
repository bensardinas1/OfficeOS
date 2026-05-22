# Morning Brief — Design Spec

**Date:** 2026-05-21
**Status:** Approved by user; ready for implementation planning
**Supersedes:** The triage workflow described in `memory/project_triage_state_2026-05-07.md`

## Problem

The current OfficeOS email workflow has plateaued. Across roughly eight triage sessions over three weeks, four of the last five sessions ended in "delete all" or "delete all except 2-3" — meaning the deletion list is essentially correct but the user still reviews 100-200 numbered items per session to confirm. The same memory rules get manually re-applied every session (eBay transactional kept, FIU SigEp newsletter kept, Castillo Rodney kept, Summit Annual Report scam moved to deletion, PayPal "You've got money" kept). Action items surface and evaporate. Drafts are never produced. The user stopped running the system days ago out of frustration, and inboxes are now badly backed up.

The root cause is the *interaction loop*, not the rules. The system today is a classifier wrapped in a confirmation prompt. It does not:

- Auto-handle the noise floor it has implicitly been authorized to delete.
- Draft replies for action-shaped emails.
- Persist action items to disk so they survive past a single session.
- Surface recurring patterns (auto-trash candidates, scam patterns from rotating domains) for one-click adoption.
- Provide context aggregations (active travel, ongoing decisions) that span emails.

## Goal

Replace the "run triage, review numbered list, approve deletes" loop with a single autonomous skill — `reports:morning-brief` — that does triage + drafting + task capture + pattern discovery in one pass and emits a single Markdown brief. The brief is the only thing the user reads. Everything else either succeeds silently or surfaces in the brief.

The skill is designed to be invoked in three places without code changes:

1. Locally via Claude Code: `/morning-brief` (default 24h window).
2. As a scheduled local task (via `scheduled-tasks` MCP / cron) firing each morning.
3. As a Cowork remote agent later — same skill, same artifacts.

The skill is the data layer for a future Cowork-rendered surface. Building the Markdown brief first means a future richer renderer is a UI swap, not a re-architecture.

## Non-goals

- **No auto-send.** The agent never sends email. Drafts are saved to mail-account Drafts folders; sending is always a human action in the mail client.
- **No tier-3 autonomy.** The agent does not auto-accept calendar invites, auto-archive FYI confirmations on a timer, or auto-send approved-pattern replies. Reserved for after the system has earned a track record.
- **No rebuild of `classify-emails.js`.** The classification engine is sound; this spec extends it with two new fields and reuses it.
- **No new mail surface.** The brief lives as a Markdown file. Cowork-rendered review UI is a future increment.
- **No `data/trips/` folder in v1.** Travel context is a section of the brief, not a separate artifact. Promoted later if needed.

## Decisions locked in

| Decision | Choice |
|---|---|
| Overall direction | Rebuild for Cowork, starting via Markdown brief surface |
| Morning surface | Single `data/morning-queue.md` |
| Autonomy tier | Moderate — auto-delete noise floor, draft, capture, propose; never send |
| Auto-trash discovery | Durable opt-in (proposals approved into config) |
| Draft storage | Mail-account Drafts folder, via existing `save-draft.js` / `save-gmail-draft.js` |
| Drafting boundary | Always draft what's draftable (short reply expected, voice profile present) |
| Draft editing | Strictly in mail client |
| Catch-up | Parameter of same skill (`--since`, `--window`) |
| Memory ↔ config sync | Auto-write memory entry when proposal approved |
| Schema additions | `unless` on `alwaysDelete`; `scamPatterns` per account; memory→config backfill |
| Skill location | `.claude/commands/reports/morning-brief.md` |
| Deprecates | `orchestrators/triage` and `reports/daily-brief` |

## Architecture

### Layer roles (unchanged)

- **Layer 1 — Connectors and helpers (`scripts/`)**: existing connectors reused as-is — `fetch-emails.js`, `fetch-gmail.js`, `classify-emails.js`, `save-draft.js`, `save-gmail-draft.js`, `delete-emails.js`, `delete-gmail-emails.js`. Three new helper scripts (invoked by the skill via Bash, not "imported"; consistent with project convention that skills are Markdown templates):
  - `scripts/apply-proposals.js` — config patcher; atomic writes to `companies.json` / `account-types.json`; appends memory entries on approval.
  - `scripts/sender-history.js` — reads/updates `data/sender-history.json`; emits auto-trash proposals when thresholds cross.
  - `scripts/pattern-discovery.js` — scam-pattern detection + memory-backfill discovery; emits proposals to `data/proposed-rules.json`.
- **Layer 2 — Skills**: `.claude/commands/reports/morning-brief.md` is new. The skill prompt is the orchestration logic; it calls connectors and the new helpers.
- **Layer 3 — Orchestrators**: the new skill is the new orchestrator. It absorbs and replaces `orchestrators/triage` and `reports/daily-brief`.

### Memory ↔ config principle

Memory becomes the *journal of why a rule exists*. Config (`companies.json`, `account-types.json`) is the *enforcement*. After this work:

- No triage run should be re-applying memory rules as manual reclassifications.
- Approved rule proposals append a one-line memory entry (`memory/rule-<id>.md`) capturing the dated reason.
- Existing memory entries (`feedback_*.md`, `relationship_*.md`) stay in place; they get a "migrated to config on YYYY-MM-DD" note appended when their rule is approved during backfill discovery.

## Schema additions to config

### `unless` clause on `alwaysDelete` entries

Optional `unless` field. Applies only to `alwaysDelete`; `neverDelete` stays binary.

```json
{
  "type": "name",
  "value": "eBay",
  "label": "eBay marketing",
  "unless": {
    "subjectContains": ["delivered", "shipped", "out for delivery", "order", "security", "device", "message", "buyer", "seller", "feedback"]
  }
}
```

**Semantics in `classify-emails.js`:** if the sender matches AND `unless` is present AND any of its conditions fire, the rule does *not* apply. Case-insensitive substring match on subject.

`unless.subjectContains` is the only `unless` condition in v1. The field shape leaves room for future conditions (`unless.fromDomain`, `unless.hasAttachment`) without schema migration.

### `scamPatterns` field per account

New field at account level in `companies.json`.

```json
"scamPatterns": [
  {
    "label": "Annual Report filing scam (rotating third-party domains)",
    "subjectAll": ["annual report"],
    "senderAllowlist": ["sunbiz.org"],
    "action": "delete"
  }
]
```

**Semantics:** if subject contains *all* of `subjectAll` (case-insensitive) AND the sender domain is *not* in `senderAllowlist` → force the email into `ignore` (same effect as an `alwaysDelete` hit). `action: "delete"` is the only value in v1; the field is there so we can later add `"flag"` or `"quarantine"` without schema migration.

Lives on accounts, not on type defaults. Summit, Brickell Pay, and Healthcare M&A each own Florida entities and need the Annual Report scam pattern.

### Memory-rule migration (concrete additions)

| Target | Addition | Source |
|---|---|---|
| `healthcarema.neverDelete` | Juan Santamaria / `assuredinvestmentsrealty@gmail.com` ("John") | `memory/relationship_juan_santamaria.md` |
| `personal.neverDelete` | `equinox.com` domain | `memory/feedback_equinox_account.md` |
| `personal.neverDelete` | `avc@fiusigepalumni.ccsend.com` (FIU SigEp Alumni newsletter) | `memory/feedback_fiu_sigep_newsletter.md` |
| `personal.neverDelete` | Castillo, Rodney (AANHPI / AAAB contact) | `memory/relationship_rodney_castillo.md` |
| `personal.alwaysDelete` | Replace plain `"eBay"` entry with the `unless`-conditional version | `memory/feedback_ebay_transactional.md` |
| `personal.alwaysDelete` | Replace plain `"PayPal"` entry with `unless.subjectContains: ["you've got money", "you received", "payment received", "payment confirmation", "receipt for your payment", "refund"]` | Implied by triage-log reclassifications |
| `summitmiami.scamPatterns` | Annual Report filing scam | Multiple triage-log entries |
| `brickellpay.scamPatterns` | Annual Report filing scam | Triage-log entry for "DUE FRIDAY: Brickell Payments LLC Annual Report" |
| `healthcarema.scamPatterns` | Annual Report filing scam | Triage-log pattern |

These can be added directly by the first catch-up run's backfill discovery (see below) or by hand-editing `companies.json` before the first run. Either path is fine; the first run is `--dry-run` regardless.

## Data layer

All under `data/` (gitignored).

### Pre-existing

- `data/triage-log.md` — append a structured entry per run (window, autonomous deletes per account, drafts saved, tasks captured, patterns proposed). Audit trail.
- `data/tasks.md` — actively written. Each task line carries priority + source link + embedded message-id for idempotency: `- [P1] Respond to URGENT Schedule 1 — Levy Harris, 2026-05-05 <!-- msgid:AAMkAGI... -->`
- `data/pending-deletions.json` — retained for compatibility. New flow writes far less to it; deletions happen autonomously inside the run, and staging is only used for items the brief surfaces as "delete-on-approval."

### New

- `data/morning-queue.md` — the brief. Regenerated fresh each run; previous brief moves to `data/archive/morning-queue-<timestamp>.md`.
- `data/sender-history.json` — per-account, per-sender state for auto-trash discovery:
  ```json
  {
    "personal:noreply@bizjournals.com": {
      "deletedCount": 7,
      "lastDeletedAt": "2026-05-21T06:00:00Z",
      "hasListUnsubscribe": true
    }
  }
  ```
  Counter resets if the sender hits a `neverDelete` match or the user keeps an email from them.
- `data/proposed-rules.json` — pending rule proposals with stable IDs:
  ```json
  {
    "proposals": [
      {
        "id": "p-2026-05-21-001",
        "target": "companies.personal.alwaysDelete",
        "payload": { "type": "email", "value": "noreply@bizjournals.com", "label": "bizjournals (7 consecutive deletes)" },
        "reason": "7 consecutive deletes + list-unsubscribe + not protected",
        "proposedAt": "2026-05-21T06:00:00Z",
        "status": "pending"
      }
    ]
  }
  ```
  Re-proposing the same rule while a previous proposal is pending is a no-op.
- `data/drafts-index.json` — drafts the agent has created in mail-account Drafts folders. Maps source `message-id` → `{ account, draft-id, preview, createdAt, status }`. Prevents re-drafting the same email on overlapping windows. Draft body lives in the mail account, not here.
- `data/last-run-state.json` — last successful run timestamp + counts per account, used to compute the default window when `--since` / `--window` aren't supplied.

### Approval mechanism

In the brief, every proposal is numbered with its ID. User responds in chat:

> approve p-2026-05-21-001, p-2026-05-21-003; decline p-2026-05-21-002

The skill (or `scripts/apply-proposals.js`) patches the appropriate config file atomically, updates `proposed-rules.json`, and appends a memory entry per the memory↔config sync rule. No slash command needed for v1. `/approve-proposals` can be added later if the chat pattern stabilizes.

## The morning-brief run

When the skill fires, it executes these steps in order. Each step is testable in isolation.

### 1. Determine window

- Default: emails received since the last logged successful run (read from `data/last-run-state.json`).
- Override: `--since 2026-05-07` or `--window 14d`.
- If the computed window > 72h, switch to catch-up mode (see Catch-up below).

### 2. Fetch per account

- For each account in `companies.json`, call its provider's connector (`fetch-emails.js` for Outlook, `fetch-gmail.js` for Gmail).
- If a connector returns an auth error, skip that account and warn in the brief. Do not fail the whole run.

### 3. Classify per account

- Pass through `classify-emails.js` with the merged type-defaults + account config.
- Output: each email tagged with category (`action`, `respond`, `fyi`, `news`, `ignore`, plus personal categories) and a deletion-candidate flag.

### 4. Apply autonomous actions

- **Delete**: emails tagged `ignore` that hit `alwaysDelete` (including `unless` evaluation), `deletionPolicy.patterns`, or an approved `scamPatterns` heuristic. Logged but not surfaced in the visible part of the brief.
- **Capture**: every `action`-tagged email writes a task to `data/tasks.md` (priority inferred from urgency flags + sender; source = `[Subject](message-link)`). Idempotent — re-running on overlapping windows does not duplicate tasks (tracked by message-id in HTML comment).
- **Draft**: for emails matching draftable shapes (calendar invites, decline/approval-shaped replies, simple thread continuations, renewal decisions; ≤ ~3-sentence reply expected; `voiceProfile` exists for the account), invoke the LLM with the email body + thread context + voice profile → call `save-draft.js`/`save-gmail-draft.js` to save into the mail account's Drafts folder. Record the draft ID + 1-line preview in `data/drafts-index.json`.

### 5. Discover patterns

- Update `data/sender-history.json` with this run's deletions and keeps.
- **Auto-trash discovery**: for any sender that crossed `deletedCount >= 5` consecutive deletes AND had `list-unsubscribe` AND is not in `neverDelete`/`prioritySenders` AND has no pending proposal → stage a proposed `alwaysDelete` rule.
- **Scam-pattern discovery**: if ≥3 deletions in a 30d window match the same fuzzy subject pattern (3-gram overlap or template match) across ≥2 distinct sender domains, none of which are in any `neverDelete` for the affected account → stage a proposed `scamPatterns` entry with a suggested `subjectAll` and an initially empty `senderAllowlist` (user fills in legitimate domains on approval).
- **Backfill discovery (catch-up only)**: scan `memory/feedback_*.md` and `memory/relationship_*.md` for rules that don't have a corresponding config entry yet; stage proposals for each.

### 6. Assemble the brief

- Write `data/morning-queue.md`. Structure detailed below.

### 7. Log the run

- Append a structured entry to `data/triage-log.md`: window, counts per account, autonomous deletes, drafts saved, tasks captured, patterns proposed.
- Update `data/last-run-state.json`.

**Invariant:** the only step that surfaces output for human review is step 6. Everything else either succeeds silently or fails into the brief as a warning.

## Brief structure (`data/morning-queue.md`)

Same shape every run. Order is intentional: decisions → drafts → rules → context → digest → log → warnings.

```markdown
# Morning Brief — 2026-05-21 (window: 14d catch-up)

## Summary
- Healthcare M&A: 184 emails / 142 auto-deleted / 5 drafts / 8 actions / 2 rules proposed
- Brickell Pay: 97 / 78 / 2 / 4 / 1
- Summit Miami: 51 / 38 / 0 / 2 / 1
- Personal: 312 / 251 / 1 / 3 / 4
- Total: 644 processed, 509 auto-deleted, 8 drafts staged, 17 actions captured

## Needs your decision (17)
1. [HCMA / action] Levy Harris — "URGENT Schedule 1 Classification of HHC" (2026-05-05)
   - Sender: lharris@greenlightpayments.com
   - Why: urgency flag + first email in thread
   - Draft staged in HCMA Drafts (see #D1)
2. [BP / action] MS — "Past due invoice for Microsoft 365" (2026-05-07)
   - Suggested: pay or escalate to Karen
   - No draft (decision required first)
...

## Drafts staged for approval (8)
D1. To: lharris@greenlightpayments.com — Re: URGENT Schedule 1 — *"Levy, confirming we'll classify HHC under..."* [Open in HCMA Drafts]
D2. ...

## Proposed rules (8) — reply "approve p-... ; decline p-..."
p-2026-05-21-001 → `personal.alwaysDelete`: noreply@bizjournals.com (7 consecutive deletes + list-unsubscribe)
p-2026-05-21-002 → `summitmiami.scamPatterns`: Annual Report filing scam — subjectAll=["annual report"], senderAllowlist=["sunbiz.org"] (4 hits in 14d from 3 different domains)
p-2026-05-21-003 → `personal.neverDelete`: avc@fiusigepalumni.ccsend.com (backfilled from memory)
...

## Travel / event context
**Europe trip in progress (Italy / Austria / Hungary, ~2026-05-04 → 2026-05-20):**
- Trento: Avis pickup confirmed, Noleggiare review pending
- Vienna/Salzburg: ÖBB tickets, Belvedere ticket
- Budapest: Matthias Church, SimplePay charges €83.40
- Open: Noleggiare Trustpilot review form (not urgent)

## FYI digest (collapsed)
<details>
<summary>HCMA — 32 FYI emails</summary>
...
</details>

## Autonomous activity (collapsed)
<details>
<summary>509 emails auto-deleted</summary>
- 47 LinkedIn notifications
- 38 real estate listings
- ...
[Full log: data/triage-log.md @ 2026-05-21]
</details>

## Warnings
- Gmail MCP returned auth error for 2026-05-19 batch — re-run with `/morning-brief --since 2026-05-19` after reconnecting.
```

## Catch-up mode

Activated when the computed window exceeds 72 hours. Not a user-facing flag; the skill decides.

**What changes:**
- "Needs your decision" section capped at **25 items** total across all accounts. Priority order: `action` from priority-senders → `action` from anyone → `respond`. Overflow goes to a "Deferred — review when you have time" section at the bottom.
- Backfill discovery runs (memory → config proposals).
- Travel window stretches to 60 days instead of 30.
- Autonomous-delete log in the brief includes a count breakdown by category and top-10 sender domains for sanity-checking.
- Brief header notes: `(window: 14d catch-up)`.

**Safety guard for catch-up runs only:** drafts capped at **5 total** across all accounts. Other action items are flagged for response without drafts. Drafts can be filled in later with `/morning-brief --draft-only --since <date>` once the backlog is under control.

## Dry-run mode

`/morning-brief --dry-run`:
- Fetch + classify + pattern discovery as normal.
- **Skips** all writes: no deletes, no drafts saved, no tasks captured, no config patches, no log entries.
- Writes the brief to `data/morning-queue.dry-run.md` instead of overwriting the real brief.

Used after any non-trivial config edit until trust is re-established.

## Safety rails (non-negotiable)

1. **Never auto-send.** No code path in the skill calls a send-email function. Drafts only.
2. **`neverDelete` and `prioritySenders` always win** over `alwaysDelete`, `scamPatterns`, and `deletionPolicy.patterns`.
3. **No deletes during dry-run, ever.**
4. **All deletes are logged** with account, message-id, subject, sender, classification reason. Written to `data/triage-log.md`, not just summarized.
5. **Config writes are atomic.** Approving a rule proposal writes to a temp file and renames; never partial writes.
6. **One run at a time per account.** A run lock (`data/.lock-<account>`) prevents two scheduled runs colliding. Stale locks (>1h old) are broken.
7. **First-run safeguard.** If the skill has never been run before (no `data/last-run-state.json`), default to `--dry-run` and emit a banner in the brief saying "First real run — re-invoke without `--dry-run` after reviewing this dry brief."
8. **Soft-delete only — no permanent deletion, ever.** Every delete path must move messages to the provider's recoverable trash:
   - Outlook: `POST /me/messages/{id}/move` with `destinationId: "deleteditems"`. Never use `DELETE /me/messages/{id}`.
   - Gmail: `users.messages.trash({ userId: "me", id })`. Never use `users.messages.delete({...})` or `users.messages.batchDelete({...})`.

   This includes future connectors. The system cannot bypass the user's mail-client trash step. Emptying Deleted Items / Trash is the user's manual action in the mail client; the agent has no code path that can do it.

## Testing approach

### Unit tests (extend `scripts/test/classify-emails.test.js`)

- `unless` clause: eBay sender + "OUT FOR DELIVERY" subject → kept; eBay sender + "Deal Days" subject → deleted.
- `scamPatterns`: subject "Annual Report Filing Notice" from `flcorpfiling.com` → deleted; same subject from `sunbiz.org` → kept.
- Protection precedence: sender in `neverDelete` always wins, even with matching `alwaysDelete` and `scamPatterns`.

### Unit tests for new helpers (new files in `scripts/test/`)

- `apply-proposals.test.js` — idempotent config patcher, atomic writes, memory entry creation.
- `sender-history.test.js` — counter increments on delete, resets on keep, threshold-crossing fires proposal exactly once.
- `pattern-discovery.test.js` — auto-trash threshold (5+ + list-unsubscribe + not protected), scam-pattern threshold (3+ across 2+ domains in 30d), idempotency under repeated runs.

### Integration / golden-file tests

- Dry-run end-to-end: fixture inbox → brief produced; assert `sender-history.json`, `tasks.md`, `proposed-rules.json` unchanged.
- Catch-up cap: 50 action-tagged fixtures → brief has 25 in "Needs your decision," remainder in "Deferred."
- Backfill discovery: fixture memory entries with no corresponding config rules → proposals generated; entries already in config → no duplicate proposal.
- Brief golden file: fixed input → expected `morning-queue.md` (timestamps and IDs normalized).

### Manual smoke test (before trusting live runs)

1. `--dry-run` on real inboxes; eyeball the brief.
2. Approve 2-3 low-stakes proposals; verify `companies.json` patched correctly and memory entries created.
3. Live run with `--window 24h`; verify drafts land in Outlook/Gmail Drafts, `tasks.md` has new lines with message-ids, `triage-log.md` has the structured entry.

### Fixtures

Extend `scripts/test/fixtures/accounts.js`. Add `scripts/test/fixtures/morning-brief.js` for inbox snapshots and expected briefs.

## Out of scope (deferred to later increments)

- Cowork-rendered brief surface (UI swap on top of the same data).
- `data/trips/` per-trip files (currently a section of the brief).
- Tier-3 autonomy (auto-accept invites, auto-archive aged FYI, autosend approved patterns).
- `/approve-proposals` slash command (text chat approval is fine for v1).
- Multi-condition `unless` (only `subjectContains` in v1).
- Inline draft editing from the brief (mail-client editing only in v1).

## Open questions

None. All decisions are locked.
