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
