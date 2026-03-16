Draft an email for an OfficeOS account. $ARGUMENTS

$ARGUMENTS may include:
- Account ID (required — ask if missing or ambiguous)
- Mode: "reply <messageId>" OR "reply" with pasted thread content OR "compose <recipient> <subject> [purpose]"

---

## 1. Parse intent

Determine **reply** vs **compose** from $ARGUMENTS.

Extract account ID. If missing or ambiguous, load all account IDs from `config/companies.json` and ask: *"Which account? ({list of account IDs})"*

---

## 2. Load account config

Load `config/companies.json`. Find the account entry. Read:
- `account.provider` (`"outlook"` or `"gmail"`)
- `account.voiceProfile` (signOff, openingStyle, formality, urgencyToneOverrides, contactOverrides)

If `voiceProfile` is missing for the account, stop and tell the user: *"No voiceProfile found for account '{accountId}'. Add a voiceProfile block to config/companies.json before drafting."*

Also check for `config/voice-profile-{accountId}.json`. If it exists, load:
- `styleNotes` — prose description of the user's writing patterns
- `sampleEmails` — curated examples of the user's actual sent emails
- `corrections` — learned revisions from prior drafts

The voice profile is optional — if the file does not exist, proceed with the structured `voiceProfile` only.

---

## 3. Get thread context

**Reply mode:**
- If a `messageId` was provided and `provider === "outlook"`:
  Run: `node scripts/fetch-thread.js {account.id} {messageId}`
  This returns `{ threadId, subject, messages: [...] }`. Use the full thread for context. Note the most recent `messageId` for `replyToMessageId`.
- If a `messageId` was provided and `provider === "gmail"`:
  First, use MCP `gmail_read_message` with the `messageId` to retrieve the message and extract its `threadId` field. Then call MCP `gmail_read_thread` with that `threadId` to get the full thread context. Extract the sender address (for `to`), CC list, and subject (prefixed with "Re: " if not already) from the thread — these are needed for the save payload since Gmail drafts are built from scratch. The `threadId` is what gets passed to `save-gmail-draft.js`.
- If thread content was pasted inline: use as-is.
- If fetch fails: ask the user to paste the relevant email content.

**Compose mode:**
- Gather recipient(s), subject, and purpose from $ARGUMENTS.
- If `purpose` is not provided, ask for it before drafting.

---

## 4. Determine tone

Apply in this priority order (later wins):

1. **Account defaults** — `voiceProfile.formality`, `voiceProfile.openingStyle`, `voiceProfile.signOff`
2. **Urgency override** — if this is a reply and the email's triage category (or category override ID) matches a key in `voiceProfile.urgencyToneOverrides`, apply that tone guidance. If no key matches, stay at account defaults.
3. **Contact override** — if any recipient's email matches an entry in `voiceProfile.contactOverrides`, apply only the fields present in that entry (e.g. if only `formality` is set, `openingStyle` stays from step 2).
4. **Personal voice** — if a voice profile was loaded:
   - Apply `styleNotes` as additional guidance for word choice, sentence structure, and tone
   - Select 2–3 `sampleEmails` whose `context` tag best matches the current draft context (e.g., prefer external examples for external emails) and use them as few-shot references for how this user actually writes
   - Pass all `corrections` with the draft; apply any whose `rule` addresses a pattern present in this draft (Claude determines relevance — not a keyword match)

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
  - After redrafting, if a voice profile exists for this account: identify the most materially changed phrase or sentence (not the whole draft), and append a correction to `config/voice-profile-{accountId}.json`:
    ```json
    { "date": "YYYY-MM-DD", "original": "...", "revised": "...", "rule": "one-sentence style principle" }
    ```
  - If the revised draft demonstrates a pattern not already well-represented in `sampleEmails`, offer: *"This revision is a good example of your voice. Add it to your sample emails?"* — the bank grows up to 10; if at 10, offer to replace the least contextually diverse example.
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
(omit `threadId` for compose; use the same `threadId` obtained in step 3)

```bash
echo '<payload-json>' | node scripts/save-gmail-draft.js {account.id}
```

Confirm to user: *"Draft saved to Drafts-OfficeOS — open in Outlook/Gmail to review and send."*

**Never send automatically.**
