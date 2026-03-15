Run a full inbox triage across all configured accounts. $ARGUMENTS

If $ARGUMENTS specifies one or more account IDs (comma-separated), triage only those.
Otherwise, triage every account in `config/companies.json`.

1. Load `config/companies.json` and `config/prefs.json`.

2. **Fetch and classify each account** — Outlook accounts sequentially (to avoid auth token conflicts), Gmail accounts via MCP:
   - `"outlook"`: `node scripts/fetch-emails.js {account.id} 24 inbox | node scripts/classify-emails.js {account.id}`
   - `"gmail"`: use MCP `gmail_search_messages` for the last 24 hours, then pass result as JSON to stdin: `echo '<json>' | node scripts/classify-emails.js {account.id}`
     - If MCP is unavailable, skip and warn: "Gmail account '{account.name}' skipped — MCP unavailable"

   The processor returns `{ accountId, accountName, accountType, categories, deletionCandidates }`.
   Track the result (email count or error) for each account.

3. Output a fetch summary using `prefs.display.fetchSummary` before the triage results:
   - `"inline-icons"` → `✅/❌/⚠️ AccountName (N emails) · ... — {date} · Last 24h`
   - `"inline"` → same line without icons
   - `"table"` → one row per account with account, mailbox, count, window columns
   - `"none"` → skip entirely
   Use `prefs.display.statusIcons` for the icon values.

4. **Output — Business accounts** (those with `dailyBrief.section: "main"` in their resolved type config):

   ## Action Items — All Business Accounts
   Single prioritized list across all business accounts. Sort by urgency (blocking > response needed > time-sensitive).
   For each: **[Account]** **[From]** Subject — one line on what's needed and suggested next step.

   ## News & Market Digest
   One brief paragraph per business account that had relevant industry or market emails.
   Skip accounts with nothing notable.

   ## FYI
   Short list of informational items across all business accounts worth awareness but requiring no action.
   Label each with the account name.

5. **Output — Personal accounts** (those with `dailyBrief.section: "personal-appendix"` in their resolved type config):
   If any personal accounts were triaged, add a divider and:

   ---

   ## Personal Triage

   For each personal account, render categories in array order from the processor result. Skip categories marked `hidden: true`. For each visible category with emails:

   ### {category.label}
   For each: **[From]** Subject — one line summary

   ### Everything Else
   Brief count of remaining categorized items not shown above: "N shopping/orders, N newsletters — nothing urgent"

   Skip the IGNORE bucket entirely in all sections. Surface the most urgent items first.

6. **Deletion candidates:**
   After all category output, add a divider and list every email in `deletionCandidates` across all accounts. Number them sequentially, one line each: `N. [Account] Sender Name — Subject`. End with:
   "Reply with numbers or ranges to delete (e.g. 'delete 1-12, 15'), or 'delete all'."

   When approved, route by provider:
   - Outlook accounts: `node scripts/delete-emails.js {account.id} {id1} {id2} ...`
   - Gmail accounts: `node scripts/delete-gmail-emails.js {id1} {id2} ...`
