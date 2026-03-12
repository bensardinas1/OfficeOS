Triage the Healthcare M&A inbox. $ARGUMENTS

1. Run the email fetch script to get recent emails:
   ```
   node scripts/fetch-emails.js healthcarema 24 inbox
   ```

2. Load company context from `config/companies.json` for the `healthcarema` account.

3. Classify each email using these rules:
   - **ACTION REQUIRED** — from internal staff, key contacts (Leo Orozco, Alain Rosello, Kevin Deeb, Rick Arce), M&A lead sources (bizbuysell, mergernetwork), or any email containing a direct request
   - **FYI / READ** — informational, no action needed
   - **NEWS / MARKET** — industry news, market updates, listing notices worth summarizing
   - **IGNORE** — bulk email, marketing, newsletters, unsubscribe

4. Output two sections:

   ### Emails Requiring Action
   For each: **[From]** Subject — one line on what's needed and suggested next step

   ### News & Market Summary
   2–3 sentence digest of any relevant industry/market emails worth knowing about

Lead with the most urgent. Skip the IGNORE bucket entirely.
