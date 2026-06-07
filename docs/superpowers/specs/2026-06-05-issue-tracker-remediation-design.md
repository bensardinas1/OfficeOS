# Issue Tracker Remediation — Design Spec

**Date:** 2026-06-05
**Status:** Approved by user (section-by-section); ready for implementation planning
**Source:** Findings from `docs/superpowers/reports/2026-06-04-it10-smoke-test-aar.md` (IT-10 bootstrap smoke test)
**Builds on:** `docs/superpowers/specs/2026-05-27-issue-tracker-design.md` (the shipped issue tracker, on master `91554b1`)

## Problem

The IT-10 bootstrap smoke test passed end-to-end and honored every safety invariant (zero trashed on cold-start, draft saved but never sent). But it surfaced two trust-critical findings and a cluster of helper/contract gaps:

- **F-2 (High):** the classify→bundle→records bridge is hand-scripted each session. During the test this produced a silent mis-keying — issues attached to the *wrong emails* — and `issue-apply.js` reported a plausible result with no error, because every msgid was individually valid; only the *associations* were wrong. Caught by luck, not by the system.
- **F-1 (High):** `issues.md` cold-start says "everything new lands provisional," but the applier auto-promotes multi-email/actioned topics to *real* (`group.recs.length < 2 && !firstWithAction`). 6 issues bypassed the provisional review the bootstrap promises.
- **F-3/F-5/F-6/F-7 (Med):** connector I/O contracts undocumented; fetch window unit is hours (skill says days); fetch caps (50 Outlook/acct, 100 Gmail) **silently truncate** the window; `emailsById` schema (needs `account`) had to be reverse-engineered.
- **F-8/F-11 (Med):** `drafts-index.json` has no schema/helper; `findByAlias` is real-only and failed to resolve a provisional alias.
- **§4.3 (cost):** noise reached the expensive reasoner step that deterministic layers could have removed — 12 identical Defender alerts, exact-duplicate emails, booth-blast marketing, WordPress test-store/moderation spam.

## Design philosophy (the frame this remediation is built on)

**Cost is a proxy for design effectiveness.** A well-designed system is cheap because it isn't wastefully reasoning over noise — not because we truncated. Two corollaries drive every decision below:

1. **No processing caps.** Caps hide design problems *and* reintroduce incomplete information — the exact failure this whole project exists to escape. The only legitimate bound is the **time window** (completeness-preserving: everything *in* the window is processed; you just choose how wide). Capping what reaches the *reasoner* drops processing and is rejected. (Presentation caps on human-facing output — e.g., morning-brief's 25-decision cap — are fine; they don't drop processing.)
2. **Cost is reduced at the source and measured.** The lever is stronger *deterministic* pre-filtering (explicit rules, dedup, collapse) so the reasoner sees only genuinely ambiguous items. A **funnel report** attributes cost at every tier, turning "cost as proof of design effectiveness" into an actionable feedback loop: high reasoner load is a signal to strengthen a deterministic layer, not a number to cap.

**Data-preservation invariant (the inverse of the cap risk):** dedup/collapse changes *how often the reasoner thinks*, never *what mail exists*. The only path that deletes is a user-approved `alwaysDelete`/`scamPattern` rule. Over-collapse is bounded by exact-subject matching and same-sender-only batching.

## Locked decisions

| Decision | Choice |
|---|---|
| Scope | Two High findings (F-1, F-2) + the helper that subsumes the Med contract gaps (`build-bundle.js`) + the two cheap correctness helpers (F-8, F-11); §4.3 cost mechanism promoted to **core**; cost-tuning measured, not guessed |
| Large-window handling | **Full pagination** (no silent truncation); **no reasoner cap**; cost controlled by deterministic reduction-at-source + measured via funnel |
| Dedup/collapse safety | **Collapse the reasoning *unit*, never drop the *data*** (Q3-A). Dropping only via user-approved rules. |
| `alert-batch` threshold | N = 4 (configurable constant) |
| Cold-start | bootstrap `forceProvisional = true` (everything provisional → user sweeps); steady-state keeps the auto-promote heuristic |
| Coordination | work on `feature/issue-tracker-remediation` off master; don't touch the parallel session's `docs/it10-smoke-test-aar` branch or its AAR |

## Non-goals (this pass)

- Render helpers for status/drill-in (F-10), ESM CLI wrappers for lifecycle verbs (F-9) — deferred.
- Changing `classify-emails.js` internals — dedup lives in a new `collapse.js`, not buried in classify.
- Auto-dropping any noise class — new noise classes surface as proposals through the existing approve loop.
- The unbounded-survivors backlog item is resolved *by philosophy* here (reduction-at-source + funnel), not by a cap.

## Architecture & components

### New — `scripts/`

**`build-bundle.js`** — the bridge that codifies what the runner hand-scripts. CLI:
```
node scripts/build-bundle.js --since <ISO|Nd|Nh> [--accounts a,b,c] [--out <path>]
```
For each account, concurrently: paginated fetch → `classify-emails.js` → derive survivors + heuristic-candidates → `collapse.js` → emit `{ generatedAt, window, bundle, emailsById, funnel }` JSON to `--out` (default `data/.last-run-bundle.json`) and print the **funnel** to stdout. This is the single artifact the reasoner consumes — no hand-assembly, eliminating F-2's index-mismatch error class. Resolves F-2, F-3, F-5, F-6, F-7.

**`collapse.js`** — pure, deterministic, no I/O, unit-testable. Input: the survivor/candidate list. Output: reasoning groups `{ id, kind: "exact-dup"|"alert-batch", representativeMsgid, memberMsgids[] }`. Every member is retained; only judgment is grouped.

### Modified — `scripts/`

- **`issue-apply.js`**: add `forceProvisional` option + `--force-provisional` CLI flag (F-1); add stderr validation (warn when a record's msgid ∉ `emailsById`; warn when a NEW title collides with an existing real slug) (F-2); make the default report **compact** (counts + slugs), full msgid arrays behind `--verbose` or a `--report <file>` sidecar (kills §4.2 token waste).
- **`issue-store.js`**: add `findIssue(issuesDir, alias)` unioning real + provisional, real-wins-on-collision (F-11); add `loadDraftsIndex` / `saveDraftsIndex` with a defined schema (F-8).

### Modified — skills/docs

- **`.claude/commands/issues/issues.md`**: bootstrap calls `build-bundle.js` then applies with `--force-provisional`; reconcile the "everything lands provisional" wording (true for bootstrap, heuristic-promotion documented for steady-state); document connector I/O by pointing at `build-bundle.js`.
- **`_reasoner-pass.md`**: note collapsed groups — judge the representative once, then emit per-member records by copying the representative's verdict.

### Decomposition rationale

`build-bundle.js` is the orchestrator (I/O, fetch, sequencing); `collapse.js` is a pure function (testable without network). Keeping the risky cost-mechanism (collapse) as a pure module means it's densely unit-tested in isolation; the orchestrator stays thin.

## `build-bundle.js` — data flow & output

### Pagination (resolves F-6 — completeness, not truncation)
- Outlook: page `/me/messages` via `@odata.nextLink` until `receivedDateTime < since`.
- Gmail: page `users.messages.list` via `pageToken` until exhausted for `after:<since>`.
- Accounts fetched concurrently (bounded `Promise.all`) — removes the AAR's sequential-fetch wall-clock bottleneck.

### Output shape
```json
{
  "generatedAt": "2026-06-05T...",
  "window": { "since": "...", "perAccountHours": { "brickellpay": 720, ... } },
  "bundle": [
    { "msgid": "...", "account": "brickellpay", "tag": "survivor",
      "from": "...", "fromName": "...", "subject": "...", "preview": "...",
      "receivedAt": "...", "hasListUnsubscribe": false,
      "group": { "id": "g3", "kind": "alert-batch", "isRepresentative": true, "size": 12 } }
  ],
  "emailsById": { "<msgid>": { "id": "...", "account": "brickellpay", "from": "...", "fromName": "...", "subject": "...", "receivedAt": "..." } },
  "funnel": {
    "fetched": 540,
    "explicitDropped": 310,
    "survivors": 135,
    "heuristicCandidates": 95,
    "collapsed": { "groups": 78, "fromMembers": 230, "savedJudgments": 152 },
    "reasoningUnits": 78,
    "perAccount": { "brickellpay": { "fetched": 200, "explicitDropped": 120, "survivors": 50, "heuristicCandidates": 30 } }
  }
}
```
`emailsById` carries `account` structurally (the F-7 / Critical-seam fix). Non-representative group members appear in `emailsById` (so they can be linked) but are flagged in `bundle` so the reasoner judges only representatives.

### The funnel (cost-as-effectiveness instrument)
Printed compact to stdout every run:
```
fetched 540 → explicit-dropped 310 → 230 to-reason (135 survivors + 95 candidates) → collapse 230→78 units → reasoned 78
```
**Collapse spans BOTH survivors and heuristic-candidates** — the reasoner judges both (survivors → assign-to-issue; candidates → rescue-or-confirm-noise), and identical batches occur in both populations (e.g., the 12 Defender alerts are heuristic-candidates). So `reasoningUnits` = the post-collapse total reasoner judgments across both populations, and `funnel.collapsed.fromMembers` / `savedJudgments` count across both.

Reconciliation guardrail: `fetched = explicitDropped + survivors + heuristicCandidates` (everything fetched is either explicitly dropped, kept as a survivor, or deferred to the reasoner as a heuristic candidate; protected senders count as survivors). The load test reads the funnel as the design-effectiveness verdict.

**R-reduction invariant (confirmed empirically, 2026-06-07 load test).** Because collapse spans both survivors and candidates, **R (reasoningUnits) moves ONLY via explicit-drop and collapse** — never by reclassifying an email between the survivor and candidate lanes. Lowering the bulk-signal threshold shuffles mail survivor↔candidate, but both lanes are inside the set collapse reasons over, so it does not change R (it is a *correctness* fix — right default disposition — and a *prerequisite* for cost reduction, since reclassified bulk mail becomes promotable to `alwaysDelete`). To actually reduce R: approve `alwaysDelete`/`scamPatterns` (removes mail pre-collapse) or improve collapse grouping. See `docs/superpowers/reports/2026-06-07-load-test.md`.

## collapse.js — grouping rules (conservative)

1. **`exact-dup`**: emails with identical normalized `(fromAddress, subject)` AND near-identical preview (first ~200 chars after whitespace/URL normalization). Cross-account included. Subject must match exactly (normalized) — different subjects from the same sender never merge.
2. **`alert-batch`**: ≥ 4 emails from the *same sender address* sharing a subject *template* (trailing IDs/numbers/dates stripped → same skeleton). Same-sender only; cross-sender never groups.

Everything else → its own reasoning unit. When in doubt, do not group (an un-collapsed email costs one judgment; a wrongly-collapsed one loses signal — never trade that way).

### Reasoner handling (`_reasoner-pass.md`)
The bundle marks representatives. The reasoner judges only representatives (one judgment per group), then emits per-msgid records by copying the representative's verdict to every member msgid. `issue-apply.js` stays per-msgid and unchanged. The saving is in *judgments made* (the expensive part), quantified by `funnel.collapsed.savedJudgments`.

### Noise-class proposals (§4.3, no auto-drop)
When `collapse.js` produces an `alert-batch` (or `build-bundle` detects a recurring template that resolved to noise), `build-bundle.js` surfaces a **proposed `alwaysDelete`/`scamPattern`** via the existing `data/proposed-rules.json` + `apply-proposals.js` loop — the same one-click-approve mechanism. Only after approval does the class move to the deterministic explicit tier. Nothing is auto-dropped.

## F-1 — bootstrap force-provisional

- **Bootstrap (cold start):** `forceProvisional = true` → every new issue lands provisional regardless of email count or action; the user sweeps (`graduate`/`merge`/`ignore`). Matches the documented cold-start contract.
- **Steady-state (normal runs):** the existing heuristic (`≥2 emails or a next_action → real`) stays, documented as intentional.
- **Mechanism:** `applyReasonerOutput(records, emailsById, { issuesDir, now, heuristicMsgids, forceProvisional = false })`; `--force-provisional` CLI flag; `issues.md` cold-start applies with it; wording reconciled. Default `false` → existing 237 tests unaffected.

## Targeted helpers

### `findIssue(issuesDir, alias)` (F-11)
Unions `loadIssues` + `loadProvisional`, then `findByAlias`. If an alias matches both a real and a provisional issue, prefer the real and note the collision. `/issues` drill-in and verbs use it so provisional aliases resolve (the smoke test's `cxn` failure).

### drafts-index schema + helpers (F-8)
Reconciles the original morning-brief intent (a map keyed by source message-id for re-draft idempotency). Schema:
```json
{ "<accountId>:<sourceMsgid>": { "draftId": "...", "issue": "<slug>", "preview": "...", "savedAt": "ISO" } }
```
`loadDraftsIndex(path)` / `saveDraftsIndex(path, obj)` (atomic). The `/issues` draft verb records here after each save and skips re-drafting when the key already exists.

### applier hardening (rest of F-2 + §4.2)
- stderr `console.warn` on unknown msgid and on NEW-title/real-slug collision.
- compact default report; full arrays only behind `--verbose` / `--report <file>`.

## Testing

**Deterministic layer — dense coverage:**
- `collapse.js`: exact-dup grouping (incl. cross-account; different-subject-same-sender does NOT merge); alert-batch (≥4 same-sender+template groups; 3 does not; cross-sender never); representatives flagged; all members retained.
- `build-bundle.js`: injected fetch/classify deps (morning-brief test-harness pattern) — pagination assembles the full window past 50/100; `emailsById` carries `account`; funnel counts reconcile; output shape matches reasoner/applier expectations.
- `issue-apply.js`: `forceProvisional:true` makes a 2-email actioned group land provisional; stderr warn on unknown msgid; compact vs `--verbose` report.
- `issue-store.js`: `findIssue` unions real+provisional with real-wins-on-collision; drafts-index round-trip + re-draft skip.
- Golden: extend the SEAA fixture so a collapsed alert-batch flows bundle→reason→apply correctly.

**Second smoke test = deliberate load test (validation, user-run):**
- Wider window (~30 days), full pagination on, so it pulls real volume (not the capped 50/100 of IT-10).
- **Pass = the funnel proves design effectiveness:** most of `fetched` removed by the deterministic tiers (explicit-dropped + collapse); `reasoningUnits` a small fraction of `fetched`. High `reasoningUnits` is the funnel doing its job — pointing at which deterministic layer leaks (a follow-up signal, not a failure).
- Re-confirm safety at scale: bootstrap trashes nothing; nothing sent.
- Output: AAR appendix with the funnel numbers — the empirical cost-effectiveness baseline.

## Coordination & sequencing

- Work on `feature/issue-tracker-remediation` (branched off master `91554b1`). The plan's first step does `git fetch` and rebases onto the latest `origin/master` in case the parallel session's `docs/it10-smoke-test-aar` branch (AAR + bulk-signal docs + gitignore) has merged in the interim.
- Do not modify `docs/superpowers/reports/` (parallel session's AAR).
- Merge to master via PR (or local merge) only after confirming the parallel session has finished, to avoid stepping on shared-working-tree state.

## File structure summary

**Create:**
- `scripts/build-bundle.js` + `scripts/test/build-bundle.test.js`
- `scripts/collapse.js` + `scripts/test/collapse.test.js`
- fixtures: extend `scripts/test/fixtures/issues.js` (collapse + bundle cases)

**Modify:**
- `scripts/issue-apply.js` (forceProvisional, stderr validation, compact report) + tests
- `scripts/issue-store.js` (findIssue, drafts-index helpers) + tests
- `.claude/commands/issues/issues.md` (bootstrap force-provisional, build-bundle, doc reconcile)
- `.claude/commands/issues/_reasoner-pass.md` (collapsed-group handling)

**New runtime data (gitignored):** none beyond what exists (`data/.last-run-bundle.json` already used; `data/drafts-index.json` now schema'd).

## Open questions

None. All decisions locked.
