# Per-User Voice Profile Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-user voice profiles that learn email writing style from sent mail and refine over time through draft feedback.

**Architecture:** A new Layer-1 connector (`fetch-sent-emails.js`) pulls sent emails for both Outlook and Gmail. A new Layer-2 skill (`voice-setup.md`) orchestrates voice analysis and profile creation. The existing `email-draft.md` skill is enhanced to load voice profiles and capture corrections during the review loop.

**Tech Stack:** Node.js ESM, Microsoft Graph API (`@microsoft/microsoft-graph-client`), Google Gmail API (`googleapis`), Node built-in test runner (`node:test`), existing `buildGraphClient` and `buildGmailClient` auth helpers.

**Spec:** `docs/superpowers/specs/2026-03-16-voice-profile-design.md`

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `scripts/fetch-sent-emails.js` | Fetch recent sent emails for Outlook and Gmail, return normalized JSON |
| Create | `scripts/test/fetch-sent-emails.test.js` | Unit tests for `transformSentEmails` and `isOriginalEmail` |
| Create | `.claude/commands/email/voice-setup.md` | Onboarding skill: fetch sent emails, analyze voice, save profile |
| Modify | `.claude/commands/email/email-draft.md` | Load voice profile, use in drafting, capture corrections on revise |

---

## Chunk 1: fetch-sent-emails.js

### Task 1: Write failing tests for `transformSentEmails` and `isOriginalEmail`

**Files:**
- Create: `scripts/test/fetch-sent-emails.test.js`

`fetch-sent-emails.js` exports two pure functions:

1. `isOriginalEmail(email)` — returns `true` if the email is user-authored (not a forward, auto-reply, or calendar accept). Checks:
   - Subject does not start with `FW:` or `Fwd:` (case-insensitive)
   - Body does not contain auto-reply markers (`out of office`, `automatic reply`)
   - Subject does not contain calendar markers (`Accepted:`, `Declined:`, `Tentative:`)

2. `transformSentEmails(graphMessages)` — takes an array of Graph API message objects from the sentitems folder and returns our normalized schema. Similar to `transformGraphMessages` in `fetch-thread.js` but for sent mail.

Graph API sentitems messages have this shape:
```json
{
  "id": "msg-abc",
  "subject": "Contract Review",
  "toRecipients": [{ "emailAddress": { "address": "alice@example.com" } }],
  "ccRecipients": [],
  "sentDateTime": "2026-03-16T12:00:00Z",
  "body": { "content": "<p>Hello</p>", "contentType": "html" }
}
```

- [ ] **Write the test file:**

```js
// scripts/test/fetch-sent-emails.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transformSentEmails, isOriginalEmail } from "../fetch-sent-emails.js";

describe("isOriginalEmail", () => {
  it("returns true for a normal sent email", () => {
    assert.equal(isOriginalEmail({ subject: "Contract Review", body: "Please review." }), true);
  });

  it("rejects forwarded emails (FW: prefix)", () => {
    assert.equal(isOriginalEmail({ subject: "FW: Meeting notes", body: "See below." }), false);
  });

  it("rejects forwarded emails (Fwd: prefix, case-insensitive)", () => {
    assert.equal(isOriginalEmail({ subject: "fwd: Budget doc", body: "FYI." }), false);
  });

  it("rejects auto-replies", () => {
    assert.equal(isOriginalEmail({ subject: "Re: Hello", body: "I am currently out of office." }), false);
  });

  it("rejects calendar accepts", () => {
    assert.equal(isOriginalEmail({ subject: "Accepted: Team Standup", body: "" }), false);
  });

  it("rejects calendar declines", () => {
    assert.equal(isOriginalEmail({ subject: "Declined: Lunch meeting", body: "" }), false);
  });

  it("rejects automatic reply markers", () => {
    assert.equal(isOriginalEmail({ subject: "Re: Question", body: "This is an automatic reply." }), false);
  });
});

describe("transformSentEmails", () => {
  const graphMessages = [
    {
      id: "sent-001",
      subject: "Contract Review",
      toRecipients: [{ emailAddress: { address: "alice@acme.com" } }],
      ccRecipients: [{ emailAddress: { address: "carol@acme.com" } }],
      sentDateTime: "2026-03-16T12:00:00Z",
      body: { content: "<p>Please review the attached.</p>", contentType: "html" },
    },
    {
      id: "sent-002",
      subject: "FW: Old document",
      toRecipients: [{ emailAddress: { address: "bob@acme.com" } }],
      ccRecipients: [],
      sentDateTime: "2026-03-16T13:00:00Z",
      body: { content: "See attached.", contentType: "text" },
    },
  ];

  it("maps sent messages to normalized schema", () => {
    const result = transformSentEmails(graphMessages);
    assert.equal(result.length, 1); // FW: email filtered out
    assert.equal(result[0].subject, "Contract Review");
    assert.deepEqual(result[0].to, ["alice@acme.com"]);
    assert.deepEqual(result[0].cc, ["carol@acme.com"]);
    assert.equal(result[0].sent, "2026-03-16T12:00:00Z");
  });

  it("strips HTML from body", () => {
    const result = transformSentEmails(graphMessages);
    assert.ok(!result[0].body.includes("<p>"));
    assert.ok(result[0].body.includes("Please review the attached."));
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(transformSentEmails([]), []);
    assert.deepEqual(transformSentEmails(null), []);
  });
});
```

- [ ] **Run test to confirm it fails:**

```bash
node --test scripts/test/fetch-sent-emails.test.js
```

Expected: error — `fetch-sent-emails.js` does not exist yet.

---

### Task 2: Implement `fetch-sent-emails.js`

**Files:**
- Create: `scripts/fetch-sent-emails.js`

The connector determines the provider from `config/companies.json` and fetches sent emails via the appropriate API. It exports `transformSentEmails` and `isOriginalEmail` as pure functions for testing.

- [ ] **Write the implementation:**

```js
/**
 * fetch-sent-emails.js <accountId> [count]
 *
 * Fetches recent sent emails for voice profile analysis.
 * Returns JSON array to stdout: [{ to, cc, subject, body, sent }, ...]
 *
 * Usage:
 *   node scripts/fetch-sent-emails.js <accountId> 60
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraphClient } from "./graph-client.js";
import { buildGmailClient } from "./gmail-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = join(__dirname, "../config/companies.json");
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function isOriginalEmail({ subject, body }) {
  const subj = (subject || "").toLowerCase();
  const text = (body || "").toLowerCase();

  // Filter forwarded messages
  if (subj.startsWith("fw:") || subj.startsWith("fwd:")) return false;

  // Filter calendar responses
  if (/^(accepted|declined|tentative):/.test(subj)) return false;

  // Filter auto-replies
  if (text.includes("out of office") || text.includes("automatic reply")) return false;

  return true;
}

export function transformSentEmails(messages) {
  if (!messages || messages.length === 0) return [];

  return messages
    .map((m) => ({
      to: (m.toRecipients || []).map((r) => r.emailAddress.address),
      cc: (m.ccRecipients || []).map((r) => r.emailAddress.address),
      subject: m.subject || "",
      body: m.body?.contentType === "html" ? stripHtml(m.body.content) : (m.body?.content ?? ""),
      sent: m.sentDateTime,
    }))
    .filter((e) => isOriginalEmail(e));
}

async function fetchOutlook(accountId, count) {
  const client = await buildGraphClient(accountId);
  const response = await client
    .api("/me/mailFolders/sentitems/messages")
    .select("id,subject,toRecipients,ccRecipients,body,sentDateTime")
    .orderby("sentDateTime desc")
    .top(count)
    .get();
  return transformSentEmails(response.value || []);
}

async function fetchGmail(count) {
  const gmail = await buildGmailClient();
  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: "in:sent",
    maxResults: count,
  });
  const messageIds = (listRes.data.messages || []).map((m) => m.id);

  const messages = [];
  for (const id of messageIds) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
    const headers = msg.data.payload?.headers || [];
    const getHeader = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

    // Extract body from payload
    let bodyContent = "";
    let bodyType = "text";
    const parts = msg.data.payload?.parts || [];
    if (parts.length > 0) {
      const textPart = parts.find((p) => p.mimeType === "text/plain");
      const htmlPart = parts.find((p) => p.mimeType === "text/html");
      if (textPart?.body?.data) {
        bodyContent = Buffer.from(textPart.body.data, "base64").toString("utf-8");
      } else if (htmlPart?.body?.data) {
        bodyContent = Buffer.from(htmlPart.body.data, "base64").toString("utf-8");
        bodyType = "html";
      }
    } else if (msg.data.payload?.body?.data) {
      bodyContent = Buffer.from(msg.data.payload.body.data, "base64").toString("utf-8");
      if (msg.data.payload?.mimeType === "text/html") bodyType = "html";
    }

    messages.push({
      toRecipients: getHeader("To").split(",").map((addr) => ({
        emailAddress: { address: addr.trim().replace(/.*<([^>]+)>/, "$1") },
      })),
      ccRecipients: getHeader("Cc") ? getHeader("Cc").split(",").map((addr) => ({
        emailAddress: { address: addr.trim().replace(/.*<([^>]+)>/, "$1") },
      })) : [],
      subject: getHeader("Subject"),
      sentDateTime: getHeader("Date"),
      body: { content: bodyContent, contentType: bodyType },
    });
  }
  return transformSentEmails(messages);
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith("fetch-sent-emails.js")) {
  const accountId = process.argv[2];
  const count = parseInt(process.argv[3] || "50", 10);
  if (!accountId) {
    console.error("Usage: node scripts/fetch-sent-emails.js <accountId> [count]");
    process.exit(1);
  }
  try {
    const config = loadConfig();
    const account = config.companies.find((c) => c.id === accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);

    let emails;
    if (account.provider === "gmail") {
      emails = await fetchGmail(count);
    } else {
      emails = await fetchOutlook(accountId, count);
    }
    console.log(JSON.stringify(emails, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}
```

**Note:** The Gmail body extraction handles both single-part and multipart messages. It prefers `text/plain` over `text/html`, falling back to HTML with `stripHtml`. The `To` and `Cc` header parsing handles both `"Name <email>"` and bare `"email"` formats via regex.

**Also note:** `buildGmailClient` currently accepts no arguments and reads credentials from `.env`. The `accountId` is used only to look up the provider in `config/companies.json`. This is the same known gap documented in `save-gmail-draft.js`.

- [ ] **Run tests to confirm they pass:**

```bash
node --test scripts/test/fetch-sent-emails.test.js
```

Expected: all 10 tests pass.

- [ ] **Run full test suite:**

```bash
npm test
```

Expected: all tests pass (48 existing + 10 new = 58).

- [ ] **Commit:**

```bash
git add scripts/fetch-sent-emails.js scripts/test/fetch-sent-emails.test.js
git commit -m "feat: add fetch-sent-emails.js connector with isOriginalEmail filter and tests"
```

---

## Chunk 2: voice-setup.md skill

### Task 3: Create the voice-setup skill

**Files:**
- Create: `.claude/commands/email/voice-setup.md`

This is a markdown skill file (not executable code). It orchestrates the voice profile onboarding flow: fetch → analyze → review → save.

- [ ] **Write the skill file:**

```markdown
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
```

- [ ] **Verify the skill file was saved correctly:**

```bash
cat ".claude/commands/email/voice-setup.md"
```

Expected: the full skill content is visible.

- [ ] **Commit:**

```bash
git add .claude/commands/email/voice-setup.md
git commit -m "feat: add voice-setup skill for per-user voice profile onboarding"
```

---

## Chunk 3: email-draft.md enhancements

### Task 4: Add voice profile loading and drafting guidance to email-draft skill

**Files:**
- Modify: `.claude/commands/email/email-draft.md`

Three changes to the existing skill:

**Change 1 — Step 2 (Load account config): add voice profile loading**

After the existing `voiceProfile` loading paragraph, add:

```markdown
Also check for `config/voice-profile-{accountId}.json`. If it exists, load:
- `styleNotes` — prose description of the user's writing patterns
- `sampleEmails` — curated examples of the user's actual sent emails
- `corrections` — learned revisions from prior drafts

The voice profile is optional — if the file does not exist, proceed with the structured `voiceProfile` only.
```

**Change 2 — Step 4 (Determine tone): add voice profile layer**

After the existing 3-tier priority list, add a new tier:

```markdown
4. **Personal voice** — if a voice profile was loaded:
   - Apply `styleNotes` as additional guidance for word choice, sentence structure, and tone
   - Select 2–3 `sampleEmails` whose `context` tag best matches the current draft context (e.g., prefer external examples for external emails) and use them as few-shot references for how this user actually writes
   - Pass all `corrections` with the draft; apply any whose `rule` addresses a pattern present in this draft (Claude determines relevance — not a keyword match)
```

**Change 3 — Step 6 (Review loop): add correction capture on revise**

After the existing `revise` bullet, add:

```markdown
  - After redrafting, if a voice profile exists for this account: identify the most materially changed phrase or sentence (not the whole draft), and append a correction to `config/voice-profile-{accountId}.json`:
    ```json
    { "date": "YYYY-MM-DD", "original": "...", "revised": "...", "rule": "one-sentence style principle" }
    ```
  - If the revised draft demonstrates a pattern not already well-represented in `sampleEmails`, offer: *"This revision is a good example of your voice. Add it to your sample emails?"* — the bank grows up to 10; if at 10, offer to replace the least contextually diverse example.
```

- [ ] **Apply the three changes to the existing file**

Read `.claude/commands/email/email-draft.md` and make the modifications described above. Do NOT replace the entire file — add to the existing content at the specified locations.

- [ ] **Verify the skill file reads correctly:**

```bash
cat ".claude/commands/email/email-draft.md"
```

Expected: the original 7-step flow with the three additions visible.

- [ ] **Run full test suite to confirm nothing broke:**

```bash
npm test
```

Expected: all tests pass (no test changes in this task — skill files are not executable code).

- [ ] **Commit:**

```bash
git add .claude/commands/email/email-draft.md
git commit -m "feat: enhance email-draft skill with voice profile loading, few-shot examples, and correction capture"
```

---

## Final Verification

- [ ] **Run the full test suite one last time:**

```bash
npm test
```

Expected: all tests pass (should include fetch-sent-emails tests alongside existing tests).

- [ ] **Smoke test voice-setup** by invoking `/email:voice-setup healthcarema` and verifying it:
  1. Runs `fetch-sent-emails.js` to pull sent emails
  2. Analyzes voice patterns
  3. Presents `styleNotes` and `sampleEmails` for review
  4. On approve, writes `config/voice-profile-healthcarema.json`

- [ ] **Smoke test email-draft with voice profile** by invoking `/email:email-draft healthcarema compose test@example.com "Test subject" "Quick test"` and verifying it:
  1. Loads the voice profile alongside the structured `voiceProfile`
  2. Applies `styleNotes` and includes sample emails as few-shot references
  3. On revise, captures a correction to the voice profile file
