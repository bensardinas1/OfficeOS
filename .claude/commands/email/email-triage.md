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
