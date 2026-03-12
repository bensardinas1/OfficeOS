Run a full inbox triage across all configured companies. $ARGUMENTS

If $ARGUMENTS specifies one or more company IDs (comma-separated), triage only those.
Otherwise, triage every company in `config/companies.json`.

1. Load `config/companies.json` and `config/prefs.json`.

2. For each company, fetch emails sequentially (to avoid auth token conflicts):
   ```
   node scripts/fetch-emails.js {company.id} 24 inbox
   ```
   Track the result (email count or error) for each company.

3. Output a fetch summary using `prefs.display.fetchSummary` before the triage results:
   - `"inline-icons"` → `✅/❌/⚠️ CompanyName (N emails) · ... — {date} · Last 24h`
   - `"inline"` → same line without icons
   - `"table"` → one row per company with account, mailbox, count, window columns
   - `"none"` → skip entirely
   Use `prefs.display.statusIcons` for the icon values.

4. For each company, classify emails using that company's own config fields:
   `keyContacts`, `prioritySenders`, `urgencyRules.flags`, and `downrank`.
   Never apply one company's rules to another company's emails.

4. Merge all results and output three sections:

   ## Action Items — All Accounts
   Single prioritized list across all companies. Sort by urgency (blocking > response needed > time-sensitive).
   For each: **[Company]** **[From]** Subject — one line on what's needed and suggested next step.

   ## News & Market Digest
   One brief paragraph per company that had relevant industry or market emails.
   Skip companies with nothing notable.

   ## FYI
   Short list of informational items across all accounts worth awareness but requiring no action.
   Label each with the company name.

Skip the IGNORE bucket entirely. Surface the most urgent items first regardless of which company they belong to.
