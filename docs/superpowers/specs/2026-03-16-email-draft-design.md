# Email Draft Flow — Design Spec
**Date:** 2026-03-16
**Status:** Review Complete

## Overview

Enhance the `email-draft` skill and add three new connector scripts to support a full draft → review → save-to-drafts workflow. Drafts are saved to a dedicated `Drafts-OfficeOS` folder (Outlook) or label (Gmail) for human approval and sending. The system never sends email automatically.

Supports both **reply** mode (with thread context fetched or pasted) and **compose** mode (fresh email). Voice and tone are driven by a structured `voiceProfile` config block per account.

---

## Layer 1 — New Connector Scripts

### `scripts/fetch-thread.js <accountId> <messageId>`
- Fetches the full email thread for an Outlook account via Microsoft Graph API
- Returns JSON to stdout:
  ```json
  {
    "threadId": "...",
    "subject": "...",
    "messages": [
      {
        "messageId": "...",
        "from": "email@example.com",
        "fromName": "Name",
        "to": ["recipient@example.com"],
        "received": "2026-03-16T12:00:00Z",
        "body": "..."
      }
    ]
  }
  ```
- The most recent message's `messageId` is used as `replyToMessageId` when saving the draft
- For Gmail, thread fetching is handled via MCP `gmail_read_thread` — no new script needed
- Zero business logic; pure data connector

### `scripts/save-draft.js <accountId>`
- Reads draft data from stdin as JSON: `{ to, cc, subject, body, replyToMessageId? }`
- Creates message in a `Drafts-OfficeOS` mail folder via Microsoft Graph API
- Creates the `Drafts-OfficeOS` folder on first use if it does not exist
- Returns JSON: `{ draftId }`

### `scripts/save-gmail-draft.js <accountId>`
- Accepts `<accountId>` as first argument (consistent with all other connectors)
- Reads draft data from stdin as JSON: `{ to, cc, subject, body, threadId? }`
- Creates a Gmail draft via Gmail API using credentials from `config/companies.json`
- Applies/creates a `Drafts-OfficeOS` label alongside the system Drafts label
- Returns JSON: `{ draftId }`

---

## Config — Voice Profile

A `voiceProfile` block is added to each account entry in `config/companies.json`.

```json
"voiceProfile": {
  "signOff": "Regards,\n\nBen",
  "openingStyle": "direct",
  "formality": "professional",
  "urgencyToneOverrides": {
    "action": "direct and time-sensitive — lead with the ask, no preamble",
    "respond": "prompt and clear — answer the question, offer next step"
  },
  "contactOverrides": [
    {
      "email": "contact@example.com",
      "formality": "casual-professional",
      "signOff": "Regards,\n\nBen"
    }
  ]
}
```

**Fields:**

| Field | Description |
|---|---|
| `signOff` | Closing signature for all outgoing emails from this account |
| `openingStyle` | One of `"direct"`, `"warm"`, `"formal"` — see definitions below |
| `formality` | `"professional"` \| `"casual-professional"` \| `"casual"` |
| `urgencyToneOverrides` | Keyed by triage category ID; adjusts tone when replying to emails from that category. Falls back to all account-level `voiceProfile` settings (`formality`, `openingStyle`, `signOff`) if the category key is absent. |
| `contactOverrides` | Per-recipient overrides; only the fields present in the override entry are applied — unspecified fields fall through to the prior priority level's value. Wins over urgency and account defaults for the fields it specifies. |

**`openingStyle` definitions:**
- `"direct"` — No greeting or pleasantry. Open with the first substantive sentence (e.g., "I've reviewed the agreement and have a few questions.")
- `"warm"` — One-sentence opener acknowledging the person or context (e.g., "Thanks for sending this over."), then into substance
- `"formal"` — Full formal opener (e.g., "I hope this message finds you well. I am writing to..."), used for legal, regulatory, or first-contact contexts

**Tone priority order (last wins):**
1. Account-level `voiceProfile` (formality, openingStyle, signOff)
2. `urgencyToneOverrides` — if email came from a known triage category, apply override
3. `contactOverrides` — if recipient matches, this wins over everything else

Business accounts default to `"formality": "professional"` and `"openingStyle": "direct"`. The personal Gmail account uses `"formality": "casual-professional"` and `"openingStyle": "warm"`.

---

## Layer 2 — Enhanced `email-draft.md` Skill

### Invocation
Each `accountId` maps to exactly one account entry in `config/companies.json`. There is no ambiguity between providers.

```
/email:email-draft <accountId> [reply <messageId>|<pasted thread>] [compose <recipient> <subject> [<purpose>]]
```

Arguments are flexible — the skill infers mode from context.

### Flow

**1. Parse intent**
Determine reply vs. compose from `$ARGUMENTS`. Extract account ID. If account is ambiguous or missing, ask before proceeding.

**2. Load context**
- Load account `voiceProfile` from `config/companies.json`
- If **reply + message ID**: run `fetch-thread.js <accountId> <messageId>` (Outlook) or MCP `gmail_read_thread` (Gmail)
- If **reply + pasted content**: use directly
- If **compose**: gather recipient, subject, purpose from arguments. If `purpose` is not provided, ask for it interactively before drafting.

**3. Determine tone**
Apply in priority order (last wins):
1. Account-level `voiceProfile` (formality, openingStyle, signOff)
2. `urgencyToneOverrides` — if email came from a known triage category and a matching key exists; fall back to account defaults if key is absent
3. `contactOverrides` — if recipient email matches an override entry, this wins over all other settings

**4. Draft**
Write the email:
- Open per `openingStyle`
- State purpose or answer directly
- Close with clear next step or ask if appropriate
- Sign off per `signOff`

**5. Review loop**
Show draft. Present four options:
- **approve** — proceed to save
- **revise** — user provides direction, redraft
- **adjust tone** — e.g. "make it warmer", redraft with updated tone
- **cancel** — discard draft, confirm to user that nothing was saved, exit

Loop until approved or cancelled.

**6. Save to drafts**
On approval, pipe the draft payload to the appropriate script. Payload format differs by provider:
- **Outlook**: `{ to, cc, subject, body, replyToMessageId? }` → `echo '<draft-json>' | node scripts/save-draft.js <accountId>`
  - `replyToMessageId` is the `messageId` of the most recent message from `fetch-thread.js` output
- **Gmail**: `{ to, cc, subject, body, threadId? }` → `echo '<draft-json>' | node scripts/save-gmail-draft.js <accountId>`
  - `threadId` is the `id` field on the thread object returned by MCP `gmail_read_thread`

Confirm to user: *"Draft saved to Drafts-OfficeOS — open in Outlook/Gmail to review and send."*

**Never sends automatically.**

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| `Drafts-OfficeOS` folder/label doesn't exist | Created on first use by save script; transparent to skill |
| Account ID not specified or ambiguous | Skill asks before proceeding |
| Thread fetch fails (bad ID, deleted) | Skill falls back — asks user to paste thread content |
| Recipient not in `contactOverrides` | Account-level `voiceProfile` applies; no error |
| Reply to multi-recipient thread | Skill prompts for CC if thread had multiple participants |
| Gmail drafts folder | `Drafts-OfficeOS` label applied alongside system Drafts label for filterability |
| `urgencyToneOverrides` key absent for email's category | Falls back to account-level `formality`/`openingStyle` silently |
| Compose mode with no `purpose` provided | Skill prompts for purpose interactively before drafting |
| User cancels during review loop | Draft discarded, nothing saved, user confirmed |

---

## Out of Scope

- Auto-sending — humans always approve and send from their email client
- Read receipts, scheduling, or send-later
- Bulk drafting across multiple accounts in one command
