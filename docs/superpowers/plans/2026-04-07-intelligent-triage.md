# Intelligent Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static rule-based triage classification with a hybrid system where the script handles mechanical filtering and Claude classifies ambiguous emails using an attention profile and accumulated memories.

**Architecture:** The script gains a `--raw` JSON output mode that returns three confidence buckets (high-delete, high-keep, uncertain). The triage skill is rewritten so Claude orchestrates: calling the script for data, loading the attention profile, classifying uncertain emails, formatting output, and capturing feedback. Existing memories expand to store relationship, pattern, and context knowledge.

**Tech Stack:** Node.js (ES modules), Claude Code skills (markdown), memory system (markdown with YAML frontmatter)

**Spec:** `docs/superpowers/specs/2026-04-07-intelligent-triage-design.md`

---

### Task 1: Add `--raw` JSON output mode to triage.js

**Files:**
- Modify: `scripts/triage.js:343-431` (main function)

This task adds a `--raw` flag that makes the script return structured JSON instead of formatted markdown. The script still fetches and classifies using existing logic, but splits results into three confidence buckets based on how the classification was determined.

- [ ] **Step 1: Add raw mode flag detection and new output branch**

In `scripts/triage.js`, replace the `main()` function (lines 343-431) with a version that detects `--raw` and branches:

```javascript
async function main() {
  const rawMode = process.argv.includes("--raw");
  const args = process.argv.slice(2).filter(a => a !== "--raw");
  const accountFilter = args[0] || "all";
  const hours = parseInt(args[1] || "24", 10);
  const maxGmail = parseInt(args[2] || "100", 10);

  const { companies, accountTypes, prefs } = loadConfig();

  // Resolve which accounts to triage
  let accounts;
  if (accountFilter === "all") {
    accounts = companies;
  } else {
    const ids = accountFilter.split(",").map((s) => s.trim());
    accounts = companies.filter((c) => ids.includes(c.id));
    if (accounts.length === 0) {
      console.error(`No accounts found matching: ${accountFilter}`);
      process.exit(1);
    }
  }

  // Fetch and classify each account
  const results = [];
  const fetchSummary = [];

  for (const account of accounts) {
    const label = account.name;
    try {
      const emails = await fetchAccount(account, hours, maxGmail);
      const classified = classify(emails, account.id);
      results.push({
        accountId: account.id,
        name: label,
        provider: account.provider || "outlook",
        accountType: account.accountType,
        count: emails.length,
        classified,
      });
      fetchSummary.push({ name: label, count: emails.length, hours });
    } catch (err) {
      console.error(`Error fetching ${label}: ${err.message}`);
      fetchSummary.push({ name: label, error: true, hours });
    }
  }

  // --- RAW MODE: return structured JSON for Claude to classify ---
  if (rawMode) {
    const raw = buildRawOutput(results, accountTypes);
    console.log(JSON.stringify(raw, null, 2));
    return;
  }

  // --- FORMATTED MODE: existing markdown output ---
  const output = [];
  output.push(formatFetchSummary(fetchSummary, prefs));

  const businessResults = results.filter((r) => {
    const tc = accountTypes[r.accountType];
    return tc?.dailyBrief?.section === "main";
  });
  const personalResults = results.filter((r) => {
    const tc = accountTypes[r.accountType];
    return tc?.dailyBrief?.section === "personal-appendix";
  });

  if (businessResults.length) {
    output.push(renderBusinessSection(businessResults, accountTypes));
  }

  if (personalResults.length) {
    output.push(renderPersonalSection(personalResults));
  }

  const { text: deletionText, pendingDeletions } =
    renderDeletionCandidates(results);
  output.push(deletionText);

  if (pendingDeletions.length) {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      join(DATA_DIR, "pending-deletions.json"),
      JSON.stringify(pendingDeletions, null, 2),
      "utf-8"
    );
  }

  console.log(output.join("\n"));
}
```

- [ ] **Step 2: Add the buildRawOutput function**

Add this function above `main()` in `scripts/triage.js`:

```javascript
function buildRawOutput(results, accountTypes) {
  const highKeep = [];
  const highDelete = [];
  const uncertain = [];

  // Build a lookup for account myEmail (needed for BCC detection in bulk signals)
  const { companies: allCompanies } = JSON.parse(
    readFileSync(join(ROOT, "config/companies.json"), "utf-8")
  );
  const accountEmailMap = {};
  for (const c of allCompanies.companies) {
    accountEmailMap[c.id] = c.myEmail || "";
  }

  for (const r of results) {
    const classified = r.classified;
    const accountId = r.accountId;
    const provider = r.provider;
    const accountName = r.name;

    // Walk through each category's emails
    for (const [catId, cat] of Object.entries(classified.categories)) {
      for (const email of cat.emails) {
        const entry = {
          id: email.id,
          accountId,
          accountName,
          provider,
          sender: email.fromName,
          senderEmail: email.from,
          subject: email.subject,
          isRead: email.isRead,
          hasAttachments: email.hasAttachments,
          bulkSignals: detectBulkSignals(email, accountEmailMap[accountId] || "").signals,
          category: catId,
          categoryLabel: cat.label,
        };

        const isDeletionCandidate = classified.deletionCandidates.some(
          (d) => d.id === email.id
        );

        // High-confidence delete: script classified as ignore AND is a deletion candidate
        // This covers alwaysDelete senders, bulk signal hits, downrank matches
        if (catId === "ignore" && isDeletionCandidate) {
          entry.reason = "Script: deletion candidate (bulk/spam/alwaysDelete)";
          highDelete.push(entry);
        }
        // High-confidence keep: script classified into action/respond category
        // or sender matches prioritySenders/neverDelete
        else if (catId === "action" || catId === "respond") {
          entry.reason = "Script: action/respond category";
          highKeep.push(entry);
        }
        // Everything else is uncertain — Claude will classify
        else {
          uncertain.push(entry);
        }
      }
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    accounts: results.map((r) => ({
      id: r.accountId,
      name: r.name,
      provider: r.provider,
      accountType: r.accountType,
      emailCount: r.count,
    })),
    highKeep,
    highDelete,
    uncertain,
  };
}
```

- [ ] **Step 3: Import detectBulkSignals for use in buildRawOutput**

The `detectBulkSignals` function is already imported via `classify-emails.js`. Update the import at line 21 to also export it:

In `scripts/classify-emails.js`, `detectBulkSignals` is already exported. In `scripts/triage.js`, update the import at line 21:

```javascript
import { classify, detectBulkSignals } from "./classify-emails.js";
```

- [ ] **Step 4: Test raw mode manually**

Run:
```bash
node scripts/triage.js --raw all 24 100 > data/raw-test.json
```

Verify the JSON output has three arrays (`highKeep`, `highDelete`, `uncertain`) with the expected fields. Check that action items appear in `highKeep`, obvious spam in `highDelete`, and ambiguous emails in `uncertain`.

- [ ] **Step 5: Verify formatted mode still works**

Run:
```bash
node scripts/triage.js all 24 100
```

Verify the markdown output is identical to before — the `--raw` flag should have no effect on the existing output path.

- [ ] **Step 6: Commit**

```bash
git add scripts/triage.js
git commit -m "feat: add --raw JSON output mode to triage.js

Adds a --raw flag that returns structured JSON with three confidence
buckets (highKeep, highDelete, uncertain) instead of formatted markdown.
This enables Claude to classify the uncertain middle while the script
handles obvious ends."
```

---

### Task 2: Create the attention profile

**Files:**
- Create: `config/attention-profile.md`

This is the compact briefing document Claude loads every triage session. It distills the user's world from config arrays and conversation history into prose Claude can reason about.

- [ ] **Step 1: Write the attention profile**

Create `config/attention-profile.md`:

```markdown
# Ben Sardinas — Attention Profile

## Who I Am

I run three companies and have an active personal life with martial arts, fraternity volunteer work, and university involvement.

## My Companies

**Healthcare M&A** — I'm MD/President. We acquire and operate home health agencies in Florida. George Gabela is my partner and handles LOIs and deal negotiations — his emails are always action items. Nestor Matos, Leo Orozco, and Alain Rosello are consultants who work directly with me. Tom Zydron is a key contact. Vyanca Corraliza handles compliance. WellSky sends legitimate invoices for our agencies (Ally Home Care, Agile Home Care, Artemis Home Care). Evo Alerts/Evo Voice sends call transcripts and voicemails for our office — these are FYI, not noise.

**Brickell Payments** — I'm CEO. We're a payment processing company. Matthew Martorano, Anthony Ribas, Wayne Orkin, and Luis Raventos are partners — their emails are always action items. Matt Ferry, Jesse Cretaro, Peter Falotico, David Cates, and Karen Skula are business contacts whose emails matter. Seth Myers handles IRIS/ELAPP. Marissa Beach handles EMV projects. Copilot is our merchant support ticketing system — ticket notifications are FYI. Our dev team (Dario Cuevas, Alexis Sanchez Lainez, Irving Chero, Wilfredo Yupanqui, Matias Suarez, Gonzalo Suarez) sends GitHub PR notifications — the bot notifications (coderabbitai, github-code-quality, github-actions, chatgpt-codex-connector, github-advanced-security) are deletable noise, but human comments from the team are FYI.

**Summit Miami (Summit Real Estate)** — Real estate holding company. Lower volume inbox. Annual report filings are action items. TD Bank overdraft and statement alerts are FYI. Most commercial real estate marketing (listings, broker opens, CRE newsletters) is deletable.

## Personal Life

**Iaido** — I study, teach, and compete in Iaido at the tournament level. SEUSKF (SE US Kendo Federation), AUSKF (All US Kendo Federation), and Florida Budokan are my organizations. Pam Parker is a key Iaido contact. Rambling Bard is a dojo contact. Emails about seminars, shinsa (rank examinations), tournaments, and registration are high priority. Merchandise and fundraiser spam from these orgs is not.

**Sigma Phi Epsilon (SigEp)** — I'm volunteer staff at FIU and at the national level, not just alumni. Emails from sigep.net are important. John L. Dougherty is on the Ritual Committee. Thomas Jelke, Kenneth Maddox, Tyya Turner, Jason Richards, Preston Raines, Paul Litcher are SPE contacts. Chad Stegemiller (COO) sends org-wide updates that matter.

**University of Miami** — I'm a Hurricane Club donor and supporter. Hurricane Club emails are important — keep them. Athletic Director reports are FYI.

**FIU** — I'm volunteer staff. Emails from fiu.edu matter. FIU Alumni marketing/giving solicitations are deletable unless they're about specific campus events I might attend.

**Personal Contacts** — Philip Porter and Juan C. Linares are personal contacts whose emails always matter. Victor Caberea coordinates events at the Jelke SPE center.

**Friends** — Ari Rollnick is an old friend who reaches out through the Healthcare M&A inbox. Keep his emails even when they look like cold outreach.

## My Judgment Principles

- **GitHub bot notifications are noise.** PR comments from bots (coderabbitai, github-code-quality, github-actions, chatgpt-codex-connector, github-advanced-security) are deletable. Human PR comments from my dev team are FYI.
- **Real estate marketing is noise.** Commercial listings, broker opens, "just listed," price reduced — delete across all accounts unless from a known contact.
- **Conference invitations are usually noise.** Unless they're specifically about behavioral health, payments industry, or healthcare M&A — then they're FYI.
- **LinkedIn notifications are deletable.** Job suggestions, "follow this person," "posted an update" — all noise.
- **Microsoft Defender alerts are FYI, not action.** They come in batches and are informational.
- **TD Bank notices are FYI.** Overdraft alerts, statement notices — keep but don't elevate.
- **Newsletters and marketing from companies I do business with** (Adobe, AT&T, Microsoft) — FYI if they're about my account, deletable if they're marketing.
- **Payment confirmations and receipts are FYI.** Hyundai Motor Finance (speedpay.com), credit card statements, etc.
- **Shareholder votes and proxy materials always matter.** Look for "proxy," "Vote now," "Annual Meeting."

## Hard Workflow Rules

- Never summarize or compress the deletion candidate list. Show every item numbered.
- Batch deletions by account — one command per account, no per-email approval.
- Persist pending deletions to data/pending-deletions.json.
- Keep triage token-efficient — don't research, don't retry, don't expand.
```

- [ ] **Step 2: Add attention-profile.md to .gitignore**

The attention profile contains personal information about the user's business relationships. Add to `.gitignore`:

```
config/attention-profile.md
```

- [ ] **Step 3: Commit the gitignore change**

```bash
git add .gitignore
git commit -m "chore: gitignore attention-profile.md (personal data)"
```

---

### Task 3: Restructure memories for triage context

**Files:**
- Create: `memory/relationship_ari_rollnick.md`
- Create: `memory/relationship_hurricane_club.md`
- Create: `memory/relationship_john_dougherty.md`
- Modify: `memory/MEMORY.md`

Move the relationship knowledge that's currently in `neverDelete` arrays into proper memory files that Claude can reason about. These are the relationships learned from recent triage sessions.

- [ ] **Step 1: Create relationship memory for Ari Rollnick**

Create `C:\Users\bensa\.claude\projects\D--OneDrive---Brickell-Payments--WORKFORCE--Documents-OfficeOS\memory\relationship_ari_rollnick.md`:

```markdown
---
name: Ari Rollnick — personal friend
description: Old friend of Ben's who contacts him through Healthcare M&A email — keep his emails even when they look like cold outreach
type: user
---

Ari Rollnick is a personal friend of Ben's. He reaches out through the Healthcare M&A inbox (phone 786-295-5933, voicemails come via nextiva.com). His emails should always be kept, even when the subject line looks like a generic cold outreach ("Long time", "I want to connect"). He's not a business contact — he's a friend.

Added to neverDelete for healthcarema on 2026-04-06. Should be recognized by Claude's judgment going forward.
```

- [ ] **Step 2: Create relationship memory for Hurricane Club**

Create `C:\Users\bensa\.claude\projects\D--OneDrive---Brickell-Payments--WORKFORCE--Documents-OfficeOS\memory\relationship_hurricane_club.md`:

```markdown
---
name: Hurricane Club — UM donor organization
description: Ben is an active Hurricane Club donor/member — keep their emails including gift acknowledgments and membership updates
type: user
---

Ben is a member and donor of the Hurricane Club (University of Miami athletics support organization). Their emails include gift acknowledgments, membership renewals, football parking access, and athletics updates. These should always be kept — they're not marketing spam, they're communications from an organization Ben actively supports and donates to.

Added to neverDelete for personal on 2026-04-06.
```

- [ ] **Step 3: Create relationship memory for John Dougherty**

Create `C:\Users\bensa\.claude\projects\D--OneDrive---Brickell-Payments--WORKFORCE--Documents-OfficeOS\memory\relationship_john_dougherty.md`:

```markdown
---
name: John L. Dougherty — SigEp Ritual Committee
description: SigEp contact on the Ritual Committee — emails about chapter meetings and ritual business
type: user
---

John L. Dougherty is a Sigma Phi Epsilon contact who serves on the Ritual Committee. His emails are about committee meetings (typically monthly) and chapter ritual business. Always keep.

Added to neverDelete for personal on 2026-04-04.
```

- [ ] **Step 4: Update MEMORY.md index**

Add the new relationship memories to `C:\Users\bensa\.claude\projects\D--OneDrive---Brickell-Payments--WORKFORCE--Documents-OfficeOS\memory\MEMORY.md`:

Add under a new "## Relationships" section:

```markdown
## Relationships
- [relationship_ari_rollnick.md](relationship_ari_rollnick.md) — Old friend, contacts via Healthcare M&A inbox
- [relationship_hurricane_club.md](relationship_hurricane_club.md) — UM donor org, always keep
- [relationship_john_dougherty.md](relationship_john_dougherty.md) — SigEp Ritual Committee contact
```

- [ ] **Step 5: Commit**

```bash
git commit -m "docs: add relationship memories for triage-learned contacts

Moves relationship knowledge from neverDelete config arrays into memory
files Claude can reason about: Ari Rollnick (friend), Hurricane Club
(donor org), John Dougherty (SigEp)."
```

Note: Memory files are outside the git repo (in the Claude projects directory), so this commit only applies if MEMORY.md changes are in-repo. If the memory directory is outside the repo, skip the git commit for this task — the files are written directly.

---

### Task 4: Rewrite the triage orchestrator skill

**Files:**
- Modify: `.claude/commands/orchestrators/triage.md`

This is the core change. The orchestrator skill goes from "run script, display output" to "run script in raw mode, load attention profile, classify uncertain emails, format output, capture feedback."

- [ ] **Step 1: Rewrite the orchestrator skill**

Replace the entire contents of `.claude/commands/orchestrators/triage.md`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add .claude/commands/orchestrators/triage.md
git commit -m "feat: rewrite triage orchestrator for intelligent classification

Orchestrator now calls triage.js in --raw mode, loads the attention
profile, classifies uncertain emails using Claude's judgment and
memories, formats output, and captures feedback. Falls back to
formatted mode if raw mode fails."
```

---

### Task 5: Rewrite the single-account triage skill

**Files:**
- Modify: `.claude/commands/email/email-triage.md`

The single-account skill should mirror the orchestrator's new behavior but for a single account.

- [ ] **Step 1: Rewrite the single-account skill**

Replace the entire contents of `.claude/commands/email/email-triage.md`:

```markdown
Triage the email inbox for a single company. $ARGUMENTS

$ARGUMENTS is a company ID from `config/companies.json` (e.g. `healthcarema`, `personal`).
Optionally append hours and max results: `personal 48 200`.
If no account ID is provided, ask the user which account to triage.

Follow the same process as the full triage orchestrator (`orchestrators/triage.md`), but for a single account:

1. Run: `node scripts/triage.js --raw {accountId} {hours} {maxGmail}`
2. Load `config/attention-profile.md` and classify the uncertain emails
3. Format and present results (same format as full triage, but single account)
4. Save `data/pending-deletions.json` and handle deletion workflow
5. Capture feedback (explicit statements → memories, append to triage log)

See `orchestrators/triage.md` for full Phase 1-5 details.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/commands/email/email-triage.md
git commit -m "feat: rewrite single-account triage skill to match orchestrator

Points to orchestrator for full process details. Uses --raw mode
and Claude classification like the orchestrator."
```

---

### Task 6: Create the triage log structure

**Files:**
- Create: `data/triage-log.md` (empty initial file)
- Modify: `.gitignore`

- [ ] **Step 1: Ensure data/ directory and triage-log.md exist**

```bash
mkdir -p data
touch data/triage-log.md
```

- [ ] **Step 2: Verify triage-log.md is gitignored**

Check `.gitignore` for `data/` — it should already be there per CLAUDE.md ("Do not commit anything in `data/`"). If not present, add:

```
data/
```

- [ ] **Step 3: Commit if .gitignore was modified**

```bash
git add .gitignore
git commit -m "chore: ensure data/ is gitignored for triage log"
```

---

### Task 7: End-to-end validation

**Files:**
- No new files — this is a manual testing task

- [ ] **Step 1: Run the new triage in raw mode and inspect output**

```bash
node scripts/triage.js --raw all 24 100 > data/raw-test.json
```

Open `data/raw-test.json` and verify:
- `highKeep` contains emails from known priority senders (George Gabela, Matthew Martorano, etc.)
- `highDelete` contains obvious spam and bulk emails
- `uncertain` contains the ambiguous middle that Claude should classify
- All three arrays have the required fields: id, accountId, provider, sender, subject, bulkSignals

- [ ] **Step 2: Run the old formatted mode and verify it still works**

```bash
node scripts/triage.js all 24 100
```

Verify output matches the familiar markdown format with Action Items, FYI, Personal Triage, and Deletion Candidates sections.

- [ ] **Step 3: Test the full orchestrator skill**

Run `/orchestrators:triage` in Claude Code. Verify:
- Claude calls the script with `--raw` flag
- Claude loads the attention profile
- Claude classifies uncertain emails and explains its reasoning where relevant
- Output format matches the established presentation rules
- Deletion candidates are individually numbered (not summarized)
- `data/pending-deletions.json` is written correctly
- Deletion workflow works: respond with "delete all except N" and verify execution

- [ ] **Step 4: Test feedback capture**

During triage, make an explicit statement about a sender (e.g. "keep X, they're important because Y"). Verify:
- Claude writes a relationship memory file
- Claude updates MEMORY.md index
- Claude appends to `data/triage-log.md`

- [ ] **Step 5: Test fallback mode**

Temporarily rename `config/attention-profile.md` and run `/orchestrators:triage`. Verify:
- Claude falls back to the old formatted script output
- Triage still works, just without intelligent classification

Restore `config/attention-profile.md` after testing.

- [ ] **Step 6: Commit any fixes from validation**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end triage validation"
```
