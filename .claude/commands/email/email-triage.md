Triage the email inbox for a single company. $ARGUMENTS

$ARGUMENTS is a company ID from `config/companies.json` (e.g. `healthcarema`, `personal`).
If not provided, ask the user which account to triage.

1. Load `config/companies.json`, `config/account-types.json`, and `config/prefs.json`.
   Find the account entry matching $ARGUMENTS.
   Determine `account.provider` (default `"outlook"`) and `account.id`.

2. **Fetch and classify:**
   - Outlook accounts: `node scripts/fetch-emails.js {account.id} 24 inbox | node scripts/classify-emails.js {account.id}`
   - Gmail accounts: use MCP `gmail_search_messages` to fetch emails from the last 24 hours in the inbox, then pass the result as JSON to stdin: `echo '<json>' | node scripts/classify-emails.js {account.id}`
     - If MCP is unavailable, warn: "Gmail account '{account.name}' skipped — MCP unavailable" and stop.

   The processor returns `{ accountId, accountName, accountType, categories, deletionCandidates }`.

   Output a one-line fetch summary using `prefs.display.fetchSummary` and `prefs.display.statusIcons`.

3. **Render output:**
   Group emails by the resolved categories (in array order from the processor). Skip categories marked `hidden: true`. For each visible category with emails:

   ### [{account.name}] {category.label}
   For each email: **[From Name]** Subject — one line on what's needed and suggested next step

   Lead with most urgent. Skip empty categories.

4. **Deletion candidates:**
   After all category output, add a divider and list every email in `deletionCandidates`. Number them sequentially, one line each: `N. Sender Name — Subject`. End with:
   "Reply with numbers or ranges to delete (e.g. 'delete 1-12, 15'), or 'delete all'."

   When approved:
   - Outlook accounts: `node scripts/delete-emails.js {account.id} {id1} {id2} ...`
   - Gmail accounts: `node scripts/delete-gmail-emails.js {id1} {id2} ...`
