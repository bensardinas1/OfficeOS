# Email Draft Flow Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reply/compose email drafting to OfficeOS with per-account voice profiles, saving drafts to a `Drafts-OfficeOS` folder/label for human approval and sending.

**Architecture:** Three new Layer-1 connector scripts handle thread fetching and draft saving for Outlook and Gmail. A `voiceProfile` block in `config/companies.json` drives tone, formality, and sign-off per account. The `email-draft.md` skill orchestrates all of this into a draft → review loop → save flow.

**Tech Stack:** Node.js ESM, Microsoft Graph API (`@microsoft/microsoft-graph-client`), Google Gmail API (`googleapis`), Node built-in test runner (`node:test`), existing `buildGraphClient` and `buildGmailClient` auth helpers.

**Spec:** `docs/superpowers/specs/2026-03-16-email-draft-design.md`

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `scripts/fetch-thread.js` | Outlook: fetch full thread by messageId, return normalized schema |
| Create | `scripts/save-draft.js` | Outlook: ensure Drafts-OfficeOS folder, save draft message |
| Create | `scripts/save-gmail-draft.js` | Gmail: ensure Drafts-OfficeOS label, save draft message |
| Create | `scripts/test/fetch-thread.test.js` | Unit tests for `transformGraphMessages` |
| Create | `scripts/test/save-draft.test.js` | Unit tests for `buildOutlookMessageBody` |
| Create | `scripts/test/save-gmail-draft.test.js` | Unit tests for `buildRfc2822Message` |
| Modify | `config/companies.json` | Add `voiceProfile` block to each account |
| Modify | `.claude/commands/email/email-draft.md` | Rewrite skill with full draft flow |

---

## Chunk 1: fetch-thread.js

### Task 1: Write failing tests for `transformGraphMessages`

**Files:**
- Create: `scripts/test/fetch-thread.test.js`

`transformGraphMessages` is a pure exported function that takes the array of message objects returned by the Graph API and returns our normalized thread schema.

Graph API returns messages in this shape:
```json
[
  {
    "id": "msg-abc",
    "conversationId": "thread-xyz",
    "subject": "Re: Contract",
    "from": { "emailAddress": { "name": "Alice", "address": "alice@example.com" } },
    "toRecipients": [{ "emailAddress": { "address": "ben@example.com" } }],
    "receivedDateTime": "2026-03-16T12:00:00Z",
    "body": { "content": "<p>Hello</p>", "contentType": "html" }
  }
]
```

- [ ] **Write the test file:**

```js
// scripts/test/fetch-thread.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transformGraphMessages } from "../fetch-thread.js";

const graphMessages = [
  {
    id: "msg-001",
    conversationId: "thread-xyz",
    subject: "Re: Contract Review",
    from: { emailAddress: { name: "Alice", address: "alice@acme.com" } },
    toRecipients: [{ emailAddress: { name: "Ben", address: "ben@example.com" } }],
    ccRecipients: [],
    receivedDateTime: "2026-03-16T10:00:00Z",
    body: { content: "<p>Please review the attached.</p>", contentType: "html" },
  },
  {
    id: "msg-002",
    conversationId: "thread-xyz",
    subject: "Re: Contract Review",
    from: { emailAddress: { name: "Ben", address: "ben@example.com" } },
    toRecipients: [{ emailAddress: { name: "Alice", address: "alice@acme.com" } }],
    ccRecipients: [{ emailAddress: { name: "Carol", address: "carol@acme.com" } }],
    receivedDateTime: "2026-03-16T11:00:00Z",
    body: { content: "<p>Will do.</p>", contentType: "html" },
  },
];

describe("transformGraphMessages", () => {
  it("returns threadId and subject from first message", () => {
    const result = transformGraphMessages(graphMessages);
    assert.equal(result.threadId, "thread-xyz");
    assert.equal(result.subject, "Re: Contract Review");
  });

  it("maps each message to normalized schema", () => {
    const result = transformGraphMessages(graphMessages);
    assert.equal(result.messages.length, 2);
    const first = result.messages[0];
    assert.equal(first.messageId, "msg-001");
    assert.equal(first.from, "alice@acme.com");
    assert.equal(first.fromName, "Alice");
    assert.deepEqual(first.to, ["ben@example.com"]);
    assert.equal(first.received, "2026-03-16T10:00:00Z");
    assert.ok(first.body.includes("Please review"));
  });

  it("includes cc recipients", () => {
    const result = transformGraphMessages(graphMessages);
    const second = result.messages[1];
    assert.deepEqual(second.cc, ["carol@acme.com"]);
  });

  it("strips html tags from body", () => {
    const result = transformGraphMessages(graphMessages);
    assert.ok(!result.messages[0].body.includes("<p>"));
    assert.ok(result.messages[0].body.includes("Please review the attached."));
  });

  it("returns messages in received order (oldest first)", () => {
    const reversed = [graphMessages[1], graphMessages[0]];
    const result = transformGraphMessages(reversed);
    assert.equal(result.messages[0].messageId, "msg-001");
  });
});
```

- [ ] **Run test to confirm it fails:**

```bash
node --test scripts/test/fetch-thread.test.js
```

Expected: error — `fetch-thread.js` does not exist yet.

---

### Task 2: Implement `fetch-thread.js`

**Files:**
- Create: `scripts/fetch-thread.js`

- [ ] **Write the implementation:**

```js
/**
 * fetch-thread.js <accountId> <messageId>
 *
 * Fetches the full email thread for an Outlook account via Microsoft Graph API.
 * Returns JSON to stdout: { threadId, subject, messages: [...] }
 *
 * Usage:
 *   node scripts/fetch-thread.js <accountId> <messageId>
 */
import { buildGraphClient } from "./graph-client.js";

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

export function transformGraphMessages(messages) {
  const sorted = [...messages].sort(
    (a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime)
  );
  const first = sorted[0];
  return {
    threadId: first.conversationId,
    subject: first.subject,
    messages: sorted.map((m) => ({
      messageId: m.id,
      from: m.from.emailAddress.address,
      fromName: m.from.emailAddress.name,
      to: (m.toRecipients || []).map((r) => r.emailAddress.address),
      cc: (m.ccRecipients || []).map((r) => r.emailAddress.address),
      received: m.receivedDateTime,
      body: m.body?.contentType === "html" ? stripHtml(m.body.content) : (m.body?.content ?? ""),
    })),
  };
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith("fetch-thread.js")) {
  const [, , accountId, messageId] = process.argv;
  if (!accountId || !messageId) {
    console.error("Usage: node scripts/fetch-thread.js <accountId> <messageId>");
    process.exit(1);
  }
  const client = await buildGraphClient(accountId);
  // Fetch the source message to get conversationId
  const msg = await client.api(`/me/messages/${messageId}`).select("conversationId").get();
  const conversationId = msg.conversationId;
  // Fetch all messages in the conversation
  const response = await client
    .api("/me/messages")
    .filter(`conversationId eq '${conversationId}'`)
    .select("id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,body")
    .orderby("receivedDateTime asc")
    .top(50)
    .get();
  const result = transformGraphMessages(response.value);
  console.log(JSON.stringify(result, null, 2));
}
```

- [ ] **Run tests to confirm they pass:**

```bash
node --test scripts/test/fetch-thread.test.js
```

Expected: all 5 tests pass.

- [ ] **Run full test suite to confirm no regressions:**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Commit:**

```bash
git add scripts/fetch-thread.js scripts/test/fetch-thread.test.js
git commit -m "feat: add fetch-thread.js connector with transformGraphMessages"
```

---

## Chunk 2: save-draft.js

### Task 3: Write failing tests for `buildOutlookMessageBody`

**Files:**
- Create: `scripts/test/save-draft.test.js`

`buildOutlookMessageBody` is a pure exported function that takes `{ to, cc, subject, body }` and returns a Graph API message resource object ready for `POST /me/mailFolders/{id}/messages`.

- [ ] **Write the test file:**

```js
// scripts/test/save-draft.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOutlookMessageBody } from "../save-draft.js";

describe("buildOutlookMessageBody", () => {
  it("sets subject, HTML body, and toRecipients", () => {
    const payload = buildOutlookMessageBody({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Following up",
      body: "Hi Alice,\n\nJust checking in.\n\nRegards,\n\nBen",
    });
    assert.equal(payload.subject, "Following up");
    assert.equal(payload.body.contentType, "HTML");
    assert.ok(payload.body.content.includes("Just checking in."));
    assert.equal(payload.toRecipients.length, 1);
    assert.equal(payload.toRecipients[0].emailAddress.address, "alice@acme.com");
  });

  it("converts plain text body to HTML preserving line breaks", () => {
    const payload = buildOutlookMessageBody({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Test",
      body: "Line one\n\nLine two",
    });
    assert.ok(payload.body.content.includes("<br>") || payload.body.content.includes("<p>"));
  });

  it("includes cc recipients when provided", () => {
    const payload = buildOutlookMessageBody({
      to: ["alice@acme.com"],
      cc: ["carol@acme.com", "dave@acme.com"],
      subject: "Test",
      body: "Hello",
    });
    assert.equal(payload.ccRecipients.length, 2);
    assert.equal(payload.ccRecipients[0].emailAddress.address, "carol@acme.com");
  });

  it("produces empty ccRecipients when cc is empty", () => {
    const payload = buildOutlookMessageBody({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Test",
      body: "Hello",
    });
    assert.deepEqual(payload.ccRecipients, []);
  });

  it("marks message as draft", () => {
    const payload = buildOutlookMessageBody({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Test",
      body: "Hello",
    });
    assert.equal(payload.isDraft, true);
  });
});
```

- [ ] **Run test to confirm it fails:**

```bash
node --test scripts/test/save-draft.test.js
```

Expected: error — `save-draft.js` does not exist yet.

---

### Task 4: Implement `save-draft.js`

**Files:**
- Create: `scripts/save-draft.js`

**Graph API approach:**
- Compose: `POST /me/mailFolders/{folderId}/messages` — creates draft directly in folder
- Reply: `POST /me/messages/{replyToMessageId}/createReply` → returns draft in native Drafts folder → `PATCH /me/messages/{draftId}` to set body/recipients → `POST /me/messages/{draftId}/move` to move to Drafts-OfficeOS

- [ ] **Write the implementation:**

```js
/**
 * save-draft.js <accountId>
 *
 * Reads draft data from stdin as JSON: { to, cc, subject, body, replyToMessageId? }
 * Creates a draft in the Drafts-OfficeOS mail folder (created on first use).
 * Returns JSON: { draftId }
 *
 * Usage:
 *   echo '<json>' | node scripts/save-draft.js <accountId>
 */
import { buildGraphClient } from "./graph-client.js";

export function buildOutlookMessageBody({ to, cc, subject, body }) {
  const htmlBody = body
    .split(/\n\n+/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return {
    subject,
    isDraft: true,
    body: { contentType: "HTML", content: htmlBody },
    toRecipients: (to || []).map((addr) => ({ emailAddress: { address: addr } })),
    ccRecipients: (cc || []).map((addr) => ({ emailAddress: { address: addr } })),
  };
}

async function ensureDraftsFolder(client) {
  const folders = await client
    .api("/me/mailFolders")
    .filter("displayName eq 'Drafts-OfficeOS'")
    .get();
  if (folders.value.length > 0) return folders.value[0].id;
  const folder = await client.api("/me/mailFolders").post({ displayName: "Drafts-OfficeOS" });
  return folder.id;
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith("save-draft.js")) {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error("Usage: echo '<json>' | node scripts/save-draft.js <accountId>");
    process.exit(1);
  }
  let raw = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", async () => {
    const draftData = JSON.parse(raw);
    const client = await buildGraphClient(accountId);
    const folderId = await ensureDraftsFolder(client);

    let draftId;
    if (draftData.replyToMessageId) {
      // Create reply draft in native Drafts, patch body, move to Drafts-OfficeOS
      const replyDraft = await client
        .api(`/me/messages/${draftData.replyToMessageId}/createReply`)
        .post({});
      draftId = replyDraft.id;
      const patch = buildOutlookMessageBody(draftData);
      await client.api(`/me/messages/${draftId}`).patch({
        body: patch.body,
        toRecipients: patch.toRecipients,
        ccRecipients: patch.ccRecipients,
      });
      await client.api(`/me/messages/${draftId}/move`).post({ destinationId: folderId });
    } else {
      // Compose: create directly in Drafts-OfficeOS
      const msg = await client
        .api(`/me/mailFolders/${folderId}/messages`)
        .post(buildOutlookMessageBody(draftData));
      draftId = msg.id;
    }
    console.log(JSON.stringify({ draftId }));
  });
}
```

- [ ] **Run tests to confirm they pass:**

```bash
node --test scripts/test/save-draft.test.js
```

Expected: all 5 tests pass.

- [ ] **Run full test suite:**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Commit:**

```bash
git add scripts/save-draft.js scripts/test/save-draft.test.js
git commit -m "feat: add save-draft.js connector for Outlook Drafts-OfficeOS folder"
```

---

## Chunk 3: save-gmail-draft.js

### Task 5: Write failing tests for `buildRfc2822Message`

**Files:**
- Create: `scripts/test/save-gmail-draft.test.js`

`buildRfc2822Message` is a pure exported function that takes `{ to, cc, subject, body, threadId? }` and returns a base64url-encoded RFC 2822 message string (what Gmail API expects in `raw`).

- [ ] **Write the test file:**

```js
// scripts/test/save-gmail-draft.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRfc2822Message } from "../save-gmail-draft.js";

function decodeRaw(raw) {
  // Gmail uses base64url (- instead of +, _ instead of /)
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

describe("buildRfc2822Message", () => {
  it("includes To, Subject, and body in output", () => {
    const raw = buildRfc2822Message({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Hello",
      body: "Hi Alice",
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("To: alice@acme.com"));
    assert.ok(decoded.includes("Subject: Hello"));
    assert.ok(decoded.includes("Hi Alice"));
  });

  it("includes CC header when cc is provided", () => {
    const raw = buildRfc2822Message({
      to: ["alice@acme.com"],
      cc: ["carol@acme.com"],
      subject: "Test",
      body: "Hello",
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("Cc: carol@acme.com"));
  });

  it("omits CC header when cc is empty", () => {
    const raw = buildRfc2822Message({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Test",
      body: "Hello",
    });
    const decoded = decodeRaw(raw);
    assert.ok(!decoded.includes("Cc:"));
  });

  it("sets Content-Type to text/plain utf-8", () => {
    const raw = buildRfc2822Message({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Test",
      body: "Hello",
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("Content-Type: text/plain; charset=utf-8"));
  });

  it("handles multiple To recipients", () => {
    const raw = buildRfc2822Message({
      to: ["alice@acme.com", "bob@acme.com"],
      cc: [],
      subject: "Test",
      body: "Hello",
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("alice@acme.com") && decoded.includes("bob@acme.com"));
  });
});
```

- [ ] **Run test to confirm it fails:**

```bash
node --test scripts/test/save-gmail-draft.test.js
```

Expected: error — `save-gmail-draft.js` does not exist yet.

---

### Task 6: Implement `save-gmail-draft.js`

**Files:**
- Create: `scripts/save-gmail-draft.js`

Gmail API `users.drafts.create` takes `{ message: { raw, threadId? } }` where `raw` is a base64url-encoded RFC 2822 message. The `Drafts-OfficeOS` label is applied by modifying the created draft's message labels after creation.

- [ ] **Write the implementation:**

```js
/**
 * save-gmail-draft.js <accountId>
 *
 * Reads draft data from stdin as JSON: { to, cc, subject, body, threadId? }
 * Creates a Gmail draft and applies the Drafts-OfficeOS label.
 * Returns JSON: { draftId }
 *
 * Usage:
 *   echo '<json>' | node scripts/save-gmail-draft.js <accountId>
 */
import { buildGmailClient } from "./gmail-client.js";

export function buildRfc2822Message({ to, cc, subject, body }) {
  const lines = [
    `To: ${(to || []).join(", ")}`,
    ...(cc && cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ];
  const raw = lines.join("\r\n");
  return Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function ensureDraftsLabel(gmail) {
  const res = await gmail.users.labels.list({ userId: "me" });
  const existing = (res.data.labels || []).find((l) => l.name === "Drafts-OfficeOS");
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: "Drafts-OfficeOS",
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  return created.data.id;
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith("save-gmail-draft.js")) {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error("Usage: echo '<json>' | node scripts/save-gmail-draft.js <accountId>");
    process.exit(1);
  }
  let raw = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", async () => {
    const draftData = JSON.parse(raw);
    const gmail = await buildGmailClient(accountId);
    const labelId = await ensureDraftsLabel(gmail);

    const messageResource = { raw: buildRfc2822Message(draftData) };
    if (draftData.threadId) messageResource.threadId = draftData.threadId;

    const draft = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: messageResource },
    });
    const draftId = draft.data.id;
    const messageId = draft.data.message.id;

    // Apply Drafts-OfficeOS label to the underlying message
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { addLabelIds: [labelId] },
    });

    console.log(JSON.stringify({ draftId }));
  });
}
```

**Known gap:** `buildGmailClient` in `scripts/gmail-client.js` currently accepts **no arguments** and reads credentials from `.env` (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`). The spec states credentials should come from `config/companies.json`, but that migration is deferred. For now, `accountId` is accepted as an argument by this script for API consistency and future use, but it does not yet affect which credentials are loaded. This is intentional — do not modify `gmail-client.js` in this task.

**Also note:** `ensureDraftsLabel` and the Gmail draft creation/label-application flow are not covered by unit tests — they require a live Gmail API connection. Correctness of the API integration path is verified by the smoke test in the Final Verification step.

- [ ] **Run tests to confirm they pass:**

```bash
node --test scripts/test/save-gmail-draft.test.js
```

Expected: all 5 tests pass.

- [ ] **Run full test suite:**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Commit:**

```bash
git add scripts/save-gmail-draft.js scripts/test/save-gmail-draft.test.js
git commit -m "feat: add save-gmail-draft.js connector for Gmail Drafts-OfficeOS label"
```

---

## Chunk 4: Voice Profile Config + Skill

### Task 7: Add `voiceProfile` to `config/companies.json`

**Files:**
- Modify: `config/companies.json`

Add a `voiceProfile` block to every account entry. Adjust `openingStyle` and `formality` per account type — business accounts get `"direct"` + `"professional"`, personal gets `"warm"` + `"casual-professional"`.

- [ ] **Add voiceProfile to each business account** (healthcarema, brickellpay, summitmiami):

```json
"voiceProfile": {
  "signOff": "Regards,\n\nBen",
  "openingStyle": "direct",
  "formality": "professional",
  "urgencyToneOverrides": {
    "action": "direct and time-sensitive — lead with the ask, no preamble",
    "respond": "prompt and clear — answer the question, offer next step"
  },
  "contactOverrides": []
}
```

- [ ] **Add voiceProfile to the personal Gmail account:**

```json
"voiceProfile": {
  "signOff": "Regards,\n\nBen",
  "openingStyle": "warm",
  "formality": "casual-professional",
  "urgencyToneOverrides": {
    "iaido": "warm and collegial — this is your martial arts community",
    "spe": "friendly and fraternal — these are your brothers"
  },
  "contactOverrides": [
    {
      "email": "pam_a_parker@yahoo.com",
      "formality": "professional",
      "openingStyle": "warm",
      "signOff": "Regards,\n\nBen"
    }
  ]
}
```

- [ ] **Verify JSON is valid** (ESM project — use `--input-type=module`):

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; JSON.parse(readFileSync('config/companies.json','utf-8')); console.log('valid')"
```

Expected: `valid`

Note: `config/companies.json` is gitignored — no commit needed for this step.

---

### Task 8: Rewrite `email-draft.md` skill

**Files:**
- Modify: `.claude/commands/email/email-draft.md`

- [ ] **Replace the file contents:**

```markdown
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
```

- [ ] **Verify the skill file was saved correctly:**

```bash
cat ".claude/commands/email/email-draft.md"
```

Expected: the full skill content is visible.

- [ ] **Commit:**

```bash
git add .claude/commands/email/email-draft.md
git commit -m "feat: rewrite email-draft skill with voice profile, thread fetch, and Drafts-OfficeOS save"
```

---

## Final Verification

- [ ] **Run the full test suite one last time:**

```bash
npm test
```

Expected: all tests pass (should now include fetch-thread, save-draft, and save-gmail-draft test files in addition to the original classify-emails tests).

- [ ] **Smoke test the skill manually** by invoking `/email:email-draft personal compose test@example.com "Test subject" "Just checking the flow works"` and verifying it loads the voiceProfile, drafts an email, and offers the approve/revise/adjust tone/cancel options.
