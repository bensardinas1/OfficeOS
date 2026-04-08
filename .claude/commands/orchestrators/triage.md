Run a full inbox triage across all configured accounts. $ARGUMENTS

If $ARGUMENTS specifies one or more account IDs (comma-separated), triage only those.
Optionally append hours and max Gmail results: `personal,healthcarema 48 200`.
Otherwise, triage every account in `config/companies.json`.

---

## Phase 1: Fetch and pre-filter

Run the triage script in raw mode:
```
node scripts/triage.js --raw {accountIds|all} {hours} {maxGmail}
```
Defaults: all accounts, hours=24, maxGmail=100.

The script returns JSON with three arrays:
- `highKeep` — emails the script confidently classified as important (action/respond)
- `highDelete` — emails the script confidently classified as deletable (bulk/spam/alwaysDelete)
- `uncertain` — emails that need Claude's judgment

## Phase 2: Classify the uncertain middle

1. **Load the attention profile** from `config/attention-profile.md`. This is your briefing on who the user is, their key relationships, and their judgment principles.

2. **For each uncertain email**, classify it using your judgment:
   - **Action/Respond** — requires the user's attention or reply
   - **FYI** — informational, worth seeing but no action needed
   - **Deletion candidate** — noise, marketing, or irrelevant

   Use the attention profile principles. If an email's sender or topic relates to a known relationship or organization, check the memory index (`memory/MEMORY.md`) and load the relevant memory file for detail.

3. **Merge your classifications** with the script's high-confidence decisions:
   - `highKeep` emails → Action Items (business) or Respond (personal)
   - `highDelete` emails → Deletion Candidates
   - Your classified uncertain emails → their assigned categories

## Phase 3: Format and present

Format the merged results as markdown. Load `config/prefs.json` for display settings.

**Business accounts:**
- `## Action Items — All Business Accounts` — one bullet per email: `- **[Account]** **[Sender]** Subject`
- `## FYI` — one bullet per email: `- **[Account]** Sender — Subject`

**Personal accounts:**
- `## Personal Triage` — grouped by category with `### Category Label` headers

**Deletion Candidates:**
- `## Deletion Candidates` — **EVERY candidate individually numbered**. Never summarize, compress, or group this list.
- Format: `N. [Account] Sender — Subject`
- End with: `Reply with numbers or ranges to delete (e.g. 'delete 1-12, 15'), or 'delete all'.`

**Save pending deletions** to `data/pending-deletions.json`:
```json
[{ "number": 1, "id": "...", "accountId": "...", "provider": "...", "sender": "...", "subject": "..." }]
```

## Phase 4: Executing deletions

When the user replies with deletion instructions (e.g. "delete all", "delete 1-8, 10-19", "delete all except 9"):

a. Read `data/pending-deletions.json`
b. Parse the user's selection into a set of numbers to delete
c. Group the selected items by `accountId` and `provider`
d. Execute one command per account — no per-email approval:
   - Outlook: `node scripts/delete-emails.js {accountId} {id1} {id2} ...`
   - Gmail: `node scripts/delete-gmail-emails.js {id1} {id2} ...`
e. Report: "Deleted N emails across M accounts." and remove `data/pending-deletions.json`

## Phase 5: Capture feedback

After deletions execute, **if the user made any explicit statements** about senders or organizations during this session (e.g. "Ari is a friend", "I'm a Hurricane Club member", "GitHub bot emails are trash"), write those as memory files immediately. Update the attention profile if the statement reflects a durable truth about the user's world.

**Log the session** by appending to `data/triage-log.md`:
```markdown
## {date}
Accounts: {accountIds}
Kept from deletion list: {numbers and senders the user chose to keep}
Explicit: {any statements made} → {action taken}
Deleted: {count} emails across {count} accounts
```

Do NOT analyze patterns after every session. Pattern analysis happens when the user asks ("What have you learned?") or when the log reaches ~10 sessions (mention it once, don't nag).

---

## Fallback

If the `--raw` script call fails or returns unexpected data, fall back to the old formatted mode:
```
node scripts/triage.js {accountIds|all} {hours} {maxGmail}
```
Display the formatted output directly. The system degrades gracefully.
