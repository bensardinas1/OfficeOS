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
