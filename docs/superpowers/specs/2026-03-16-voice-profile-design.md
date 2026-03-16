# Per-User Voice Profile — Design Spec
**Date:** 2026-03-16
**Status:** Draft

## Overview

Add a per-user voice profile system that learns each user's email writing style from their sent mail and refines it over time through draft feedback. Voice profiles are stored as separate JSON files per account, augmenting the existing `voiceProfile` block in `companies.json` with prose style notes, curated sample emails, and accumulated corrections.

Each OfficeOS installation is local to one user's PC — no multi-tenancy or shared state.

---

## Voice Profile File

Each account gets `config/voice-profile-{accountId}.json` (gitignored). This file augments the existing `voiceProfile` in `companies.json` — it does not replace it.

```json
{
  "accountId": "healthcarema",
  "generatedAt": "2026-03-16T14:00:00Z",
  "styleNotes": "Writes in short, direct sentences. Rarely uses greetings — opens with substance. Favors 'Let me know' over 'Please advise'. Never uses 'I hope this finds you well'. Signs off with 'Regards' universally.",
  "sampleEmails": [
    {
      "to": "recipient@example.com",
      "subject": "Contract Review",
      "body": "...",
      "context": "internal, routine follow-up"
    }
  ],
  "corrections": [
    {
      "date": "2026-03-17",
      "original": "Would you be available for a call this week to explore this further?",
      "revised": "Do you have time for a call this week?",
      "rule": "Avoid 'explore this further' — too corporate. Keep asks simple."
    }
  ]
}
```

**Fields:**

| Field | Description |
|---|---|
| `accountId` | Account this profile belongs to |
| `generatedAt` | ISO timestamp of when the profile was last generated |
| `styleNotes` | Prose summary of writing patterns extracted from sent emails |
| `sampleEmails` | 5–10 curated sent emails with context tags, used as few-shot examples at draft time |
| `corrections` | Learned revisions from the draft review loop — original text, user's revision, and a derived rule |

---

## Layer 1 — New Connector Script

### `scripts/fetch-sent-emails.js <accountId> [count]`

Pulls recent sent emails for voice analysis. Pure data connector, zero analysis logic.

- `count` defaults to 50
- **Outlook:** queries Graph API `GET /me/mailFolders/sentitems/messages` ordered by `sentDateTime desc`, selects `id, subject, toRecipients, ccRecipients, body, sentDateTime`
- **Gmail:** uses the existing `buildGmailClient` from `scripts/gmail-client.js` to query the Gmail API directly (`users.messages.list` with `q: "in:sent"`, then `users.messages.get` for each message to retrieve `id, payload.headers (To, Cc, Subject, Date), payload.body`). This follows the same direct-API pattern as `delete-gmail-emails.js` and `save-gmail-draft.js` — the script layer uses the Gmail API for bulk operations, while MCP is used only for interactive single-message reads in skills.
- Strips HTML from bodies (reuses the `stripHtml` pattern from `fetch-thread.js`)
- Filters out forwarded messages (`FW:` prefix), auto-replies, and calendar accepts — only emails with original body content
- Returns JSON array to stdout:

```json
[
  {
    "to": ["recipient@example.com"],
    "cc": [],
    "subject": "Contract Review",
    "body": "plain text body...",
    "sent": "2026-03-16T12:00:00Z"
  }
]
```

---

## Layer 2 — New Skill: `/email:voice-setup`

### Invocation

```
/email:voice-setup <accountId>
```

### Flow

**1. Parse arguments**
Extract account ID from `$ARGUMENTS`. If missing, load all account IDs from `config/companies.json` and present them dynamically: *"Which account? ({list of account IDs})"*

**2. Fetch sent emails**
Run: `node scripts/fetch-sent-emails.js <accountId> 60`

If the connector fails or returns fewer than 20 emails, warn the user that the profile may be less accurate and offer to supplement with pasted examples.

**3. Analyze voice patterns**
Feed the sent emails to Claude (in-conversation) with a structured analysis prompt. Extract:
- Sentence length tendencies
- Opening patterns (how emails typically start)
- Closing patterns (sign-offs, final sentences before sign-off)
- Formality markers
- Words/phrases favored
- Words/phrases avoided
- How tone shifts by recipient type (internal vs external, known vs unknown)

Generate:
- `styleNotes` — prose summary of the above patterns
- `sampleEmails` — select 5–10 representative examples across different contexts (internal vs external, formal vs casual, short vs long), each tagged with a `context` string

**4. Present profile for review**
Show the user their generated `styleNotes` and the selected sample emails. Present options:
- **approve** — save the profile
- **revise** — user adjusts the notes, re-present
- **re-analyze** — pull different emails or add pasted ones, re-run analysis
- **cancel** — discard, nothing saved

**5. Save**
Write to `config/voice-profile-{accountId}.json` with `corrections` as an empty array. Confirm: *"Voice profile saved. Your drafts will now use this style."*

**6. Suggest voiceProfile updates**
If the analysis reveals the `openingStyle` or `formality` in `companies.json` doesn't match reality (e.g., config says "direct" but user clearly opens warm), suggest updating those fields.

---

## Layer 2 — Enhanced `/email:email-draft`

### Loading (step 2 addition)
After loading `voiceProfile` from `companies.json`, also load `config/voice-profile-{accountId}.json` if it exists. If the file doesn't exist, the skill works exactly as today — no hard dependency.

### Tone determination (step 4 addition)
After resolving the 3-tier tone cascade (account defaults → urgency override → contact override), layer on the voice profile:
- Apply `styleNotes` as additional drafting guidance
- Select 2–3 `sampleEmails` that best match the current context (e.g., if composing an external email, prefer external examples) and include them as few-shot references
- Pass all `corrections` to Claude with the draft prompt; instruct it to apply any whose `rule` addresses a pattern present in this draft's context or content (Claude determines relevance, not a keyword algorithm)

**Updated priority order:**
1. Account-level `voiceProfile` (structural: formality, openingStyle, signOff)
2. Urgency/contact overrides (situational adjustments)
3. `styleNotes` + `sampleEmails` + `corrections` (personal voice — shapes the actual language)

### Refinement (step 6 addition)
When the user chooses **revise** in the review loop:
- Claude identifies the most materially changed phrase or sentence (not the whole draft), stores the before/after as `original`/`revised`, and generates a one-sentence `rule` summarizing the style principle
- Append the correction to the `corrections` array in the voice profile file
- If the revised draft demonstrates a pattern not already well-represented in `sampleEmails` (e.g., a new context type, a notably more natural phrasing), offer to add it: *"This revision is a good example of your voice. Add it to your sample emails?"* — `sampleEmails` grows up to a maximum of 10; if already at 10, offer to replace the least contextually diverse example

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Voice profile file doesn't exist | Skill works as today — structured `voiceProfile` only, no degradation |
| User has fewer than 20 sent emails | Warn that profile may be less accurate, proceed with what's available, suggest supplementing with pasted examples |
| Sent emails are mostly forwarded/auto-generated | Connector filters these out — only include emails with original body content |
| `corrections` array grows large (50+) | On next `/email:voice-setup` run, consolidation happens automatically during step 3 (analysis): Claude merges redundant corrections into the updated `styleNotes`, then prunes the `corrections` array to retain only corrections not yet captured in `styleNotes`. The consolidated result is shown to the user in step 4 for review before saving. |
| User runs voice-setup again | Overwrites `styleNotes` and `sampleEmails` from fresh analysis, preserves existing `corrections` (unless consolidated per row above) |
| Multiple accounts with different voices | Each account gets its own file — expected that a user writes differently across accounts |
| Sample email swap offered but declined | No swap, correction still saved to `corrections` array |

---

## Out of Scope

- Multi-user / shared installations — each user has their own OfficeOS instance
- GUI / web interface for voice profile management
- Cloud-hosted deployment
- Claude API as a script-layer dependency (analysis stays in-skill)
- Auto-refinement without user interaction (corrections only happen when user explicitly revises)
- Voice profile sharing/export between users
