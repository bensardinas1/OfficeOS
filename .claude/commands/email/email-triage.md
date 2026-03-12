Triage the email inbox for a single company. $ARGUMENTS

$ARGUMENTS is a company ID from `config/companies.json` (e.g. `healthcarema`).
If not provided, ask the user which company to triage.

1. Load `config/companies.json`, `config/prefs.json`, and find the company entry matching $ARGUMENTS.
   Use the company's `id`, `name`, `keyContacts`, `prioritySenders`, `urgencyRules`, and `downrank` fields to drive all classification logic below.

2. Fetch recent emails:
   ```
   node scripts/fetch-emails.js {company.id} 24 inbox
   ```
   Output a one-line fetch summary using `prefs.display.fetchSummary` and `prefs.display.statusIcons`.

3. Classify each email using the company's config — do not apply rules from other companies:
   - **ACTION REQUIRED** — sender matches `company.prioritySenders` or `company.keyContacts`,
     or email body/subject contains any term in `company.urgencyRules.flags`
   - **FYI / READ** — informational, no action needed
   - **NEWS / MARKET** — industry news or market updates worth a brief summary
   - **IGNORE** — matches any category in `company.downrank`

4. Output:

   ### [{company.name}] Emails Requiring Action
   For each: **[From]** Subject — one line on what's needed and suggested next step

   ### [{company.name}] News & Market Summary
   2–3 sentence digest of relevant industry/market emails. Omit if nothing notable.

Lead with the most urgent. Skip the IGNORE bucket entirely.
