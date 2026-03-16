Draft an email for an OfficeOS account. $ARGUMENTS

$ARGUMENTS may include:
- Account ID (required — ask if missing or ambiguous)
- Mode: "reply <messageId>" OR "reply" with pasted thread content OR "compose <recipient> <subject> [purpose]"

---

## 1. Parse intent

Determine **reply** vs **compose** from $ARGUMENTS.

Extract account ID. If missing or ambiguous, ask: *"Which account? (healthcarema / brickellpay / summitmiami / personal)"*

---

## 2. Load account config

Load `config/companies.json`. Find the account entry. Read:
- `account.provider` (`"outlook"` or `"gmail"`)
- `account.voiceProfile` (signOff, openingStyle, formality, urgencyToneOverrides, contactOverrides)

If `voiceProfile` is missing for the account, stop and tell the user: *"No voiceProfile found for account '{accountId}'. Add a voiceProfile block to config/companies.json before drafting."*

---

## 3. Get thread context

**Reply mode:**
- If a `messageId` was provided and `provider === "outlook"`:
  Run: `node scripts/fetch-thread.js {account.id} {messageId}`
  This returns `{ threadId, subject, messages: [...] }`. Use the full thread for context. Note the most recent `messageId` for `replyToMessageId`.
- If a `messageId` was provided and `provider === "gmail"`:
  First, use MCP `gmail_read_message` with the `messageId` to retrieve the message and extract its `threadId` field. Then call MCP `gmail_read_thread` with that `threadId` to get the full thread context. The `threadId` is what gets passed to `save-gmail-draft.js`.
- If thread content was pasted inline: use as-is.
- If fetch fails: ask the user to paste the relevant email content.

**Compose mode:**
- Gather recipient(s), subject, and purpose from $ARGUMENTS.
- If `purpose` is not provided, ask for it before drafting.

---

## 4. Determine tone

Apply in this priority order (later wins):

1. **Account defaults** — `voiceProfile.formality`, `voiceProfile.openingStyle`, `voiceProfile.signOff`
2. **Urgency override** — if this is a reply and the email's triage category matches a key in `voiceProfile.urgencyToneOverrides`, apply that tone guidance. If no key matches, stay at account defaults.
3. **Contact override** — if any recipient's email matches an entry in `voiceProfile.contactOverrides`, apply only the fields present in that entry (e.g. if only `formality` is set, `openingStyle` stays from step 2).

**`openingStyle` behavior:**
- `"direct"` — No greeting. Open with the first substantive sentence.
- `"warm"` — One sentence acknowledging the person or context, then into substance.
- `"formal"` — Full formal opener ("I hope this message finds you well. I am writing to...").

---

## 5. Draft

Write the email:
- Apply `openingStyle` for the first sentence
- State the purpose or answer clearly
- Close with a next step or ask if appropriate
- Sign off with `voiceProfile.signOff`

Show the draft clearly formatted.

---

## 6. Review loop

Present four options after the draft:

> **approve** · **revise** (tell me what to change) · **adjust tone** (e.g. "make it warmer") · **cancel**

- **approve** → proceed to step 7
- **revise** → apply the user's direction and redraft, return to step 6
- **adjust tone** → update tone settings and redraft, return to step 6
- **cancel** → confirm *"Draft discarded — nothing saved."* and stop

---

## 7. Save to Drafts-OfficeOS

On approval, construct the draft payload and pipe it to the appropriate save script.

**Outlook accounts:**
Payload: `{ "to": [...], "cc": [...], "subject": "...", "body": "...", "replyToMessageId": "..." }`
(omit `replyToMessageId` for compose)

```bash
echo '<payload-json>' | node scripts/save-draft.js {account.id}
```

**Gmail accounts:**
Payload: `{ "to": [...], "cc": [...], "subject": "...", "body": "...", "threadId": "..." }`
(omit `threadId` for compose; `threadId` is the `id` from `gmail_read_thread` response)

```bash
echo '<payload-json>' | node scripts/save-gmail-draft.js {account.id}
```

Confirm to user: *"Draft saved to Drafts-OfficeOS — open in Outlook/Gmail to review and send."*

**Never send automatically.**
