Set up a voice profile for an OfficeOS email account. $ARGUMENTS

---

## 1. Parse arguments

Extract account ID from $ARGUMENTS. If missing, load `config/companies.json` and present all account IDs dynamically: *"Which account? ({list of IDs})"*

---

## 2. Fetch sent emails

Run:
```bash
node scripts/fetch-sent-emails.js {accountId} 60
```

Parse the JSON output. If the command fails, ask the user to paste 5–10 representative sent emails instead.

If the result contains fewer than 20 emails, warn: *"Only {count} sent emails found — the voice profile may be less accurate. You can paste additional examples to improve it."*

---

## 3. Check for existing corrections

If `config/voice-profile-{accountId}.json` already exists, read the `corrections` array. If it has 50+ entries, consolidate during analysis: merge redundant corrections into the new `styleNotes` and prune the array to retain only corrections not yet captured in `styleNotes`. Show the consolidated result in step 4.

If fewer than 50 corrections exist, preserve them as-is in the new profile.

---

## 4. Analyze voice patterns

Analyze the sent emails. For each, note:
- Sentence length tendencies (short and punchy vs. long and detailed)
- Opening patterns (how emails typically start — greeting? straight to substance?)
- Closing patterns (sign-offs, final sentences before sign-off)
- Formality markers (contractions, slang, hedging language, or formal phrasing)
- Words and phrases the user favors
- Words and phrases the user avoids
- How tone shifts by recipient type (internal vs external, known contacts vs strangers)

Generate:
- **`styleNotes`** — a prose summary (3–8 sentences) of the above patterns
- **`sampleEmails`** — select 5–10 representative examples across different contexts:
  - Mix of internal and external recipients
  - Mix of formal and casual tone
  - Mix of short and longer emails
  - Tag each with a `context` string (e.g., "external, formal follow-up" or "internal, quick ask")

---

## 5. Present profile for review

Show the user:
1. The generated `styleNotes`
2. The selected `sampleEmails` (subject + first few lines of body + context tag)

Present options:
> **approve** · **revise** (tell me what to adjust in the notes) · **re-analyze** (add pasted emails or re-run) · **cancel**

- **approve** → proceed to step 6
- **revise** → apply the user's direction to `styleNotes`, re-present
- **re-analyze** → incorporate pasted emails or re-run with different selection criteria, return to step 4
- **cancel** → confirm *"Voice profile setup cancelled — nothing saved."* and stop

---

## 6. Save profile

Write to `config/voice-profile-{accountId}.json`:

```json
{
  "accountId": "{accountId}",
  "generatedAt": "{ISO timestamp}",
  "styleNotes": "{generated notes}",
  "sampleEmails": [{selected examples}],
  "corrections": [{preserved from existing file, or empty array}]
}
```

Confirm: *"Voice profile saved for {accountId}. Your drafts from this account will now use this style."*

---

## 7. Suggest voiceProfile updates

Compare the analysis findings to the existing `voiceProfile` in `config/companies.json`:
- If `openingStyle` doesn't match reality (e.g., config says "direct" but user clearly opens warm), suggest: *"Your sent emails suggest a '{detected}' opening style, but your config has '{current}'. Want me to update it?"*
- Same for `formality`.

Only suggest — do not change without approval.
