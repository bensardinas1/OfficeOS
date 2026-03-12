# Account Types & Gmail Integration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account type system (business/personal), Gmail provider routing via MCP, personal triage categories, and daily brief personal appendix to OfficeOS.

**Architecture:** New `config/account-types.json` defines behavioral templates (categories, noise filters, brief config) per account type. Each account in `companies.json` references a type and provider. Skills load both configs, merge them, and branch on provider for data fetching. Classification and output adapt to the account's resolved categories.

**Tech Stack:** Claude Code skills (markdown prompts), JSON config files, MCP Gmail tools, existing Node.js connectors (unchanged).

**Spec:** `docs/superpowers/specs/2026-03-12-account-types-gmail-design.md`

---

## Chunk 1: Config Foundation

### Task 1: Create `config/account-types.json`

**Files:**
- Create: `config/account-types.json`

- [ ] **Step 1: Create the live account types config**

```json
{
  "version": 1,
  "business": {
    "label": "Business",
    "tone": "professional",
    "triageCategories": [
      { "id": "action", "label": "ACTION REQUIRED", "description": "Needs a response or decision" },
      { "id": "fyi", "label": "FYI / READ", "description": "Informational, no action needed" },
      { "id": "news", "label": "NEWS / MARKET", "description": "Industry or market updates" },
      { "id": "ignore", "label": "IGNORE", "hidden": true }
    ],
    "downrankDefaults": [
      "bulk email", "newsletters", "marketing", "solicitations", "unsubscribe", "promotional"
    ],
    "noiseFilters": null,
    "dailyBrief": {
      "includeTasks": true,
      "includeCalendar": true,
      "section": "main"
    },
    "taskCapture": "auto"
  },
  "personal": {
    "label": "Personal",
    "tone": "casual",
    "triageCategories": [
      { "id": "respond", "label": "RESPOND", "description": "Needs a reply — someone is waiting" },
      { "id": "bills", "label": "BILLS / FINANCE", "description": "Bills due, statements, bank alerts, tax docs" },
      { "id": "appointments", "label": "APPOINTMENTS", "description": "Medical, dental, auto, personal services — confirmations and reminders" },
      { "id": "home_family", "label": "HOME / FAMILY", "description": "School notices, HOA, household services, family coordination" },
      { "id": "travel", "label": "TRAVEL", "description": "Bookings, confirmations, itineraries, loyalty — not promos" },
      { "id": "shopping", "label": "SHOPPING / ORDERS", "description": "Order confirmations, shipping, returns — not deal alerts" },
      { "id": "subscriptions", "label": "SUBSCRIPTIONS / RENEWALS", "description": "Renewal notices, payment failures, plan changes — not upsells" },
      { "id": "fitness", "label": "FITNESS / WELLNESS", "description": "Gym, classes, health apps, wellness programs" },
      { "id": "hobbies", "label": "HOBBIES", "description": "Clubs, groups, events, gear — related to personal interests" },
      { "id": "volunteer", "label": "VOLUNTEER", "description": "Nonprofit roles, community service, board duties" },
      { "id": "social", "label": "PERSONAL / SOCIAL", "description": "Friends, invitations, personal correspondence" },
      { "id": "newsletters", "label": "NEWSLETTERS", "description": "Opted-in reads worth scanning — not spam" },
      { "id": "ignore", "label": "IGNORE", "hidden": true }
    ],
    "downrankDefaults": [
      "promotional", "unsubscribe", "deal alert", "items you might like",
      "recommended for you", "limited time", "flash sale", "earn points",
      "hotel deals", "travel deals", "upgrade your", "act now",
      "don't miss", "exclusive offer", "free shipping"
    ],
    "noiseFilters": {
      "description": "Within each category, only surface transactional/actionable emails. Reject marketing disguised as category content.",
      "signals_keep": ["confirmation", "receipt", "shipped", "delivered", "reminder", "appointment", "invoice", "due", "renewal", "booking", "itinerary", "gate change", "payment"],
      "signals_reject": ["promotion", "deal", "offer", "recommended", "trending", "you might like", "earn", "reward points", "upgrade"]
    },
    "dailyBrief": {
      "includeTasks": false,
      "includeCalendar": false,
      "section": "personal-appendix"
    },
    "taskCapture": "manual"
  }
}
```

- [ ] **Step 2: Verify the file is gitignored**

Run: `cd "d:\OneDrive - Brickell Payments (WORKFORCE)\Documents\OfficeOS" && git status config/account-types.json`
Expected: File should NOT appear in untracked files (the existing `config/*.json` glob in `.gitignore` covers it).

---

### Task 2: Create `config/account-types.example.json`

**Files:**
- Create: `config/account-types.example.json`

- [ ] **Step 1: Create the example file**

Copy the exact content from Task 1, Step 1. This is the committed baseline template that ships with the repo.

- [ ] **Step 2: Verify the file IS tracked by git**

Run: `git status config/account-types.example.json`
Expected: File appears as untracked (ready to be committed). The `!config/*.example.json` exclusion in `.gitignore` ensures it's not ignored.

- [ ] **Step 3: Commit**

```bash
git add config/account-types.example.json
git commit -m "feat: add account-types config with business and personal type templates"
```

---

### Task 3: Migrate `config/companies.json` — add new fields to existing accounts

**Files:**
- Modify: `config/companies.json`

- [ ] **Step 1: Add `accountType` and `provider` to Healthcare M&A**

Add after the `"id": "healthcarema"` line:
```json
"accountType": "business",
"provider": "outlook",
```

- [ ] **Step 2: Add `accountType` and `provider` to Brickell Pay**

Add after the `"id": "brickellpay"` line:
```json
"accountType": "business",
"provider": "outlook",
```

- [ ] **Step 3: Add `accountType` and `provider` to Summit Miami**

Add after the `"id": "summitmiami"` line:
```json
"accountType": "business",
"provider": "outlook",
```

- [ ] **Step 4: Fix Summit Miami `keyContacts` bug**

In the Summit Miami entry, the `keyContacts` array has a malformed entry using the `prioritySenders` shape:
```json
{ "type": "domain", "value": "deebpa.com", "label": "Attorney — Deeb PA" }
```
This entry already exists in `prioritySenders` (line 111 of the current file), so simply remove it from `keyContacts`. The resulting `keyContacts` array should contain only:
```json
"keyContacts": [
  { "name": "Kevin Deeb", "role": "Attorney", "priority": "high" }
]
```

- [ ] **Step 5: Add personal Gmail account entry**

Append to the `companies` array (before the closing `]`). **Important:** Replace the placeholder email with the user's actual Gmail address before saving.

```json
{
  "id": "personal",
  "name": "Personal",
  "accountType": "personal",
  "provider": "gmail",
  "myEmail": "REPLACE_WITH_ACTUAL_GMAIL@gmail.com",
  "role": "Personal",
  "description": "Personal Gmail account",
  "tone": "casual",
  "purpose": "Manage personal life admin, hobbies, and volunteer commitments efficiently",
  "keyContacts": [],
  "prioritySenders": [],
  "urgencyRules": {
    "flags": []
  },
  "downrank": [],
  "categoryOverrides": [
    {
      "id": "iaido",
      "label": "IAIDO",
      "description": "Iaido study, teaching, and competition — local and national",
      "prioritySenders": [
        { "type": "domain", "value": "auskf.org", "label": "National federation" }
      ],
      "urgencyRules": {
        "flags": ["tournament", "registration", "deadline", "seminar", "grading", "exam"]
      },
      "downrank": ["merchandise", "fundraiser spam"]
    },
    {
      "id": "spe",
      "label": "SIGMA PHI EPSILON",
      "description": "Fraternity — local chapter and national involvement",
      "prioritySenders": [
        { "type": "domain", "value": "sigep.org", "label": "SPE National" }
      ],
      "urgencyRules": {
        "flags": ["chapter meeting", "board", "election", "deadline", "conclave"]
      },
      "downrank": ["alumni merchandise", "donation solicitation"]
    }
  ],
  "outputs": {
    "primary": "Personal triage — items needing attention",
    "secondary": "Life admin summary"
  }
}
```

- [ ] **Step 6: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('config/companies.json','utf8')); console.log('Valid JSON')"`
Expected: `Valid JSON`

Note: `companies.json` is gitignored — no commit for this file.

---

### Task 4: Update `config/companies.example.json`

**Files:**
- Modify: `config/companies.example.json`

- [ ] **Step 1: Add new fields to existing example accounts**

Add `"accountType": "business"` and `"provider": "outlook"` to both example company entries (after the `"id"` line in each).

- [ ] **Step 2: Add a personal account example entry**

Append a third entry to the `companies` array:

```json
{
  "id": "personal",
  "name": "Personal",
  "accountType": "personal",
  "provider": "gmail",
  "myEmail": "me@gmail.com",
  "role": "Personal",
  "description": "Personal Gmail account",
  "tone": "casual",
  "purpose": "Manage personal life admin, hobbies, and volunteer commitments efficiently",
  "keyContacts": [],
  "prioritySenders": [],
  "urgencyRules": { "flags": [] },
  "downrank": [],
  "categoryOverrides": [
    {
      "id": "my-hobby",
      "label": "MY HOBBY",
      "description": "Example: a competitive hobby with its own organizations and deadlines",
      "prioritySenders": [
        { "type": "domain", "value": "hobby-org.org", "label": "National organization" }
      ],
      "urgencyRules": {
        "flags": ["tournament", "registration", "deadline"]
      },
      "downrank": ["merchandise"]
    }
  ],
  "outputs": {
    "primary": "Personal triage — items needing attention",
    "secondary": "Life admin summary"
  }
}
```

- [ ] **Step 3: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('config/companies.example.json','utf8')); console.log('Valid JSON')"`
Expected: `Valid JSON`

- [ ] **Step 4: Commit**

```bash
git add config/companies.example.json
git commit -m "feat: add accountType, provider, and personal account example to companies template"
```

---

## Chunk 2: Skill Updates

### Task 5: Update `email-triage.md` — dynamic categories and provider routing

**Files:**
- Modify: `.claude/commands/email/email-triage.md`

- [ ] **Step 1: Rewrite the skill with account type support**

Replace the entire contents of `.claude/commands/email/email-triage.md` with:

```markdown
Triage the email inbox for a single company. $ARGUMENTS

$ARGUMENTS is a company ID from `config/companies.json` (e.g. `healthcarema`, `personal`).
If not provided, ask the user which account to triage.

1. Load `config/companies.json`, `config/account-types.json`, and `config/prefs.json`.
   Find the account entry matching $ARGUMENTS.
   Load the account's type definition from `account-types.json` using `account.accountType` (default to `"business"` if missing).

2. **Resolve categories** by merging type defaults with account overrides:
   - Start with `type.triageCategories` as the base list
   - For each entry in `account.categoryOverrides` (if present):
     - If its `id` matches an existing category → replace that category entirely (all fields from the override are used; omitted fields do NOT inherit from the type default)
     - If its `id` is new → append it to the list
   - Merge `account.downrank` (if present) into `type.downrankDefaults` by concatenation

3. **Resolve tone**: use `account.tone` if present, otherwise `type.tone`.

4. **Fetch recent emails** based on `account.provider` (default to `"outlook"` if missing):
   - If `"outlook"`: run `node scripts/fetch-emails.js {account.id} 24 inbox`
   - If `"gmail"`: use MCP tool `gmail_search_messages` to search for emails from the last 24 hours in the account's inbox. If MCP is unavailable, warn: "Gmail account '{account.name}' skipped — MCP unavailable" and stop.
   Output a one-line fetch summary using `prefs.display.fetchSummary` and `prefs.display.statusIcons`.

5. **Normalize email data** to a common shape:
   - Outlook results: map `from` → `from.email`, `fromName` → `from.name`
   - Gmail MCP results: extract sender name and email from the response fields

6. **Classify each email** using the resolved categories and the account's config:
   - Check `account.prioritySenders`, `account.keyContacts`, and any category-level `prioritySenders` from `categoryOverrides`
   - Check `account.urgencyRules.flags` and any category-level `urgencyRules.flags`
   - Match against the resolved `downrank` list → classify as IGNORE
   - For personal accounts with rich categories (those in `categoryOverrides` that have their own `prioritySenders` or `urgencyRules`), match emails against each rich category's rules to assign them to the correct category
   - For remaining emails, classify into the best-matching category from the resolved list

7. **Apply noise filters** (if `type.noiseFilters` is not null):
   - After initial classification, apply a second pass:
     - If the email matches `signals_reject` AND does NOT match any `signals_keep` term → reclassify as IGNORE
     - If it matches both → `signals_keep` wins (keep in category)
     - If it matches neither → leave unchanged
   - Also apply any category-level `noiseFilters` from `categoryOverrides` (concatenate with type-level signals)

8. **Output** — group by resolved categories in array order, skipping categories marked `hidden: true`:
   For each visible category that has emails:

   ### [{account.name}] {category.label}
   For each: **[From]** Subject — one line on what's needed and suggested next step

   Lead with the most urgent. Skip empty categories.
```

- [ ] **Step 2: Review the rewritten skill**

Read the file back and verify:
- It loads `account-types.json` in step 1
- It resolves categories via merge in step 2
- It branches on provider in step 4
- It normalizes in step 5
- It applies noise filters in step 7
- Output uses dynamic categories, not hardcoded ones

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/email/email-triage.md
git commit -m "feat: email-triage now loads account type, supports Gmail MCP, and uses dynamic categories"
```

---

### Task 6: Update `orchestrators/triage.md` — mixed providers and personal separation

**Files:**
- Modify: `.claude/commands/orchestrators/triage.md`

- [ ] **Step 1: Rewrite the orchestrator with account type support**

Replace the entire contents of `.claude/commands/orchestrators/triage.md` with:

```markdown
Run a full inbox triage across all configured accounts. $ARGUMENTS

If $ARGUMENTS specifies one or more account IDs (comma-separated), triage only those.
Otherwise, triage every account in `config/companies.json`.

1. Load `config/companies.json`, `config/account-types.json`, and `config/prefs.json`.

2. For each account, resolve its type config:
   - Load type definition from `account-types.json` using `account.accountType` (default: `"business"`)
   - Merge `categoryOverrides`, `downrank`, `noiseFilters`, and scalar overrides per the merge order in the spec

3. Fetch emails per provider — Outlook accounts sequentially (to avoid auth token conflicts), Gmail accounts via MCP:
   - `"outlook"`: `node scripts/fetch-emails.js {account.id} 24 inbox`
   - `"gmail"`: MCP `gmail_search_messages` for last 24 hours. If MCP is unavailable, skip and warn: "Gmail account '{account.name}' skipped — MCP unavailable"
   Track the result (email count or error) for each account.

4. Output a fetch summary using `prefs.display.fetchSummary` before the triage results:
   - `"inline-icons"` → `✅/❌/⚠️ AccountName (N emails) · ... — {date} · Last 24h`
   - `"inline"` → same line without icons
   - `"table"` → one row per account with account, mailbox, count, window columns
   - `"none"` → skip entirely
   Use `prefs.display.statusIcons` for the icon values.

5. Normalize all email data to the common shape:
   - Outlook: `from` → `from.email`, `fromName` → `from.name`
   - Gmail MCP: extract sender name and email from response fields

6. For each account, classify emails using that account's resolved type config:
   - Apply the account's resolved categories, `prioritySenders`, `urgencyRules`, `downrank`
   - For rich categories (from `categoryOverrides`), match against category-level rules
   - Apply noise filters if `type.noiseFilters` is not null (second pass: reject → IGNORE unless keep signal present)
   Never apply one account's rules to another account's emails.

7. **Output — Business accounts** (those with `dailyBrief.section: "main"`):

   ## Action Items — All Business Accounts
   Single prioritized list across all business accounts. Sort by urgency (blocking > response needed > time-sensitive).
   For each: **[Account]** **[From]** Subject — one line on what's needed and suggested next step.

   ## News & Market Digest
   One brief paragraph per business account that had relevant industry or market emails.
   Skip accounts with nothing notable.

   ## FYI
   Short list of informational items across all business accounts worth awareness but requiring no action.
   Label each with the account name.

8. **Output — Personal accounts** (those with `dailyBrief.section: "personal-appendix"`):
   If any personal accounts were triaged, add a divider and:

   ---

   ## Personal Triage

   For each visible (non-hidden) category that has emails, grouped by category in array order:

   ### {category.label}
   For each: **[From]** Subject — one line summary

   ### Everything Else
   Brief count of remaining categorized items not shown above: "N shopping/orders, N newsletters — nothing urgent"

Skip the IGNORE bucket entirely in all sections. Surface the most urgent items first.
```

- [ ] **Step 2: Review the rewritten skill**

Read the file back and verify:
- Loads `account-types.json` in step 1
- Resolves type config per account in step 2
- Handles mixed providers in step 3
- Normalizes in step 5
- Separates business and personal output in steps 7 and 8

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/orchestrators/triage.md
git commit -m "feat: triage orchestrator supports mixed providers and separates personal output"
```

---

### Task 7: Update `reports/daily-brief.md` — personal appendix

**Files:**
- Modify: `.claude/commands/reports/daily-brief.md`

- [ ] **Step 1: Rewrite the daily brief with personal appendix**

Replace the entire contents of `.claude/commands/reports/daily-brief.md` with:

```markdown
Generate my daily morning briefing. $ARGUMENTS

1. Load `config/companies.json`, `config/account-types.json`, and `config/prefs.json`.

2. **Business Section** (accounts where type has `dailyBrief.section: "main"`):

   ## Today's Focus
   Top 3 priorities from `data/tasks.md` (P1 items).
   Only include tasks from business accounts (those with `taskCapture: "auto"`).

   ## Emails Requiring Response
   Summarize emails needing action across business accounts (use recent inbox if accessible).
   Fetch per provider: Outlook via `node scripts/fetch-emails.js`, Gmail via MCP.
   Normalize email data to common shape: Outlook `from`/`fromName` → `from.email`/`from.name`; Gmail MCP → extract sender fields.

   ## Aging Items
   Any P1 tasks from yesterday still open.

   ## Quick Wins
   P2/P3 items I could knock out in under 15 minutes.

3. **Personal Section** (accounts where type has `dailyBrief.section: "personal-appendix"`):
   If no personal accounts are configured, omit this entire section.

   ---

   ## Personal Quick Hits

   Fetch personal account emails (Gmail via MCP). If MCP unavailable, note: "Personal email skipped — MCP unavailable."

   ### Needs Reply
   Emails in the RESPOND category — someone is waiting.

   ### Today's Life Admin
   Bills due, appointments coming up, renewals expiring — anything time-sensitive from BILLS/FINANCE, APPOINTMENTS, SUBSCRIPTIONS/RENEWALS categories.

   ### Hobbies & Commitments
   Items from rich categories (those with their own `urgencyRules` in `categoryOverrides`) that match urgency flags or come from priority senders. Only show items needing attention today.

   ### Everything Else
   Brief count of remaining categorized items not shown above:
   "N shopping/orders, N newsletters, N social — nothing urgent"

Format as a clean, scannable brief. No fluff. Lead with what matters most today.
```

- [ ] **Step 2: Review the rewritten skill**

Read the file back and verify:
- Loads `account-types.json`
- Business section is unchanged in structure
- Personal appendix appears after divider
- Respects `dailyBrief.section` config
- Handles MCP unavailability gracefully

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/reports/daily-brief.md
git commit -m "feat: daily brief adds Personal Quick Hits appendix section"
```

---

## Chunk 3: Documentation & Project Config

### Task 8: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update The Golden Rule**

Replace lines 31-32:
```markdown
### The Golden Rule
`config/companies.json` is the **single source of truth** for all account configuration. If you find yourself writing a company name, email address, contact name, or business rule inside a skill or orchestrator file, stop — it belongs in the config.
```
With:
```markdown
### The Golden Rule
`config/companies.json` is the **single source of truth** for all account-specific configuration (contacts, credentials, overrides). `config/account-types.json` is the **single source of truth** for type-level behavioral defaults (triage categories, noise filters, daily brief config). If you find yourself writing a company name, email address, contact name, business rule, or triage category inside a skill or orchestrator file, stop — it belongs in the config.
```

- [ ] **Step 2: Update Skill Development section**

After the line about `config/prefs.json`, add:
```markdown
- Account type behavioral defaults are loaded from `config/account-types.json` — merge with account-level overrides per the merge order (type defaults → account overrides, account wins for scalars)
```

- [ ] **Step 3: Update Company Context section**

Replace lines 43-46:
```markdown
### Company Context
- Multiple companies are managed — always clarify which company when ambiguous
- Each company may have different communication styles, urgency levels, and key contacts
- Load company config from `config/companies.json` at the start of every task
```
With:
```markdown
### Account Context
- Multiple accounts are managed (business and personal) — always clarify which account when ambiguous
- Each account has an `accountType` (`"business"` or `"personal"`) that determines its behavioral defaults
- Each account has a `provider` (`"outlook"` or `"gmail"`) that determines how emails are fetched
- Business accounts use professional tone, standard triage categories, and auto task capture
- Personal accounts use casual tone, life-admin categories, noise filtering, and manual task capture
- Load account config from `config/companies.json` and type defaults from `config/account-types.json` at the start of every task
```

- [ ] **Step 4: Update Email Management section**

Replace lines 48-52:
```markdown
### Email Management
- Outlook is the primary email client
- Use MCP tools (gmail/outlook) when available; otherwise instruct the user
- Triage by: urgent action required → reply needed → FYI → archive
- Draft emails matching the sender's tone and company voice
```
With:
```markdown
### Email Management
- Outlook is the primary email client for business accounts; Gmail for personal accounts
- Business accounts fetch via `scripts/fetch-emails.js` (Graph API)
- Gmail accounts fetch via MCP `gmail_search_messages`; if MCP is unavailable, skip and warn
- Triage categories are loaded dynamically from the account's type config — do not hardcode categories in skills
- Personal accounts apply noise filters (`signals_keep` / `signals_reject`) to separate transactional from promotional email
- Draft emails matching the sender's tone and account voice
```

- [ ] **Step 5: Update File Paths section**

Add after the `config/prefs.json` line:
```markdown
- Account type defaults: `config/account-types.json`
```

- [ ] **Step 6: Update Do Not section**

Add:
```markdown
- Commit `config/account-types.json` (contains account type configuration)
- Hard-code triage categories in skill files (load from account type config)
```

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with account types, Gmail provider, and dynamic categories"
```

---

### Task 9: Update `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add commented-out Gmail section**

Append to the end of `.env.example`:

```
# --- Gmail API (future: for fetch-gmail.js fallback connector) ---
# Not needed if using MCP Gmail tools.
# PERSONAL_GMAIL_CLIENT_ID=your-gmail-client-id
# PERSONAL_GMAIL_CLIENT_SECRET=your-gmail-client-secret
# PERSONAL_GMAIL_REFRESH_TOKEN=your-gmail-refresh-token
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add commented-out Gmail OAuth env vars to .env.example"
```

---

### Task 10: Create `docs/account-types.md`

**Files:**
- Create: `docs/account-types.md`

- [ ] **Step 1: Write the account types documentation**

```markdown
# Account Types

OfficeOS supports multiple account types to handle both business and personal email management. Each account in `config/companies.json` references a type, and the type's behavioral defaults are defined in `config/account-types.json`.

## How It Works

1. Each account entry has an `accountType` field (`"business"` or `"personal"`)
2. The type definition in `account-types.json` provides default: triage categories, tone, downrank patterns, noise filters, daily brief behavior, and task capture policy
3. Account-level values in `companies.json` override type defaults (account wins for scalar fields)

## Triage Categories

### Business (4 categories)
| Category | Description |
|----------|-------------|
| ACTION REQUIRED | Needs a response or decision |
| FYI / READ | Informational, no action needed |
| NEWS / MARKET | Industry or market updates |
| IGNORE (hidden) | Matches downrank patterns — not displayed |

### Personal (13 categories)
| Category | Description |
|----------|-------------|
| RESPOND | Needs a reply — someone is waiting |
| BILLS / FINANCE | Bills due, statements, bank alerts, tax docs |
| APPOINTMENTS | Medical, dental, auto, personal services |
| HOME / FAMILY | School notices, HOA, household services, family coordination |
| TRAVEL | Bookings, confirmations, itineraries — not promos |
| SHOPPING / ORDERS | Order confirmations, shipping, returns — not deal alerts |
| SUBSCRIPTIONS / RENEWALS | Renewal notices, payment failures — not upsells |
| FITNESS / WELLNESS | Gym, classes, health apps, wellness programs |
| HOBBIES | Clubs, groups, events, gear — personal interests |
| VOLUNTEER | Nonprofit roles, community service, board duties |
| PERSONAL / SOCIAL | Friends, invitations, personal correspondence |
| NEWSLETTERS | Opted-in reads worth scanning — not spam |
| IGNORE (hidden) | Marketing noise — not displayed |

## Flat vs. Rich Categories

**Flat categories** have only an id, label, and description. Most default categories are flat — classification is handled by the account's general `prioritySenders` and `urgencyRules`.

**Rich categories** add their own `prioritySenders`, `urgencyRules`, `downrank`, and optionally `noiseFilters`. Use rich categories for commitments that are complex enough to have their own organizations, contacts, and deadlines (e.g., a competitive sport, a fraternity, a nonprofit board role).

Rich categories are defined in the account's `categoryOverrides` array in `companies.json`.

## Merge Order

1. Load type defaults from `account-types.json`
2. Load account entry from `companies.json`
3. Scalar fields (tone, taskCapture, etc.): account value wins if present
4. `categoryOverrides`: matching `id` → full replace; new `id` → append
5. `downrank`: account array concatenates with type `downrankDefaults`
6. `noiseFilters`: account-level signals concatenate with type-level signals

## Extending Categories

Edit `config/account-types.json` to modify type-level defaults, or add `categoryOverrides` to a specific account in `companies.json`.

To create a new rich category, add an entry to `categoryOverrides` with:
- `id` — unique key (lowercase, hyphenated)
- `label` — display name (ALL CAPS by convention)
- `description` — what belongs here
- `prioritySenders` — (optional) senders that flag emails for this category
- `urgencyRules.flags` — (optional) keywords that make items urgent
- `downrank` — (optional) noise patterns specific to this category

See `config/account-types.example.json` and `config/companies.example.json` for complete examples.
```

- [ ] **Step 2: Commit**

```bash
git add docs/account-types.md
git commit -m "docs: add account types documentation"
```

---

### Task 11: Create `docs/gmail-integration.md`

**Files:**
- Create: `docs/gmail-integration.md`

- [ ] **Step 1: Write the Gmail integration documentation**

```markdown
# Gmail Integration

OfficeOS supports Gmail accounts via MCP (Model Context Protocol) tools available in the Claude Code environment.

## Setup

1. Add a Gmail account entry to `config/companies.json` with `"provider": "gmail"`
2. Ensure the Gmail MCP server is connected in your Claude Code environment
3. Authorize Gmail access when prompted by MCP

No API keys, OAuth setup, or scripts are needed when using MCP.

## How It Works

### Provider Routing

Each account has a `provider` field that determines how emails are fetched:

| Provider | Method | Setup Required |
|----------|--------|---------------|
| `outlook` | `node scripts/fetch-emails.js` (Graph API) | Azure app registration, `.env` credentials |
| `gmail` | MCP `gmail_search_messages` | MCP Gmail server connected |

Skills check `account.provider` and route accordingly. Classification and output logic are identical regardless of provider.

### MCP Gmail Tools Used

- `gmail_search_messages` — fetch recent emails (used by triage and daily brief)
- `gmail_read_message` — read full email content
- `gmail_read_thread` — read email thread for context
- `gmail_create_draft` — draft replies (used by email-draft skill)
- `gmail_get_profile` — verify account access

### Email Normalization

The existing Outlook connector (`fetch-emails.js`) returns flat fields (`from`, `fromName`). Gmail MCP returns its own structure. Skills normalize both to a common shape before classification:

```json
{
  "from": { "name": "Sender Name", "email": "sender@example.com" },
  "subject": "Email subject",
  "received": "2026-03-12T10:00:00Z",
  "preview": "First 300 characters..."
}
```

Normalization happens in the skill layer, not in connectors.

### When MCP Is Unavailable

If MCP Gmail tools are not available, skills skip the Gmail account and display a warning:
> "Gmail account 'Personal' skipped — MCP unavailable"

Business Outlook accounts continue to work normally.

## Future: Script Fallback

A `scripts/fetch-gmail.js` connector is designed but not yet built. When implemented, it will:
- Mirror the `fetch-emails.js` interface: `node scripts/fetch-gmail.js {companyId} {hours} inbox`
- Use Gmail API with OAuth2
- Require `.env` credentials: `{COMPANYID}_GMAIL_CLIENT_ID`, `{COMPANYID}_GMAIL_CLIENT_SECRET`, `{COMPANYID}_GMAIL_REFRESH_TOKEN`
- Return the common email structure directly

## Adding a Gmail Account

1. Add to `config/companies.json`:
```json
{
  "id": "personal",
  "name": "Personal",
  "accountType": "personal",
  "provider": "gmail",
  "myEmail": "you@gmail.com",
  ...
}
```

2. Test with: `/email-triage personal`
```

- [ ] **Step 2: Commit**

```bash
git add docs/gmail-integration.md
git commit -m "docs: add Gmail integration guide"
```

---

### Task 12: Create `docs/personal-accounts.md`

**Files:**
- Create: `docs/personal-accounts.md`

- [ ] **Step 1: Write the personal accounts guide**

```markdown
# Personal Accounts

OfficeOS treats personal accounts as first-class citizens — not simplified versions of business accounts. Executives with active personal lives (competitive sports, fraternity/nonprofit board roles, family coordination) deserve the same triage quality for personal email as for business.

## Why Personal Accounts Matter

Personal inbox management is a significant time sink for busy executives. OfficeOS personal triage:
- Categorizes life admin (bills, appointments, subscriptions) separately from noise
- Surfaces hobby and volunteer commitments with the same urgency awareness as business
- Filters promotional content aggressively — keeps order confirmations, rejects deal alerts
- Appears in the daily brief as a separate "Personal Quick Hits" section

## Setting Up a Personal Account

1. Add an entry to `config/companies.json` with:
   - `"accountType": "personal"` — loads personal triage categories
   - `"provider": "gmail"` — fetches via MCP Gmail tools

2. Add `categoryOverrides` for any hobbies, volunteer roles, or commitments that need their own triage rules (see Rich Categories below)

3. Test with: `/email-triage personal`

## Rich Categories

Generic categories like "HOBBIES" are useful defaults. But if your hobby has its own national organization, tournaments, deadlines, and contacts, it deserves a **rich category** with its own rules.

### Example: Competitive Sport

```json
{
  "id": "iaido",
  "label": "IAIDO",
  "description": "Iaido study, teaching, and competition — local and national",
  "prioritySenders": [
    { "type": "domain", "value": "auskf.org", "label": "National federation" },
    { "type": "name", "value": "Sensei Tanaka", "label": "Instructor" }
  ],
  "urgencyRules": {
    "flags": ["tournament", "registration", "deadline", "seminar", "grading", "exam"]
  },
  "downrank": ["merchandise", "fundraiser spam"]
}
```

### Example: Fraternity/Nonprofit Board

```json
{
  "id": "spe",
  "label": "SIGMA PHI EPSILON",
  "description": "Fraternity — local chapter and national involvement",
  "prioritySenders": [
    { "type": "domain", "value": "sigep.org", "label": "SPE National" },
    { "type": "name", "value": "Chapter President", "label": "Local chapter" }
  ],
  "urgencyRules": {
    "flags": ["chapter meeting", "board", "election", "deadline", "conclave", "convention"]
  },
  "downrank": ["alumni merchandise", "donation solicitation"]
}
```

## Noise Filtering

Personal inboxes get far more promotional noise than business inboxes. The personal account type includes `noiseFilters` that apply a second classification pass:

**Philosophy:** Transactional/actionable emails in, marketing/promotional noise out.

| Keep (transactional) | Reject (promotional) |
|---------------------|---------------------|
| confirmation, receipt, shipped | promotion, deal, offer |
| delivered, reminder, appointment | recommended, trending |
| invoice, due, renewal | you might like, earn |
| booking, itinerary, gate change | reward points, upgrade |

If an email matches both keep and reject signals, **keep wins**.

## Daily Brief

Personal accounts appear at the end of the daily brief in a separate "Personal Quick Hits" section:

1. **Needs Reply** — emails where someone is waiting
2. **Today's Life Admin** — bills due, appointments, renewals
3. **Hobbies & Commitments** — urgent items from rich categories
4. **Everything Else** — count of remaining items ("12 shopping/orders, 4 newsletters — nothing urgent")

Personal accounts do not generate tasks automatically. Use `/task-capture` explicitly if you want to track a personal item.
```

- [ ] **Step 2: Commit**

```bash
git add docs/personal-accounts.md
git commit -m "docs: add personal accounts guide with rich categories and noise filtering"
```

---

## Chunk 4: Verification

### Task 13: End-to-end verification

**Files:** None (read-only verification)

- [ ] **Step 1: Verify all config files parse correctly**

Run:
```bash
cd "d:\OneDrive - Brickell Payments (WORKFORCE)\Documents\OfficeOS"
node -e "JSON.parse(require('fs').readFileSync('config/companies.json','utf8')); console.log('companies.json: OK')"
node -e "JSON.parse(require('fs').readFileSync('config/account-types.json','utf8')); console.log('account-types.json: OK')"
node -e "JSON.parse(require('fs').readFileSync('config/companies.example.json','utf8')); console.log('companies.example.json: OK')"
node -e "JSON.parse(require('fs').readFileSync('config/account-types.example.json','utf8')); console.log('account-types.example.json: OK')"
```
Expected: All four print OK.

- [ ] **Step 2: Verify gitignore coverage**

Run:
```bash
git status config/
```
Expected: `account-types.json` and `companies.json` should NOT appear. `account-types.example.json` and `companies.example.json` should be tracked.

- [ ] **Step 3: Verify all skills reference account-types.json**

Run: grep for `account-types.json` in all skill files:
```bash
grep -r "account-types.json" .claude/commands/
```
Expected: Matches in `email-triage.md`, `triage.md`, and `daily-brief.md`.

- [ ] **Step 4: Verify no hardcoded categories remain in skills**

Run: grep for the old hardcoded pattern:
```bash
grep -r "ACTION REQUIRED" .claude/commands/
```
Expected: No matches in `email-triage.md` (categories are now dynamic). The orchestrator may reference it in output formatting context, which is acceptable.

- [ ] **Step 5: Verify CLAUDE.md references new config**

Run:
```bash
grep "account-types.json" CLAUDE.md
```
Expected: At least 2 matches (Golden Rule section and File Paths section).

- [ ] **Step 6: Test email triage with a business account**

Run: `/email-triage healthcarema`
Expected: Triage works as before — ACTION REQUIRED, FYI/READ, NEWS/MARKET categories. No regressions.

- [ ] **Step 7: Test email triage with the personal account**

Run: `/email-triage personal`
Expected: Uses MCP Gmail tools to fetch, classifies into personal categories (RESPOND, BILLS/FINANCE, etc.), applies noise filters, surfaces IAIDO and SPE categories if matching emails exist.

- [ ] **Step 8: Test the triage orchestrator**

Run: `/triage`
Expected: Fetches all accounts (Outlook + Gmail), business output appears first with standard sections, personal output appears at the end in a separate "Personal Triage" section.

- [ ] **Step 9: Test the daily brief**

Run: `/daily-brief`
Expected: Business sections appear first (Today's Focus, Emails Requiring Response, etc.), then a divider and "Personal Quick Hits" section at the end.

- [ ] **Step 10: Final commit check**

Run: `git log --oneline -10`
Expected: Clean commit history with one commit per task.
