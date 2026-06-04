---
description: Converse with your inbox as topic-based issues — status, drill-in, draft, and lifecycle verbs
allowed-tools: Bash, Read, Write, Edit
---

# Issues

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
1. Fetch 14–30 days across all accounts (`fetch-emails.js` / `fetch-gmail.js`).
2. Classify with `classify-emails.js` to drop explicit-rule noise (cheap pre-filter).
3. Run the reasoner pass over survivors **only** (see `_reasoner-pass.md`). **Do NOT
   trash anything on the bootstrap pass** — pass an empty `toTrash` through; this run
   is read-and-organize only.
4. Apply via `scripts/issue-apply.js`; everything new lands provisional.
5. Show the provisional list and tell the user to `graduate` / `merge` / `ignore`.
6. Write `data/issue-assignment-state.json`.

## Normal run (assignment)

Two entry paths (cadence C):
- **Piggyback**: if a fresh `data/.last-run-bundle.json` exists (generatedAt within the
  last ~15 min), use its `survivors` + `heuristicCandidates` — no re-fetch.
- **On-demand / refresh**: read `issue-assignment-state.json`, fetch each account's
  delta since `lastAssignedAt`, classify, build the bundle yourself.

Then:
1. Build the issue index from `loadIssues` (open only).
2. Run the reasoner pass (`_reasoner-pass.md`) over the bundle.
3. Apply via `scripts/issue-apply.js` → `{created, updated, quarantined, rescued, toTrash, noIssue}`.
   Pass the bundle's heuristic-candidate msgids as `heuristicMsgids` so rescued is counted.
4. Soft-delete `toTrash` via `delete-emails.js` / `delete-gmail-emails.js`
   (**soft-delete only**). Gmail deletes pass the accountId first (verified).
5. Update `data/issue-assignment-state.json` (`lastAssignedAt[account] = now`).

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
