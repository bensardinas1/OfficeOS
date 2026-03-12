# Account Types, Gmail Integration & Personal Accounts

**Date:** 2026-03-12
**Status:** Approved
**Scope:** Config schema extension, Gmail provider routing, personal account triage, daily brief changes, documentation

---

## Problem

OfficeOS currently treats all accounts as business Outlook accounts. There is no way to:
- Distinguish business from personal accounts
- Connect Gmail inboxes
- Triage personal email with categories relevant to an executive's full life (hobbies, volunteer roles, fitness, family, finances)
- Include personal email in the daily brief without mixing it into business priorities

Executives with active personal lives spend significant time on personal inbox management. OfficeOS should handle this as a first-class concern, not an afterthought.

## Design Decisions

### Approach Selected: Separate `account-types.json` (Option B)

Behavioral defaults live in a dedicated `config/account-types.json` file, separate from `config/companies.json`. Each account references a type by key. This keeps company entries focused on account-specific data (contacts, credentials, overrides) while type definitions hold the behavioral templates.

**Why this approach over alternatives:**
- Embedding defaults in `companies.json` (Option A) bloats the file and mixes structural concerns
- Inlining everything per account (Option C) causes massive duplication and violates DRY
- Separate file allows iterating on type definitions independently of account data

---

## Section 1: `config/account-types.json`

A new config file defining behavioral templates per account type. Each type specifies default triage categories, tone, noise filtering, downrank patterns, daily brief behavior, and task capture policy.

### Schema

```json
{
  "version": 1,
  "<type-key>": {
    "label": "string — display name",
    "tone": "string — default tone for drafts",
    "triageCategories": [
      {
        "id": "string — unique key",
        "label": "string — display label",
        "description": "string — what belongs here",
        "hidden": "boolean (optional, defaults to false) — if true, items are classified but not displayed (e.g., IGNORE)"
      }
    ],
    "downrankDefaults": ["string — default downrank patterns"],
    "noiseFilters": "object | null — noise filtering rules (null means no noise filtering for this type)",
    "dailyBrief": {
      "includeTasks": "boolean — include task log items in brief",
      "includeCalendar": "boolean — include calendar items in brief",
      "section": "string — 'main' or 'personal-appendix' (fixed enum; new types must use one of these two values)"
    },
    "taskCapture": "string — 'auto' (capture tasks from triage) or 'manual' (only when user asks)"
  }
}
```

### Business Type

```json
{
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
  }
}
```

Business accounts set `noiseFilters` to `null`. Business inboxes have less promotional noise and the existing `downrank` + `urgencyRules` system handles classification adequately. Skills must null-check `noiseFilters` before applying — if `null`, skip noise filtering entirely.

### Personal Type

```json
{
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

### Noise Filter Application Logic

When `noiseFilters` is not `null`, skills apply it during classification as follows:

1. First, classify the email into a triage category based on sender, subject, and content (same as today)
2. Then, if `noiseFilters` exists, apply a second pass:
   - If the email matches `signals_reject` **and does not** match any `signals_keep` term → reclassify as IGNORE
   - If the email matches both `signals_keep` and `signals_reject` → `signals_keep` wins (keep the email in its category)
   - If the email matches neither → leave classification unchanged
3. This is a hard filter — rejected emails move to IGNORE, not a soft weight adjustment

Account-level `categoryOverrides` can also carry their own `noiseFilters` to extend the type-level filters. Category-level `noiseFilters` merge with the type-level ones: `signals_keep` arrays concatenate, `signals_reject` arrays concatenate. Category-level signals take precedence in conflicts.

### Additional Schema Notes

- **`version` field:** Skills do not currently validate this field; it exists for future schema migration.
- **`triageCategories` ordering:** The array order determines display order in triage output. List categories in the order they should appear (most important first, IGNORE last).
- **`categoryOverrides` replacement:** When an override matches an existing category by `id`, it is a **full replacement** — all fields must be specified in the override. Omitted fields do not fall back to the type default. This means if you override `"ignore"`, you must include `"hidden": true` explicitly.

### Extensibility

Categories are the primary extension point. The `account-types.json` file provides baseline defaults. Users customize by:

1. Editing `account-types.json` directly to add/remove/modify default categories for a type
2. Using `categoryOverrides` in their account entry in `companies.json` to add rich, account-specific categories (see Section 2)
3. An `.example` file (`config/account-types.example.json`) ships as the baseline template

The live `config/account-types.json` is gitignored, same pattern as `companies.json`.

---

## Section 2: `companies.json` Schema Changes

### New Fields Per Account

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `accountType` | `string` | Yes | Key into `account-types.json` (`"business"` or `"personal"`) |
| `provider` | `string` | Yes | `"outlook"` or `"gmail"` — determines data fetch method |
| `categoryOverrides` | `array` | No | Account-specific category additions or replacements |

### General Merge Precedence

When a field exists in both the account type defaults (`account-types.json`) and the account entry (`companies.json`), **the account-level value wins**. This applies to all scalar fields (`tone`, `taskCapture`, etc.). For example, an account with `"accountType": "personal"` can set `"tone": "casual-professional"` to override the personal type's default `"casual"`.

Array fields follow specific merge rules documented below.

### `categoryOverrides` Schema

Each entry in `categoryOverrides` follows the same shape as a `triageCategories` entry, with optional rich fields:

```json
{
  "id": "string — matches an existing category id to override, or a new id to append",
  "label": "string — display label",
  "description": "string — what belongs here",
  "prioritySenders": [
    { "type": "domain|name|keyword", "value": "string", "label": "string" }
  ],
  "urgencyRules": {
    "flags": ["string — urgency keywords for this category"]
  },
  "downrank": ["string — category-specific downrank patterns"],
  "noiseFilters": {
    "signals_keep": ["string — additional keep signals for this category"],
    "signals_reject": ["string — additional reject signals for this category"]
  }
}
```

### Merge Order

At runtime, skills merge in this order:
1. Load account type defaults from `account-types.json`
2. Load account entry from `companies.json`
3. Scalar fields (tone, taskCapture, etc.): account value wins if present
4. For each item in `categoryOverrides`:
   - If `id` matches an existing default category → replace it
   - If `id` is new → append it to the category list
5. Account-level `downrank` array (if present) extends (concatenates with) `downrankDefaults` from the type
6. Account-level `noiseFilters` (if present) extends type-level: `signals_keep` arrays concatenate, `signals_reject` arrays concatenate

### Structure Note

The personal account entry is appended to the existing `companies` array in `companies.json`, inside the `{ "companies": [...] }` wrapper. The `defaultCompany` field should remain set to a business account — personal accounts should not be the default. Example:

```json
{
  "companies": [
    { "id": "healthcarema", "accountType": "business", "provider": "outlook", ... },
    { "id": "brickellpay", "accountType": "business", "provider": "outlook", ... },
    { "id": "summitmiami", "accountType": "business", "provider": "outlook", ... },
    { "id": "personal", "accountType": "personal", "provider": "gmail", ... }
  ],
  "defaultCompany": "healthcarema"
}
```

### Example: Personal Account with Rich Categories

```json
{
  "id": "personal",
  "name": "Personal",
  "accountType": "personal",
  "provider": "gmail",
  "myEmail": "ben@example.com",
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

### Migration

Existing business accounts get two new fields added:
```json
"accountType": "business",
"provider": "outlook"
```

Skills that don't find `accountType` should default to `"business"` and `provider` to `"outlook"` for backward compatibility.

**Cleanup:** The Summit Miami entry in `companies.json` has a malformed `keyContacts` entry that uses the `prioritySenders` shape (`{ "type": "domain", "value": "deebpa.com", "label": "..." }`) instead of the `{ "name", "role", "priority" }` shape. This should be fixed during migration — move it to `prioritySenders` where it belongs.

Additionally, the existing `email-triage.md` skill currently hardcodes four triage categories (ACTION REQUIRED, FYI/READ, NEWS/MARKET, IGNORE) directly in the prompt. After this implementation, those hardcoded categories must be replaced with dynamic loading from the account's type config.

---

## Section 3: Provider Routing

### Fetch Strategy

Skills branch on `provider` when fetching emails:

| Provider | Primary Method | Fallback |
|----------|---------------|----------|
| `outlook` | `node scripts/fetch-emails.js {id} {hours} inbox` | — |
| `gmail` | MCP `gmail_search_messages` | `node scripts/fetch-gmail.js {id} {hours} inbox` (future) |

### Routing Logic in Skills

```
1. Read account.provider
2. If "outlook" → call fetch-emails.js connector
3. If "gmail"  → call MCP gmail_search_messages
                  If MCP is unavailable and fetch-gmail.js does not yet exist:
                  → skip this account, warn user: "Gmail account '{name}' skipped — MCP unavailable and no fallback connector configured"
                  (future: fall back to fetch-gmail.js if MCP unavailable)
4. Normalize result to common email structure
5. Proceed with classification (unchanged)
```

### Common Email Structure

Both providers normalize to the same shape before classification. **Normalization happens in the skill layer**, not in the connectors — this avoids breaking changes to existing connector output.

The existing `fetch-emails.js` returns flat fields:
```json
{
  "id": "string",
  "subject": "string",
  "from": "string (email address)",
  "fromName": "string",
  "received": "ISO 8601 timestamp",
  "isRead": "boolean",
  "importance": "string",
  "hasAttachments": "boolean",
  "preview": "string (first 300 chars)"
}
```

Skills normalize all provider outputs to this common shape before classification:
```json
{
  "id": "string",
  "subject": "string",
  "from": { "name": "string", "email": "string" },
  "received": "ISO 8601 timestamp",
  "isRead": "boolean",
  "importance": "string",
  "hasAttachments": "boolean",
  "preview": "string (first 300 chars)"
}
```

Normalization mappings:
- **Outlook (fetch-emails.js):** `from` → `from.email`, `fromName` → `from.name`
- **Gmail (MCP):** extract `from.name` and `from.email` from the MCP response's sender fields
- **Gmail (future fetch-gmail.js):** return the common structure directly

### Orchestrator Behavior

The `/triage` orchestrator handles mixed providers:
1. Fetch Outlook accounts sequentially (existing behavior — avoids auth token conflicts)
2. Fetch Gmail accounts via MCP (no token conflict with Outlook)
3. Classify each account using its own type + category config
4. Merge results as before, but business accounts render in the main sections and personal accounts render separately

### Future: `scripts/fetch-gmail.js`

Designed but not built in this phase. When implemented:
- Mirrors the `fetch-emails.js` interface: `node scripts/fetch-gmail.js {companyId} {hours} inbox`
- Uses Gmail API with OAuth2 (credentials in `.env`: `{COMPANYID}_GMAIL_CLIENT_ID`, `{COMPANYID}_GMAIL_CLIENT_SECRET`, `{COMPANYID}_GMAIL_REFRESH_TOKEN`)
- Returns the common email structure directly (no normalization needed)
- Token caching in `data/.token-cache-{companyId}.json`

---

## Section 4: Daily Brief — Personal Appendix

### Current Structure (Unchanged for Business)

```
## Today's Focus
Top 3 P1 priorities from data/tasks.md

## Emails Requiring Response
Action items from business account triage

## Aging Items
P1 tasks from yesterday still open

## Quick Wins
P2/P3 items under 15 minutes
```

### New: Personal Quick Hits Section

Appended after the business sections, separated by a divider:

```
---

## Personal Quick Hits

### Needs Reply
Emails in the RESPOND category across personal accounts

### Today's Life Admin
Bills due, appointments coming up, renewals expiring — anything time-sensitive

### Hobbies & Commitments
Items from rich categories (Iaido, SPE, etc.) that need attention today.
Only surfaces items matching urgency flags or from priority senders.

### Everything Else
Brief count of remaining categorized items:
"12 shopping/orders, 4 newsletters, 3 social — nothing urgent"
```

### Behavior Rules

- Personal accounts with `dailyBrief.section: "personal-appendix"` render here
- Personal accounts with `taskCapture: "manual"` are excluded from the Tasks/Focus sections
- The "Everything Else" line provides signal-to-noise awareness without clutter
- If no personal accounts are configured, the section is omitted entirely
- Rich categories (those with their own `urgencyRules`) get surfaced in "Hobbies & Commitments" when urgent; otherwise they fold into "Everything Else" counts

### Display Preferences

No changes to `config/prefs.json` are needed. The personal appendix uses the same `fetchSummary` format and `statusIcons` as business sections. The section structure (headings, divider) is defined in the skill prompt, not in prefs.

---

## Section 5: Example Files and Documentation

### Config Files

| File | Purpose | Git Status |
|------|---------|------------|
| `config/account-types.json` | Live account type definitions | Gitignored |
| `config/account-types.example.json` | Baseline template with business + personal types | Committed |
| `config/companies.json` | Live account config (updated with new fields) | Gitignored |
| `config/companies.example.json` | Updated template showing new fields + personal account example | Committed |

### Documentation

| File | Purpose |
|------|---------|
| `docs/account-types.md` | Account type system: what types are, how categories work (flat vs. rich), merge order (type defaults → account overrides), how to extend with custom categories |
| `docs/gmail-integration.md` | Gmail connectivity: MCP setup, provider routing, adding a Gmail account, future `fetch-gmail.js` fallback design |
| `docs/personal-accounts.md` | Use case guide: why personal accounts matter, setting up rich categories for hobbies/volunteer roles, noise filtering philosophy (transactional in, marketing out), daily brief personal appendix |

### Gitignore Update

No changes needed. The existing `.gitignore` already uses `config/*.json` with exclusions for `*.example.json` and `prefs.json`. The new `config/account-types.json` is automatically gitignored, and `config/account-types.example.json` is automatically included.

### CLAUDE.md Updates

The following sections of `CLAUDE.md` need updating:
- **File Paths:** Add `config/account-types.json` (account type behavioral defaults)
- **Architecture / Golden Rule:** Expand to reference both `companies.json` and `account-types.json` as sources of truth — `companies.json` for account-specific data, `account-types.json` for type-level behavioral defaults
- **Email Management:** Add Gmail alongside Outlook; mention MCP as primary Gmail connector
- **Key Conventions / Company Context:** Note that accounts can be business or personal, and that `accountType` and `provider` fields drive behavior
- **Do Not:** Add `config/account-types.json` to the "do not commit" list

---

## Files Changed

### New Files
- `config/account-types.json` — live config (gitignored)
- `config/account-types.example.json` — committed baseline template
- `docs/account-types.md` — account type system documentation
- `docs/gmail-integration.md` — Gmail integration documentation
- `docs/personal-accounts.md` — personal accounts guide

### Modified Files
- `config/companies.json` — add `accountType`, `provider` to existing accounts; add personal Gmail account entry; fix Summit Miami `keyContacts` bug
- `config/companies.example.json` — add new fields, personal account example with `categoryOverrides`
- `.claude/commands/email/email-triage.md` — load account type, use dynamic categories from type config, branch on provider, add normalization step, apply noise filters when present (replaces hardcoded category list)
- `.claude/commands/orchestrators/triage.md` — handle mixed providers, separate personal output section, skip unavailable Gmail accounts with warning
- `.claude/commands/reports/daily-brief.md` — add Personal Quick Hits appendix section, respect `dailyBrief.section` config
- `CLAUDE.md` — document new config file, account type concepts, Gmail provider (see Section 5)
- `.env.example` — document future Gmail OAuth env vars (commented out, for when `fetch-gmail.js` is built)

### Future Files (Designed, Not Built)
- `scripts/fetch-gmail.js` — Gmail API connector (fallback for MCP)
