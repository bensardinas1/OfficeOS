# Reasoner Pass (shared fragment)

> Included by `/issues` and the morning-brief skill. Not invoked as a function —
> the running model performs these steps directly.

## Inputs you will have assembled

- **Bundle**: a list of emails, each tagged `survivor` or `heuristic-delete-candidate`.
  Each email has: msgid, account, sender (name + address), subject, preview/body,
  received date, has-list-unsubscribe, and (for candidates) why the heuristic flagged it.
- **Issue index**: the current open issues — for each: `id`, `title`, `aliases`,
  one-line `next_action`, `participants`.
- **Attention profile**: `config/attention-profile.md` (who matters, what's noise).

## What to decide, per email

Reason about the *content*, not just the sender. Produce one record per email:

```json
{
  "msgid": "<id>",
  "verdict": "keep | trash",
  "issue": "<existing-issue-id> | NEW:Concise Topic Title | null",
  "reason": "<one short clause>",
  "next_action_update": "<new next_action for the issue, or empty string>",
  "waiting_on_update": "you | <participant first name> | nobody | null"
}
```

Rules:
- **heuristic-delete-candidate**: decide `verdict`. `trash` if it really is noise
  (broadcast marketing, booth promos, unsubscribe-footer blasts with no personal ask).
  `keep` (rescue) if the heuristic misfired — a real person with a specific ask, a
  transactional notice that matters, anything a priority sender sent. A rescued email
  is then assigned like a survivor.
- **survivor**: `verdict` is always `keep`. Assign `issue`:
  - An existing issue id if it continues that topic.
  - `NEW:Title` if it starts a new topic. Use the SAME title for emails that belong
    together (e.g. two partner meeting requests for the same conference → one
    `NEW:SEAA Partner Meetings`).
  - `null` if it's a genuine keep but not issue-worthy (pure FYI, no thread of work).
- **Personalization test** (the core judgment): "I saw your name on the attendee
  list, want to connect?" from a known/priority contact → keep + issue. "Visit Booth
  107" broadcast → trash or null. An auto-inserted "Hi <FirstName>" on an otherwise
  templated blast is NOT personalization.
- Set `next_action_update` only when this email changes what needs to happen. Set
  `waiting_on_update` to `you` if the ball is in your court, a participant's name if
  you're waiting on them, `nobody` if nothing is pending, or `null` to leave unchanged.

## Output

Emit the records as a JSON array. The deterministic applier (`scripts/issue-apply.js`)
consumes this array; you do not mutate issue files yourself. After the applier runs,
the skill soft-deletes the returned `toTrash` msgids via the existing delete connectors
(`delete-emails.js` / `delete-gmail-emails.js`) — **soft-delete only, never permanent**.
