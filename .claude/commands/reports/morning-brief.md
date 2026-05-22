---
description: Single autonomous morning brief covering triage, drafts, task capture, and pattern discovery across all accounts
allowed-tools: Bash, Read, Write, Edit
---

# Morning Brief

Generate the autonomous morning brief. Replaces `/triage` and `/daily-brief`.

## Inputs

- `$ARGUMENTS` — optional flags. Recognized:
  - `--dry-run` — no deletes, no drafts saved, no state mutations; brief written to `data/morning-queue.dry-run.md`
  - `--since YYYY-MM-DD` — process emails received since this date
  - `--window 24h` / `--window 14d` — alternative to `--since`
  - `--draft-only` — only draft replies; skip deletes and pattern discovery (used during catch-up follow-up)

## Steps

### 1. Load configuration

Use Bash to load (read into the prompt):

```
cat config/companies.json
cat config/account-types.json
cat config/attention-profile.md
cat config/prefs.json
```

Note each account's `voiceProfile` for the drafting step.

### 2. Run the orchestrator

Pass `$ARGUMENTS` to the orchestrator via Bash:

```bash
node scripts/morning-brief.js $ARGUMENTS
```

Capture stdout as JSON. The orchestrator has already:
- Fetched + classified per account
- Auto-deleted noise (unless `--dry-run`)
- Captured action items to `data/tasks.md`
- Updated `data/sender-history.json`
- Run pattern discovery; merged new proposals into `data/proposed-rules.json`
- Appended to `data/triage-log.md`; updated `data/last-run-state.json`

The JSON contains:
- `timestamp`, `window`, `dryRun`
- `summary` — per-account counts
- `needsDecision` — capped action items (action-shaped emails needing your decision)
- `deferred` — overflow from catch-up cap
- `draftCandidates` — action items that match draftable heuristics
- `proposedRules` — new proposals this run
- `travel` — emails matching travel signals
- `fyiCounts` — FYI counts per account
- `warnings`

### 3. Draft replies for each draft candidate

Skip this step if `--dry-run` is set.

For each `draftCandidate`:

1. Look up the account's `voiceProfile` from companies.json.
2. Compose a short reply (≤ 3 sentences, ≤ 4 lines including sign-off):
   - Open in the voice profile's `openingStyle` (`direct` or `warm`)
   - Address the specific ask in the email
   - Close with the voice profile's `signOff`
   - Match the formality level
3. Save the draft. For Outlook accounts:

```bash
echo '{"to":["<recipient>"],"subject":"Re: <subject>","body":"<draft body>","replyToMessageId":"<email.id>"}' | node scripts/save-draft.js <accountId>
```

For Gmail accounts:

```bash
echo '{"to":["<recipient>"],"subject":"Re: <subject>","body":"<draft body>","threadId":"<email.threadId>"}' | node scripts/save-gmail-draft.js <accountId>
```

Parse the returned `draftId` and store it next to the email's needsDecision entry.

3a. After each successful save, update `data/drafts-index.json` to record the mapping so subsequent overlapping runs don't re-draft the same email.

The agent should:
- Read `data/drafts-index.json` (or use `{}` if missing).
- Set `index["<accountId>:<sourceMessageId>"] = { draftId, savedAt: <ISO>, preview }`.
- Write back via the standard JSON.stringify pretty-printed format.

This prevents re-drafting the same email on overlapping windows. The orchestrator already pre-filters draft candidates against the index, but the skill must keep the index updated for new drafts it creates.

If the save fails, capture the error message as a warning and include the draft body inline in the brief instead.

### 4. Assemble the brief

Write the final brief to `data/morning-queue.md` (or `data/morning-queue.dry-run.md` in dry-run mode).

If a previous brief exists, move it to `data/archive/morning-queue-<timestamp>.md` first.

Structure (write each section unconditionally — show "(none)" if a section is empty):

```markdown
# Morning Brief — <YYYY-MM-DD> (<window descriptor>)

## Summary
- <Account 1>: <fetched> emails / <autoDeleted> auto-deleted / <draftCandidates> drafts / <actions> actions / <proposals from this account> rules proposed
- <Account 2>: ...
- Total: <totals>

## Needs your decision (<count>)
1. [<account> / <classification>] <fromName> — "<subject>" (<receivedAt date>)
   - Why: <one-line reason — urgency flag, priority sender, etc.>
   - <If draft staged>: Draft staged in <Account> Drafts (see #D<n>)
   - <If no draft>: Suggested: <short suggested action>
2. ...

## Drafts staged for approval (<count>)
D1. To: <recipient> — Re: <subject>
    Preview: "<first sentence of draft>..."
    [Open in <Account> Drafts]
D2. ...

## Proposed rules (<count>) — reply "approve <ids>; decline <ids>"
<id> → `<target>`: <one-line description and reason>
<id> → ...

## Travel / event context
<If travel emails present, group by destination or trip; otherwise: "No active travel signals.">

## FYI digest (collapsed)
<details>
<summary><Account> — <N> FYI emails</summary>
<list a few notable ones, or omit details>
</details>

## Autonomous activity (collapsed)
<details>
<summary><N> emails auto-deleted</summary>
Top sender domains: <list top 5 with counts>
[Full log: data/triage-log.md @ <timestamp>]
</details>

## Deferred (<count from catch-up cap, if any>)
<List or "(none)">

## Warnings
<List warnings or "(none)">
```

### 5. Echo summary to chat

Print a one-paragraph summary:

> Brief written to `data/morning-queue.md`. Processed <total> emails across <N> accounts; auto-deleted <X>, staged <Y> drafts, captured <Z> tasks, proposed <W> new rules. <Warnings if any.>

If there are pending proposals, remind the user: "Reply with `approve <ids>; decline <ids>` to apply."

## Notes

- **Never send email.** Drafts only.
- **Never edit `companies.json` or `account-types.json` from the skill prompt.** Rule changes go through `scripts/apply-proposals.js` when the user approves proposals.
- **First run**: if `data/last-run-state.json` does not exist, treat as catch-up and pass `--dry-run` automatically. Note this in the brief header. The user re-invokes without `--dry-run` after reviewing.
- **Concurrency**: if `data/.lock-<account>` exists and is < 1 hour old, abort with a warning. Otherwise proceed and create the lock; clear it at the end.
