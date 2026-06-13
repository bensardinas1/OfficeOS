---
description: Converse with your inbox as topic-based issues — status, drill-in, draft, and lifecycle verbs
allowed-tools: Bash, Read, Write, Edit
---

# Issues

> ⚠️ **Run in the main repo — never a git worktree.** This skill reads gitignored,
> machine-local files: `config/companies.json`, `config/account-types.json`, and the
> local OAuth token cache. A fresh worktree has none of them, so config/credential
> loading fails ("cannot read the live files"). Do **not** invoke `using-git-worktrees`
> or create a worktree for this skill — it is read-mostly ops (fetch → reason →
> soft-delete via API → drafts) and gains nothing from isolation.

Topic-based issue tracker over your accounts. Email feeds into issues; you converse
with issues. Terse by default — 1-3 lines unless asked for `more`.

## Input — `$ARGUMENTS`

- (empty) → **status view** of open issues.
- `more` → status view with provisional + snoozed expanded.
- `<alias>` or `<alias>?` → **drill-in** on one issue (3 lines).
- `<alias> more` → full drill-in (log + linked messages).
- `draft <alias>` → compose a context-aware reply, save to Drafts-OfficeOS.
- `done <alias>` / `snooze <alias> <when>` / `merge <a> <b>` / `ignore <prov-slug>` /
  `graduate <prov-slug>` → lifecycle verbs.
- `refresh` → force a fresh reasoner pass (fetch delta, assign) before answering.

## Load

```
cat config/companies.json
cat config/account-types.json
cat config/attention-profile.md
cat config/prefs.json
```

Issue files live in `data/issues/*.md` (real) and `data/issues/provisional/*.md`.
Use `scripts/issue-store.js` helpers for all reads/writes (never hand-edit issue files
from the prompt). Assignment state: `data/issue-assignment-state.json`.

## Cold-start (bootstrap)

If `data/issues/` has no `*.md` files (real or provisional), this is the first run:
1. Build the bundle for a wide window: `node scripts/build-bundle.js --since 30d --out data/.last-run-bundle.json`.
   This fetches (paginated, full window), classifies, collapses reasoning units,
   and prints the funnel to stderr. **It trashes nothing.**
2. Read `data/.last-run-bundle.json` → reason over the bundle per
   `_reasoner-pass.md` (judge representatives once; emit per-member records).
3. Apply with the bootstrap flag so **everything new lands provisional**:
   `echo '<{records,emailsById,heuristicMsgids,now}>' | node scripts/issue-apply.js data/issues --force-provisional`.
   (`emailsById` comes from the bundle; `heuristicMsgids` = the msgids of bundle
   items tagged `heuristic-delete-candidate`.)
4. Show the provisional list (via `loadProvisional`) and tell the user to
   `graduate` / `merge` / `ignore`.
5. Write `data/issue-assignment-state.json` (`saveAssignmentState`).

## Normal run (assignment)

> Steady-state promotion: outside bootstrap, `issue-apply.js` (without
> `--force-provisional`) promotes a NEW topic to a **real** issue when it has
> >=2 linked emails or a next_action. Bootstrap forces everything provisional
> for the one-time sweep; normal runs trust the heuristic. (This reconciles the
> earlier "everything lands provisional" wording — that is the bootstrap rule,
> not the steady-state rule.)

Two entry paths (cadence C):
- **Piggyback**: if a fresh `data/.last-run-bundle.json` exists (generatedAt within the
  last ~15 min), use its `survivors` + `heuristicCandidates` — no re-fetch.
- **On-demand / refresh**: if a fresh `data/.last-run-bundle.json` exists, use it;
  otherwise run `node scripts/build-bundle.js --since <delta>` (delta = time since
  `lastAssignedAt` for the accounts), then read the bundle.

- **Confidence tier (steady-state cost lever).** `build-bundle.js` deterministically
  dispositions corroborated-bulk candidate groups (high structural bulk score AND a
  collapse group AND all-members-candidate AND sender-not-protected) as `trash`,
  emitting `tierRecords` so the reasoner spends no judgment on obvious bulk. Lifecycle
  per account in `config/companies.json` → `candidateTier.mode`: absent = off;
  `shadow` = stamp + validate (reasoner still judges); `active` = auto-trash with a
  sampled hold-back audited every run. Drift demotes `active`→`shadow` automatically.
  Soft-delete only — `build-bundle` never deletes; the skill trashes via the existing
  connectors after `issue-apply`.

Then:
1. Build the issue index from `loadIssues` (open only).
2. Run the reasoner pass (`_reasoner-pass.md`) over the bundle.
3. Apply via `scripts/issue-apply.js` → `{created, updated, quarantined, rescued, toTrash, noIssue}`.
   Pass the bundle's heuristic-candidate msgids as `heuristicMsgids` so rescued is counted.
4. Soft-delete `toTrash` via `delete-emails.js` / `delete-gmail-emails.js`
   (**soft-delete only**). Gmail deletes pass the accountId first (verified).
   Also soft-delete the bundle's `explicitDeletions` (config `alwaysDelete` hits —
   `[{msgid, account}]`) the same way: these are deliberate config kills that never
   reach the reasoner, so the skill must delete them or they would silently survive.
5. Update `data/issue-assignment-state.json` (`lastAssignedAt[account] = now`).
6. **Learn (gets cheaper over time).** Write the trashed msgids to a file and run
   `node scripts/record-deletions.js <file>` — it bumps each trashed sender's
   consecutive-deletion counter (and resets survivors) in `data/sender-history.json`.
   Then `node scripts/promote-senders.js --apply` graduates any sender past the
   threshold (≥5 consecutive, list-unsubscribe, not protected, not a correspondent,
   not dual-use) to the permanent kill-list as an email-exact rule — so the reasoner
   never spends judgment on it again. Soft-delete only; promotion never deletes.

## Status view (default)

Sort `waiting_on == "you"` first, then others. Collapse provisional + snoozed to counts.

```
Open (N):
  <alias>  <title> — <YOU: <next_action> | waiting on <who> (<next_action>)>
  ...
Provisional (P) · Snoozed (S) · `/issues more` for detail
```

## Drill-in (`<alias>` / `<alias>?`)

Resolve alias via `findByAlias`. If ambiguous, show a one-line numbered shortlist and stop.

```
<title> · <accounts> · since <opened>
Next: <next_action> (<waiting_on>)
Last: <most recent linked-message one-liner>
Open Q: <first open question, if any>
```

`<alias> more` → append the full `## Log` and `## Linked messages` sections.

## Verbs

- **draft `<alias>`**: load the issue + the account `voiceProfile` from companies.json.
  Compose a ≤3-sentence reply that uses the issue's accumulated context (participants,
  next_action, open questions) and the voice profile (openingStyle, signOff, formality).
  Save to Drafts-OfficeOS:
  - Outlook: `echo '{"to":[...],"subject":"Re: ...","body":"...","replyToMessageId":"<msgid>"}' | node scripts/save-draft.js <account>`
  - Gmail: `echo '{"to":[...],"subject":"Re: ...","body":"...","threadId":"<threadId>"}' | node scripts/save-gmail-draft.js <account>`
  Show a 1-line preview. **Never send.** Update `data/drafts-index.json` with the new draftId.
- **done `<alias>`**: `markDone` (via issue-store).
- **snooze `<alias>` `<when>`**: resolve `<when>` (`3d`, `friday`, ISO) to a date; `snoozeIssue`.
- **merge `<a>` `<b>`**: `mergeIssues(target=a, source=b)`.
- **ignore `<prov-slug>`**: delete the provisional file (`rm data/issues/provisional/<slug>.md`).
- **graduate `<prov-slug>`**: `graduateProvisional`.

## Safety (inherited, non-negotiable)

- **Never send email.** Drafts only.
- **Soft-delete only.** No permanent deletion path. Bootstrap never trashes.
- **Never hand-edit issue files** from the prompt — go through `issue-store.js`.
- Issue-file writes are atomic (issue-store uses `fs-utils.atomicWrite`).
