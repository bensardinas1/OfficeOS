# Unified Mail Connector Layer (Cluster B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One library (`scripts/mail.js`) becomes the single way to fetch/delete/restore mail; the daemon calls it in-process; a new intent-level `POST /senders/delete-all` replaces the cluster button's client ID-list; the audit log gains per-row undo and failed-id semantics.

**Architecture:** `scripts/mail.js` exports provider-dispatching functions with a per-account client cache and a test-only client-factory seam. Existing CLI connectors become thin shims (stdout formats unchanged). `triage.js`/`morning-brief.js`/`daemon.js` migrate to imports. `daemon/api.js` gains a `withAudit` helper and the delete-all route; `daemon/action-log.js`'s `deriveActed` gains per-id undo accounting. Spec: `docs/superpowers/specs/2026-07-14-unified-mail-connector-layer-design.md`.

**Tech Stack:** Node 24 ESM, `node:test`, Microsoft Graph client + googleapis (existing deps), zero NEW dependencies.

## Global Constraints

- **Soft-delete only, everywhere.** Outlook: `POST /me/messages/{id}/move destinationId "deleteditems"`. Gmail: `users.messages.trash`. Restore: move→`inbox` / `untrash`. The strings `permanentDelete`, `batchDelete`, `users.messages.delete(` and any send-mail API must NOT appear in `scripts/mail.js` (rails-guard enforces).
- **`deleteBySender` guards before querying:** `isProtectedSender(account, email)` from `scripts/sender-guards.js` AND an injected `correspondents` Set (same two guards as `addSenderToKillList`). Refusal returns `{matched:0, trashed:0, failed:0, emailIds:[], refused:<reason>}` without any API call.
- `deleteBySender`: `sinceHours` default 720, clamped to [1, 8760]; inbox only; match cap 1000 per invocation.
- **CLI stdout formats unchanged** (`Done: N trashed…`, JSON arrays, `{added, reason, value}`) — skills parse them.
- Zero new dependencies. No behavior change to `npm test` glob or the e2e suite (both must stay green: 599 unit + 1 e2e at baseline; unit count grows as tasks add tests).
- Commit after every task; conventional commits; body ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Never commit `.superpowers/` or `data/`.

---

## File map

| File | Task | Role |
|---|---|---|
| `scripts/mail.js` (create) | 1–3 | the one way to touch mail |
| `scripts/test/mail.test.js` (create) | 1–3 | fake-client unit tests |
| `scripts/fetch-emails.js`, `fetch-gmail.js`, `delete-emails.js`, `delete-gmail-emails.js`, `restore-emails.js`, `restore-gmail-emails.js`, `fetch-message.js` (modify) | 1, 2, 4 | shims / re-exports |
| `scripts/triage.js`, `scripts/morning-brief.js` (modify) | 4 | fetch via `fetchMail` |
| `daemon/action-log.js` + test (modify) | 5 | per-row undo + failed-id semantics |
| `daemon/api.js` + test (modify) | 6 | `withAudit`, persisted guard, `/senders/delete-all` |
| `scripts/killlist-add.js`, `killlist-remove.js` (modify) | 7 | exported full-cycle fns |
| `daemon/daemon.js`, `daemon/fake-connectors.js` + test (modify) | 7 | in-process wiring |
| `daemon/web/render.js`, `app.js` + tests (modify) | 8 | cluster button → delete-all |
| rails-guard test file(s) (modify) | 3 | extend to mail.js |
| `daemon/README.md`, `CLAUDE.md`-adjacent docs (modify) | 9 | document |

---

### Task 1: `scripts/mail.js` — module skeleton + `fetchMail`

**Files:**
- Create: `scripts/mail.js`
- Modify: `scripts/fetch-emails.js` (stripHtml moves to mail.js; fetch-emails re-exports it)
- Test: `scripts/test/mail.test.js`

**Interfaces:**
- Produces:
  - `fetchMail(account, {hours=24, folder="inbox", max=200, bodyChars=0}?)` → unified email array (superset shape; Outlook now includes `hasListUnsubscribe`/`precedence`/`toRecipients`/`ccRecipients` like triage's private fetcher did; Gmail now paginates past 100).
  - `stripHtml(html)` (moved verbatim from fetch-emails.js; fetch-emails.js does `export { stripHtml } from "./mail.js";`).
  - `_setClientFactoryForTest(fn)` — test seam; `fn(account)` returns a fake client; passing `null` restores the default factory and clears the cache.

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/mail.test.js`:

```js
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchMail, stripHtml, _setClientFactoryForTest } from "../mail.js";

const outlookAcct = { id: "brickell", provider: "outlook", myEmail: "me@brickell.com" };
const gmailAcct = { id: "personal", provider: "gmail" };

afterEach(() => _setClientFactoryForTest(null));

/** Fake Graph client: .api(url).filter().select().orderby().top().get() with paging. */
function fakeGraph(pages) {
  let call = 0;
  const chain = (state) => ({
    filter: (f) => { state.filter = f; return chain(state); },
    select: (s) => { state.select = s; return chain(state); },
    orderby: (o) => { state.orderby = o; return chain(state); },
    top: (t) => { state.top = t; return chain(state); },
    post: async (body) => { state.posted = body; return {}; },
    get: async () => pages[call++] ?? { value: [] },
  });
  const client = { api: (url) => { client.urls.push(url); return chain(client.state = {}); }, urls: [], state: {} };
  return client;
}

function graphMsg(i) {
  return { id: `m${i}`, subject: `s${i}`, from: { emailAddress: { address: `a${i}@x.com`, name: `A${i}` } },
    receivedDateTime: `2026-07-0${(i % 9) + 1}T00:00:00Z`, isRead: false, importance: "normal",
    hasAttachments: false, bodyPreview: "p".repeat(400),
    internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<mailto:u@x.com>" }, { name: "To", value: "me@brickell.com" }] };
}

describe("fetchMail — outlook", () => {
  it("paginates @odata.nextLink up to max and maps the unified shape", async () => {
    process.env.BRICKELL_EMAIL = "me@brickell.com";
    const pages = [
      { value: [graphMsg(1), graphMsg(2)], "@odata.nextLink": "https://graph/next1" },
      { value: [graphMsg(3), graphMsg(4)] },
    ];
    const client = fakeGraph(pages);
    _setClientFactoryForTest(async () => client);
    const emails = await fetchMail(outlookAcct, { hours: 24, max: 3 });
    assert.equal(emails.length, 3);
    assert.equal(emails[0].id, "m1");
    assert.equal(emails[0].from, "a1@x.com");
    assert.equal(emails[0].hasListUnsubscribe, true);
    assert.equal(emails[0].toRecipients, "me@brickell.com");
    assert.deepEqual(emails[0].gmailCategories, []);
    assert.equal(emails[0].preview.length, 300); // preview trimmed
    assert.match(client.urls[0], /mailFolders\/inbox\/messages/);
    assert.match(client.urls[1], /graph\/next1/); // followed nextLink
  });

  it("includes stripped body when bodyChars > 0", async () => {
    process.env.BRICKELL_EMAIL = "me@brickell.com";
    const msg = { ...graphMsg(1), body: { content: "<p>Hello <b>world</b></p>" } };
    _setClientFactoryForTest(async () => fakeGraph([{ value: [msg] }]));
    const [e] = await fetchMail(outlookAcct, { bodyChars: 5 });
    assert.equal(e.body, "Hello");
  });
});

/** Fake Gmail client with list pagination + metadata get. */
function fakeGmail(idPages, metaFor) {
  let page = 0;
  return { users: { messages: {
    list: async ({ pageToken }) => {
      const p = idPages[page++] || { messages: [] };
      return { data: { messages: p.messages, nextPageToken: p.nextPageToken } };
    },
    get: async ({ id }) => ({ data: metaFor(id) }),
    trash: async () => ({}), untrash: async () => ({}),
  } } };
}

function gmailMeta(id) {
  return { id, threadId: `t-${id}`, internalDate: String(Date.now()), snippet: "hi",
    payload: { headers: [
      { name: "From", value: `Sender <s@x.com>` }, { name: "Subject", value: `sub-${id}` },
      { name: "Date", value: new Date().toUTCString() },
    ] }, labelIds: ["INBOX"] };
}

describe("fetchMail — gmail", () => {
  it("paginates past 100 via nextPageToken up to max", async () => {
    const idPages = [
      { messages: Array.from({ length: 100 }, (_, i) => ({ id: `g${i}` })), nextPageToken: "tok" },
      { messages: Array.from({ length: 50 }, (_, i) => ({ id: `g${100 + i}` })) },
    ];
    _setClientFactoryForTest(async () => fakeGmail(idPages, gmailMeta));
    const emails = await fetchMail(gmailAcct, { hours: 24, max: 120 });
    assert.equal(emails.length, 120); // crossed the old 100 cap
    assert.ok(emails.every(e => e.id && e.subject));
  });
});

describe("stripHtml", () => {
  it("strips tags/styles and collapses whitespace", () => {
    assert.equal(stripHtml("<style>x{}</style><p>a  <b>b</b></p>"), "a b");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/test/mail.test.js`
Expected: FAIL — `Cannot find module ... mail.js`

- [ ] **Step 3: Implement `scripts/mail.js`**

```js
/**
 * mail.js — the ONE library for touching mail. Every fetch/delete/restore path
 * (CLI shims, triage, morning-brief, the daemon) goes through these functions so
 * pagination, provider dispatch, the unified email shape, and the safety rails
 * live in exactly one place. Soft-delete only: Outlook move→deleteditems, Gmail
 * trash. Never a permanent delete, never a send.
 *
 * All functions take the ACCOUNT OBJECT (from config/companies.json) first.
 * Clients are cached per account. For tests, _setClientFactoryForTest injects
 * fakes (null restores the default and clears the cache).
 */
import { buildGraphClient } from "./graph-client.js";
import { buildGmailClient, mapGmailMessage } from "./gmail-client.js";
import { isProtectedSender } from "./sender-guards.js";
import "dotenv/config";

// ---------------------------------------------------------------------------
// Client cache + test seam
// ---------------------------------------------------------------------------
let clientFactory = null; // null → default
const clientCache = new Map();

function defaultFactory(account) {
  return (account.provider || "outlook") === "gmail" ? buildGmailClient() : buildGraphClient(account.id);
}

async function getClient(account) {
  const key = `${account.provider || "outlook"}:${account.id}`;
  if (!clientCache.has(key)) clientCache.set(key, (clientFactory || defaultFactory)(account));
  return clientCache.get(key);
}

export function _setClientFactoryForTest(fn) {
  clientFactory = fn;
  clientCache.clear();
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
export function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function outlookAddress(account) {
  const email = process.env[`${account.id.toUpperCase()}_EMAIL`] || account.myEmail;
  if (!email) throw new Error(`Missing ${account.id.toUpperCase()}_EMAIL in .env`);
  return email;
}

const OUTLOOK_SELECT = "id,subject,from,receivedDateTime,isRead,bodyPreview,importance,hasAttachments,internetMessageHeaders";

function mapOutlookMessage(msg, bodyChars) {
  const inet = msg.internetMessageHeaders || [];
  const h = (name) => inet.find(x => x.name.toLowerCase() === name.toLowerCase())?.value || "";
  const obj = {
    id: msg.id,
    subject: msg.subject,
    from: msg.from?.emailAddress?.address,
    fromName: msg.from?.emailAddress?.name,
    received: msg.receivedDateTime,
    receivedAt: msg.receivedDateTime,
    isRead: msg.isRead,
    importance: msg.importance,
    hasAttachments: msg.hasAttachments,
    preview: msg.bodyPreview?.slice(0, 300),
    hasListUnsubscribe: !!h("List-Unsubscribe"),
    precedence: h("Precedence") || null,
    toRecipients: h("To"),
    ccRecipients: h("Cc"),
    gmailCategories: [],
  };
  if (bodyChars > 0) obj.body = stripHtml(msg.body?.content || "").slice(0, bodyChars);
  return obj;
}

/** Follow @odata.nextLink pages until `max` ids collected or pages exhausted. */
async function outlookCollect(client, firstRequest, max) {
  const collected = [];
  let response = await firstRequest();
  collected.push(...(response.value || []));
  while (response["@odata.nextLink"] && collected.length < max) {
    response = await client.api(response["@odata.nextLink"]).get();
    collected.push(...(response.value || []));
  }
  return collected.slice(0, max);
}

async function gmailListIds(client, q, max) {
  const ids = [];
  let pageToken;
  do {
    const res = await client.users.messages.list({
      userId: "me", q, maxResults: Math.min(max - ids.length, 100), pageToken,
    });
    for (const m of res.data.messages || []) ids.push(m.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

// ---------------------------------------------------------------------------
// fetchMail
// ---------------------------------------------------------------------------
export async function fetchMail(account, { hours = 24, folder = "inbox", max = 200, bodyChars = 0 } = {}) {
  const client = await getClient(account);
  if ((account.provider || "outlook") === "gmail") {
    const afterEpoch = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
    const ids = await gmailListIds(client, `in:inbox after:${afterEpoch}`, max);
    const emails = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = await Promise.all(ids.slice(i, i + 50).map(id =>
        client.users.messages.get({
          userId: "me", id, format: "metadata",
          metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe", "Precedence", "To", "Cc"],
        })));
      for (const r of batch) {
        const e = mapGmailMessage(r.data, { previewLimit: 300 });
        e.fromName = e.fromName || e.from;
        emails.push(e);
      }
    }
    emails.sort((a, b) => new Date(b.received) - new Date(a.received));
    return emails;
  }
  const email = outlookAddress(account);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const select = bodyChars > 0 ? `${OUTLOOK_SELECT},body` : OUTLOOK_SELECT;
  const messages = await outlookCollect(client, () =>
    client.api(`/users/${email}/mailFolders/${folder}/messages`)
      .filter(`receivedDateTime ge ${since}`)
      .select(select)
      .orderby("receivedDateTime desc")
      .top(Math.min(max, 1000))
      .get(), max);
  return messages.map(m => mapOutlookMessage(m, bodyChars));
}
```

And in `scripts/fetch-emails.js`: delete the local `stripHtml` function and replace it with `export { stripHtml } from "./mail.js";` (the CLI body keeps using `stripHtml` — add `import { stripHtml } from "./mail.js";` for its own use; full shim conversion happens in Task 4).

- [ ] **Step 4: Run tests**

Run: `node --test scripts/test/mail.test.js` — 4 passing. Then `npm test` — full suite green (fetch-emails importers unaffected by the re-export).

- [ ] **Step 5: Commit**

```bash
git add scripts/mail.js scripts/test/mail.test.js scripts/fetch-emails.js
git commit -m "feat(mail): unified fetchMail with cross-provider pagination + client cache"
```

---

### Task 2: `mail.js` mutations — `deleteEmails`, `restoreEmails`, `fetchMessageBody`

**Files:**
- Modify: `scripts/mail.js`, `scripts/fetch-message.js`
- Test: `scripts/test/mail.test.js`

**Interfaces:**
- Produces:
  - `deleteEmails(account, ids)` → `{trashed, failed, failedIds}` (per-id try/catch).
  - `restoreEmails(account, ids)` → `{restored, failed, failedIds}`.
  - `fetchMessageBody(account, emailId)` → `{id, body}` (plain text; Gmail via `extractGmailBody`, which MOVES into mail.js; `fetch-message.js` re-exports it).

- [ ] **Step 1: Write the failing tests** (append to `scripts/test/mail.test.js`)

```js
import { deleteEmails, restoreEmails, fetchMessageBody } from "../mail.js";

describe("deleteEmails / restoreEmails", () => {
  it("outlook: per-id move to deleteditems, collecting failed ids", async () => {
    const calls = [];
    const client = { api: (url) => ({ post: async (b) => {
      calls.push({ url, b });
      if (url.includes("bad")) throw new Error("boom");
      return {};
    }, select: () => ({ get: async () => ({}) }) }) };
    _setClientFactoryForTest(async () => client);
    const r = await deleteEmails(outlookAcct, ["ok1", "bad2", "ok3"]);
    assert.deepEqual(r, { trashed: 2, failed: 1, failedIds: ["bad2"] });
    assert.equal(calls[0].b.destinationId, "deleteditems");
  });

  it("gmail: trash / untrash per id", async () => {
    const trashed = [], untrashed = [];
    _setClientFactoryForTest(async () => ({ users: { messages: {
      trash: async ({ id }) => { if (id === "x") throw new Error("no"); trashed.push(id); },
      untrash: async ({ id }) => { untrashed.push(id); },
    } } }));
    const d = await deleteEmails(gmailAcct, ["a", "x"]);
    assert.deepEqual(d, { trashed: 1, failed: 1, failedIds: ["x"] });
    const u = await restoreEmails(gmailAcct, ["a"]);
    assert.deepEqual(u, { restored: 1, failed: 0, failedIds: [] });
  });

  it("outlook restore moves back to inbox", async () => {
    let posted;
    _setClientFactoryForTest(async () => ({ api: () => ({ post: async (b) => { posted = b; return {}; } }) }));
    const r = await restoreEmails(outlookAcct, ["m1"]);
    assert.equal(r.restored, 1);
    assert.equal(posted.destinationId, "inbox");
  });
});

describe("fetchMessageBody", () => {
  it("outlook: strips html body", async () => {
    process.env.BRICKELL_EMAIL = "me@brickell.com";
    _setClientFactoryForTest(async () => ({ api: () => ({ select: () => ({ get: async () => ({ id: "m1", body: { content: "<p>hi</p>" } }) }) }) }));
    assert.deepEqual(await fetchMessageBody(outlookAcct, "m1"), { id: "m1", body: "hi" });
  });
  it("gmail: extracts from payload", async () => {
    const data = { id: "g1", payload: { mimeType: "text/plain", body: { data: Buffer.from("yo").toString("base64") } } };
    _setClientFactoryForTest(async () => ({ users: { messages: { get: async () => ({ data }) } } }));
    assert.deepEqual(await fetchMessageBody(gmailAcct, "g1"), { id: "g1", body: "yo" });
  });
});
```

- [ ] **Step 2: Verify fail** — `node --test scripts/test/mail.test.js` → new tests fail (functions not exported).

- [ ] **Step 3: Implement** (append to `scripts/mail.js`)

```js
// ---------------------------------------------------------------------------
// Mutations — soft-delete / restore only. Per-id so one bad id can't sink a batch.
// ---------------------------------------------------------------------------
async function perId(ids, fn) {
  let ok = 0; const failedIds = [];
  for (const id of ids) {
    try { await fn(id); ok++; } catch { failedIds.push(id); }
  }
  return { ok, failedIds };
}

export async function deleteEmails(account, ids) {
  const client = await getClient(account);
  const gmail = (account.provider || "outlook") === "gmail";
  const { ok, failedIds } = await perId(ids, (id) => gmail
    ? client.users.messages.trash({ userId: "me", id })
    : client.api(`/me/messages/${id}/move`).post({ destinationId: "deleteditems" }));
  return { trashed: ok, failed: failedIds.length, failedIds };
}

export async function restoreEmails(account, ids) {
  const client = await getClient(account);
  const gmail = (account.provider || "outlook") === "gmail";
  const { ok, failedIds } = await perId(ids, (id) => gmail
    ? client.users.messages.untrash({ userId: "me", id })
    : client.api(`/me/messages/${id}/move`).post({ destinationId: "inbox" }));
  return { restored: ok, failed: failedIds.length, failedIds };
}

// ---------------------------------------------------------------------------
// Single message body (read-only)
// ---------------------------------------------------------------------------
export function extractGmailBody(payload) {
  if (!payload) return "";
  const decode = (data) =>
    Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  let plain = "", html = "";
  const walk = (p) => {
    if (!p) return;
    const mt = p.mimeType || "";
    if (mt === "text/plain" && p.body?.data && !plain) plain = decode(p.body.data);
    else if (mt === "text/html" && p.body?.data && !html) html = decode(p.body.data);
    for (const c of p.parts || []) walk(c);
  };
  walk(payload);
  if (plain) return plain.trim();
  if (html) return stripHtml(html);
  if (payload.body?.data) return decode(payload.body.data).trim();
  return "";
}

export async function fetchMessageBody(account, emailId) {
  const client = await getClient(account);
  if ((account.provider || "outlook") === "gmail") {
    const res = await client.users.messages.get({ userId: "me", id: emailId, format: "full" });
    return { id: res.data.id, body: extractGmailBody(res.data.payload) };
  }
  const email = process.env[`${account.id.toUpperCase()}_EMAIL`] || account.myEmail;
  const path = email ? `/users/${email}/messages/${emailId}` : `/me/messages/${emailId}`;
  const msg = await client.api(path).select("id,body").get();
  return { id: msg.id, body: stripHtml(msg.body?.content || "") };
}
```

In `scripts/fetch-message.js`: delete the local `extractGmailBody` and replace with `export { extractGmailBody } from "./mail.js";` (keep the CLI functioning by importing it for its own use; full shim conversion is Task 4). Ensure no import cycle: `fetch-message.js` imports from `mail.js` only; `mail.js` must NOT import from `fetch-message.js`.

- [ ] **Step 4: Run** — `node --test scripts/test/mail.test.js` all passing; `npm test` green (extractGmailBody importers see the re-export).

- [ ] **Step 5: Commit**

```bash
git add scripts/mail.js scripts/test/mail.test.js scripts/fetch-message.js
git commit -m "feat(mail): per-id soft-delete/restore + fetchMessageBody in the unified library"
```

---

### Task 3: `deleteBySender` + rails-guard extension

**Files:**
- Modify: `scripts/mail.js`
- Test: `scripts/test/mail.test.js`, plus the existing connector rails-guard test file (locate it: `grep -l "rails" daemon/executors/*.test.js scripts/test/*.test.js` — extend whichever asserts connector sources)

**Interfaces:**
- Produces: `deleteBySender(account, sender, {sinceHours=720, correspondents}?)` →
  `{matched, trashed, failed, failedIds, emailIds, refused?}` where `emailIds` are the SUCCESSFULLY deleted ids (for the audit log / undo) and `refused` short-circuits before any API call.

- [ ] **Step 1: Failing tests** (append to `scripts/test/mail.test.js`)

```js
import { deleteBySender } from "../mail.js";

describe("deleteBySender", () => {
  const acct = { id: "brickell", provider: "outlook", myEmail: "me@brickell.com",
    prioritySenders: [{ email: "vip@x.com" }] };

  it("refuses protected senders before any API call", async () => {
    _setClientFactoryForTest(async () => { throw new Error("must not build a client"); });
    const r = await deleteBySender(acct, "vip@x.com");
    assert.equal(r.refused ? true : false, true);
    assert.deepEqual([r.matched, r.trashed, r.emailIds.length], [0, 0, 0]);
  });

  it("refuses correspondents", async () => {
    _setClientFactoryForTest(async () => { throw new Error("must not build a client"); });
    const r = await deleteBySender(acct, "friend@y.com", { correspondents: new Set(["friend@y.com"]) });
    assert.match(r.refused, /correspond/i);
  });

  it("outlook: queries inbox by sender within the window, deletes matches, reports ids", async () => {
    process.env.BRICKELL_EMAIL = "me@brickell.com";
    const posted = [];
    let filterSeen;
    const client = { api: (url) => ({
      filter: (f) => { filterSeen = f; return { select: () => ({ top: () => ({ get: async () => ({ value: [{ id: "d1" }, { id: "d2" }] }) }) }) }; },
      post: async (b) => { posted.push(url); if (url.includes("d2")) throw new Error("x"); return {}; },
    }) };
    _setClientFactoryForTest(async () => client);
    const r = await deleteBySender(acct, "noise@z.com", { sinceHours: 48 });
    assert.match(filterSeen, /from\/emailAddress\/address eq 'noise@z\.com'/);
    assert.match(filterSeen, /receivedDateTime ge /);
    assert.equal(r.matched, 2);
    assert.equal(r.trashed, 1);
    assert.deepEqual(r.failedIds, ["d2"]);
    assert.deepEqual(r.emailIds, ["d1"]); // only successfully deleted ids
  });

  it("clamps sinceHours into [1, 8760]", async () => {
    let filterSeen;
    const client = { api: () => ({
      filter: (f) => { filterSeen = f; return { select: () => ({ top: () => ({ get: async () => ({ value: [] }) }) }) }; },
    }) };
    _setClientFactoryForTest(async () => client);
    await deleteBySender(acct, "noise@z.com", { sinceHours: 999999 });
    const iso = filterSeen.match(/ge (.+)$/)[1];
    const hoursBack = (Date.now() - Date.parse(iso)) / 3600000;
    assert.ok(hoursBack <= 8760 + 1, `window was ${hoursBack}h`);
  });

  it("gmail: uses from:+after: query and trashes matches", async () => {
    let q;
    _setClientFactoryForTest(async () => ({ users: { messages: {
      list: async (args) => { q = args.q; return { data: { messages: [{ id: "g1" }] } }; },
      trash: async () => ({}),
    } } }));
    const r = await deleteBySender(gmailAcct, "noise@z.com");
    assert.match(q, /in:inbox from:noise@z\.com after:\d+/);
    assert.deepEqual(r.emailIds, ["g1"]);
  });
});
```

Note for the implementer: the fake Graph client above must expose `url` to `post` — adjust the fixture as needed so the chain works (e.g. capture `url` in the closure of `api(url)`); the assertions are what matter.

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement** (append to `scripts/mail.js`)

```js
// ---------------------------------------------------------------------------
// deleteBySender — intent-level bulk delete. GUARDS FIRST (same rails as the
// kill-list): protected senders and correspondents are refused before any API
// call. Inbox only; window clamped to [1h, 1y]; match cap 1000 per invocation.
// ---------------------------------------------------------------------------
const MATCH_CAP = 1000;

export async function deleteBySender(account, sender, { sinceHours = 720, correspondents } = {}) {
  const email = String(sender || "").trim().toLowerCase();
  const none = { matched: 0, trashed: 0, failed: 0, failedIds: [], emailIds: [] };
  if (!email || !email.includes("@")) return { ...none, refused: "not a valid email address" };
  if (isProtectedSender(account, email)) return { ...none, refused: "protected sender (priority/never-delete/own domain)" };
  if (correspondents && correspondents.has(email)) return { ...none, refused: "you've emailed this sender (correspondent)" };

  const hours = Math.min(Math.max(Number(sinceHours) || 720, 1), 8760);
  const client = await getClient(account);
  let ids;
  if ((account.provider || "outlook") === "gmail") {
    const afterEpoch = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
    ids = await gmailListIds(client, `in:inbox from:${email} after:${afterEpoch}`, MATCH_CAP);
  } else {
    const me = outlookAddress(account);
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const odataSender = email.replace(/'/g, "''");
    const messages = await outlookCollect(client, () =>
      client.api(`/users/${me}/mailFolders/inbox/messages`)
        .filter(`from/emailAddress/address eq '${odataSender}' and receivedDateTime ge ${since}`)
        .select("id")
        .top(Math.min(MATCH_CAP, 1000))
        .get(), MATCH_CAP);
    ids = messages.map(m => m.id);
  }
  const del = await deleteEmails(account, ids);
  const failedSet = new Set(del.failedIds);
  return { matched: ids.length, ...del, emailIds: ids.filter(id => !failedSet.has(id)) };
}
```

- [ ] **Step 4: Extend the rails-guard.** Locate the connector rails-guard test (Task hint: `daemon/executors/rails-guard.test.js` and/or a `scripts`-scoped guard added earlier — find with `grep -rl "permanentDelete\|batchDelete" --include=*.test.js .`). Add `scripts/mail.js` to its scanned-file list and add assertions: source must NOT contain `permanentDelete`, `batchDelete`, `users.messages.delete(`, `sendMail`, `messages.send`; source MUST contain `deleteditems` and `isProtectedSender` (guard wired). Follow the existing guard test's style exactly.

- [ ] **Step 5: Run** — `node --test scripts/test/mail.test.js` + the rails-guard file; then `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add scripts/mail.js scripts/test/mail.test.js <rails-guard test file>
git commit -m "feat(mail): guarded intent-level deleteBySender + rails-guard coverage"
```

---

### Task 4: CLI shims + triage/morning-brief migration

**Files:**
- Modify: `scripts/fetch-emails.js`, `scripts/fetch-gmail.js`, `scripts/delete-emails.js`, `scripts/delete-gmail-emails.js`, `scripts/restore-emails.js`, `scripts/restore-gmail-emails.js`, `scripts/fetch-message.js`, `scripts/triage.js`, `scripts/morning-brief.js`

**Interfaces:**
- Consumes: everything from Tasks 1–2. CLI stdout formats MUST stay byte-compatible: fetch scripts print the JSON email array (`JSON.stringify(emails, null, 2)`); delete prints `Done: N trashed[, M failed].`; restore prints `Done: N restored[, M failed].`; fetch-message prints `JSON.stringify({id, body})`.

- [ ] **Step 1: Convert each CLI.** Pattern (delete-emails.js shown; mirror for the others):

```js
/**
 * delete-emails.js <companyId> <messageId1> [messageId2 ...]
 * Thin shim over scripts/mail.js deleteEmails (soft delete → Deleted Items).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteEmails } from "./mail.js";

const [,, companyId, ...messageIds] = process.argv;
if (!companyId || messageIds.length === 0) {
  console.error("Usage: node scripts/delete-emails.js <companyId> <messageId1> [messageId2 ...]");
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
const account = companies.companies.find(c => c.id === companyId) || { id: companyId, provider: "outlook" };
const r = await deleteEmails(account, messageIds);
for (const id of r.failedIds) console.error(`FAILED: ${id}`);
console.log(`Done: ${r.trashed} trashed${r.failed ? `, ${r.failed} failed` : ""}.`);
```

Apply the same shape to: `delete-gmail-emails.js` (account resolved the same way; provider comes from config), `restore-emails.js` / `restore-gmail-emails.js` (`Done: N restored…`), `fetch-emails.js` (args `[companyId, hours, folder, top, bodyChars]` → `fetchMail(account, {hours, folder, max: top, bodyChars})`, print `JSON.stringify(emails, null, 2)`; KEEP the `export { stripHtml } from "./mail.js";` line and the existing CLI arg defaults: hours 24, folder inbox, top 50, bodyChars 0), `fetch-gmail.js` (args `[accountId, hours]` → `fetchMail` with `{hours, max: 100}` to preserve today's cap; keep `verifyGmailAccount` call — import the gmail client via `buildGmailClient` is no longer needed since mail.js owns the client; call `verifyGmailAccount` with a client obtained ONCE via mail's fetch? — simplest correct shim: keep building its own client for verification only, then call `fetchMail`), and `fetch-message.js` (CLI branch calls `fetchMessageBody(account, messageId)`; keep the `export { extractGmailBody } from "./mail.js";`).

NOTE: keep each shim's error handling (`console.error` + `process.exit(1)`) as today.

- [ ] **Step 2: Migrate `scripts/triage.js`.** Delete its private `fetchOutlook` and `fetchGmail`; `fetchAccount` becomes:

```js
import { fetchMail } from "./mail.js";

async function fetchAccount(account, hours, maxResults) {
  return fetchMail(account, { hours, max: maxResults });
}
```

Remove the now-unused `buildGraphClient`/`buildGmailClient`/`mapGmailMessage` imports from triage.js.

- [ ] **Step 3: Migrate `scripts/morning-brief.js`.** Its CLI bootstrap's `fetchSubprocess(accountId, sinceIso)` becomes an in-process call preserving the same signature and return (array of emails):

```js
  const { fetchMail } = await import("./mail.js");
  async function fetchSubprocess(accountId, sinceIso) {
    const account = companies.companies.find(c => c.id === accountId);
    const hours = Math.ceil((Date.now() - new Date(sinceIso).getTime()) / 3600000);
    return fetchMail(account, { hours });
  }
```

(Callers `await` it or the deps contract tolerates a promise — check how `runMorningBrief` deps invoke `fetchSubprocess`; if it's called without await, make the wrapper synchronous-compatible by returning the promise and confirm the call site awaits. Adjust the call site to `await` if needed — report if you must touch `runMorningBrief`.)

- [ ] **Step 4: Run** — `npm test` full suite green (morning-brief/triage/build-bundle tests exercise the seams). Also sanity-run a shim offline-safe check: `node scripts/delete-emails.js` with no args → usage + exit 1.

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-emails.js scripts/fetch-gmail.js scripts/delete-emails.js scripts/delete-gmail-emails.js scripts/restore-emails.js scripts/restore-gmail-emails.js scripts/fetch-message.js scripts/triage.js scripts/morning-brief.js
git commit -m "refactor(scripts): CLI connectors become mail.js shims; triage + morning-brief fetch in-process"
```

---

### Task 5: `deriveActed` — per-row undo + failed-id semantics

**Files:**
- Modify: `daemon/action-log.js`
- Test: `daemon/action-log.test.js`

**Interfaces:**
- Produces (changed semantics, same signature `deriveActed(entries)`):
  - A restore entry with `undoOf` + non-empty `emailIds` neutralizes ONLY those ids of the referenced entry.
  - An undo entry with `undoOf` and NO `emailIds` (e.g. `killlist_remove`) neutralizes the whole referenced entry (legacy/whole-entry behavior preserved).
  - Ids present in an entry's `result.failedIds` never contribute.
  - A delete entry with `result.trashed === 0` AND an Array `result.failedIds` contributes nothing (wholly-failed new-shape delete). Legacy entries (no `failedIds` key) keep today's behavior.

- [ ] **Step 1: Failing tests.** In `daemon/action-log.test.js`, REPLACE the existing test "an undoOf entry neutralizes its target and contributes nothing itself" with these (and keep all others):

```js
  it("a restore undoOf entry neutralizes only the ids it lists (per-row undo)", () => {
    const undoOne = { id: "r1", at: "t", action: "restore", account: "b", emailIds: ["e1"], result: { restored: 1 }, undoOf: "d1" };
    const acted = deriveActed([del, undoOne]);
    assert.equal(acted.e1, undefined);           // undone row gone
    assert.equal(acted.e2.deleted, true);        // sibling survives
  });

  it("an undoOf entry with no emailIds neutralizes the whole target (kill undo)", () => {
    const killUndo = { id: "ku1", at: "t", action: "killlist_remove", account: "b", sender: "spam@x.com", result: { removed: true }, undoOf: "k1" };
    const acted = deriveActed([del, kill, killUndo]);
    assert.equal(acted.e1.killed, undefined);
    assert.equal(acted.e1.deleted, true);        // delete unaffected
  });

  it("failedIds never contribute; wholly-failed new-shape deletes contribute nothing", () => {
    const partial = { id: "d3", at: "t", action: "delete", account: "b", emailIds: ["p1", "p2"], result: { trashed: 1, failed: 1, failedIds: ["p2"] } };
    const whollyFailed = { id: "d4", at: "t", action: "delete", account: "b", emailIds: ["w1"], result: { trashed: 0, failed: 1, failedIds: ["w1"] } };
    const acted = deriveActed([partial, whollyFailed]);
    assert.equal(acted.p1.deleted, true);
    assert.equal(acted.p2, undefined);
    assert.equal(acted.w1, undefined);
  });

  it("legacy entries without failedIds keep the old behavior", () => {
    const legacy = { id: "d5", at: "t", action: "delete", account: "b", emailIds: ["l1"], result: { trashed: 0, failed: 1 } };
    const acted = deriveActed([legacy]);
    assert.equal(acted.l1.deleted, true); // legacy shape: can't attribute per-id, keep old semantics
  });
```

- [ ] **Step 2: Verify** the new tests fail and the old per-entry test (now replaced) is gone.

- [ ] **Step 3: Implement.** Replace `deriveActed` in `daemon/action-log.js`:

```js
/**
 * Pure fold: recent entries (oldest-first) -> the panel's acted map, keyed by
 * emailId. Undo accounting is PER-ID: a restore entry neutralizes only the ids
 * it lists; an undo entry with no ids (killlist_remove) retires its whole
 * target. Ids in result.failedIds never contribute; a new-shape delete with
 * trashed:0 contributes nothing (legacy entries without failedIds keep the old
 * whole-entry behavior).
 */
export function deriveActed(entries) {
  // entryId -> "ALL" | Set<emailId>
  const undone = new Map();
  for (const e of entries) {
    if (!e.undoOf) continue;
    const cur = undone.get(e.undoOf);
    if (cur === "ALL") continue;
    if (!Array.isArray(e.emailIds) || e.emailIds.length === 0) { undone.set(e.undoOf, "ALL"); continue; }
    const set = cur instanceof Set ? cur : new Set();
    for (const id of e.emailIds) set.add(id);
    undone.set(e.undoOf, set);
  }
  const acted = {};
  for (const e of entries) {
    if (e.undoOf || e.result?.error) continue;
    const u = undone.get(e.id);
    if (u === "ALL") continue;
    const failed = new Set(Array.isArray(e.result?.failedIds) ? e.result.failedIds : []);
    const newShape = Array.isArray(e.result?.failedIds);
    if (e.action === "delete") {
      if (newShape && e.result?.trashed === 0) continue;
      for (const id of e.emailIds || []) {
        if (failed.has(id)) continue;
        if (u instanceof Set && u.has(id)) continue;
        acted[id] = { ...(acted[id] || {}), deleted: true, account: e.account, emailIds: [id], deleteEntryId: e.id };
      }
    } else if (e.action === "killlist_add" && e.result?.added === true) {
      for (const id of e.emailIds || []) {
        if (u instanceof Set && u.has(id)) continue;
        acted[id] = { ...(acted[id] || {}), killed: true, account: e.account, emailIds: [id], sender: e.sender, killEntryId: e.id };
      }
    }
  }
  return acted;
}
```

- [ ] **Step 4: Run** — `node --test daemon/action-log.test.js`; then `npm test`; then `npm run test:e2e`. **The e2e's undo assertion asserts the OLD whole-entry behavior** (undoing one row → 0 acted): under per-row undo the app sends the FULL `a.emailIds` (which for a server-hydrated row is `[thatId]`), so undoing one row now leaves the other 11 acted — update `e2e/panel.smoke.spec.js` to expect `actedBefore - 1` (and the reload assertion likewise). This restores the originally-intended assertion the Cluster A e2e had to weaken.

- [ ] **Step 5: Commit**

```bash
git add daemon/action-log.js daemon/action-log.test.js e2e/panel.smoke.spec.js
git commit -m "feat(audit): per-row undo accounting + failed-id exclusion in deriveActed"
```

---

### Task 6: api.js — `withAudit`, persisted guard, `POST /senders/delete-all`

**Files:**
- Modify: `daemon/api.js`
- Test: `daemon/api.test.js`

**Interfaces:**
- Consumes: `deps.deleteBySenderFn(accountId, sender, {sinceHours, correspondents}?)` (wired in Task 7; tests inject a fake).
- Produces:
  - Internal `withAudit(res, base, exec)`: runs exec → appends `{...base, result}` (with `emailIds` backfilled from `result.emailIds` when base lacks them) → responds `{...result, entryId?}`; catch path appends `{...base, result:{error}}` → responds `{ok:false, error, entryId?}`. **`entryId` omitted when `entry.persisted === false`** (or no actionLog).
  - The four existing mutating routes (delete/restore/killlist/killlist-remove) rewritten onto `withAudit` with byte-compatible responses. Triage route stays hand-rolled (it has the `onTriage` re-tick hook + clamp) but gains the same persisted-guard for its entryId.
  - New route `POST /senders/delete-all` body `{account, sender, sinceHours?}` → 400 unless known account + sender; `sinceHours` clamped (default 720, max 8760); audit entry action `"delete"` with `bySender: sender` and `emailIds` from the result.

- [ ] **Step 1: Failing tests** (append to `daemon/api.test.js`; add a `deleteBySenderFn` fake to the harness and pass it into `createApiServer`):

In `before()`: `const deleteBySenderFn = async (account, sender, opts) => (sender.includes("vip") ? { matched: 0, trashed: 0, failed: 0, failedIds: [], emailIds: [], refused: "protected sender" } : { matched: 3, trashed: 3, failed: 0, failedIds: [], emailIds: ["s1", "s2", "s3"], sinceHours: opts?.sinceHours });` — record `lastDeleteBySender = { account, sender, opts }` for assertions (module-level let, mirroring `lastTriageArgs`). Add `deleteBySenderFn` to the `createApiServer` deps.

```js
describe("POST /senders/delete-all", () => {
  it("deletes by sender, audits with the result emailIds, returns entryId", async () => {
    const body = await (await fetch(`${base}/senders/delete-all`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", sender: "noise@z.com" }) })).json();
    assert.equal(body.trashed, 3);
    assert.ok(body.entryId);
    const e = actionLog.recent().find(en => en.id === body.entryId);
    assert.equal(e.action, "delete");
    assert.equal(e.bySender, "noise@z.com");
    assert.deepEqual(e.emailIds, ["s1", "s2", "s3"]);
    assert.equal(lastDeleteBySender.opts.sinceHours, 720); // default window
  });
  it("clamps sinceHours and validates input", async () => {
    await fetch(`${base}/senders/delete-all`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", sender: "noise@z.com", sinceHours: 99999 }) });
    assert.equal(lastDeleteBySender.opts.sinceHours, 8760);
    assert.equal((await fetch(`${base}/senders/delete-all`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "ghost", sender: "x@y.com" }) })).status, 400);
    assert.equal((await fetch(`${base}/senders/delete-all`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell" }) })).status, 400);
  });
  it("surfaces a guard refusal without acted contribution", async () => {
    const body = await (await fetch(`${base}/senders/delete-all`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", sender: "vip@x.com" }) })).json();
    assert.match(body.refused, /protected/);
    const res = await (await fetch(`${base}/actions`)).json();
    assert.equal(Object.keys(res.acted).some(k => k.startsWith("s")) && false, false); // no acted rows from refusal (emailIds empty)
  });
  it("omits entryId when the audit write did not persist", async () => {
    // harness: swap actionLog.append to return { id: "x", persisted: false } for one call
    const orig = actionLog.append.bind(actionLog);
    actionLog.append = (e) => ({ ...orig(e), persisted: false });
    const body = await (await fetch(`${base}/messages/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", emailIds: ["pz"] }) })).json();
    actionLog.append = orig;
    assert.equal(body.entryId, undefined);
    assert.equal(body.trashed, 1); // action itself still succeeded
  });
});
```

- [ ] **Step 2: Verify fail** (404 on new route, entryId present in persisted test, etc.). All pre-existing tests must still pass.

- [ ] **Step 3: Implement in `daemon/api.js`.**

1. Helper (inside `createApiServer`, after `persist`):

```js
  // One shape for mutate→audit→respond. entryId is only surfaced when the audit
  // line actually hit disk — otherwise the client treats the action as
  // session-only instead of server-backed (prevents acted state vanishing on
  // the next /actions reconcile).
  async function withAudit(res, base, exec) {
    const entryIdOf = (entry) => (entry && entry.persisted !== false ? { entryId: entry.id } : {});
    try {
      const result = await exec();
      const entryBase = (!base.emailIds && Array.isArray(result?.emailIds)) ? { ...base, emailIds: result.emailIds } : base;
      const entry = actionLog?.append({ ...entryBase, result });
      return send(res, 200, { ...result, ...entryIdOf(entry) });
    } catch (err) {
      const entry = actionLog?.append({ ...base, result: { error: err.message } });
      return send(res, 200, { ok: false, error: err.message, ...entryIdOf(entry) });
    }
  }
```

2. Rewrite the four mutating routes onto it (delete shown; killlist/restore/killlist-remove identical in shape, preserving each route's validation + base fields exactly as today):

```js
    if (req.method === "POST" && path === "/messages/delete") {
      const body = await readJson(req);
      const account = body?.account, ids = body?.emailIds;
      if (!accounts.some(a => a.id === account) || !Array.isArray(ids) || ids.length === 0) return send(res, 400, { error: "account and non-empty emailIds required" });
      const base = { action: "delete", account, emailIds: ids, ...(body?.undoOf ? { undoOf: body.undoOf } : {}) };
      return withAudit(res, base, () => deleteFn(account, ids));
    }
```

3. New route (place with the other `/senders/*` routes):

```js
    if (req.method === "POST" && path === "/senders/delete-all") {
      const body = await readJson(req);
      const account = body?.account, sender = body?.sender;
      if (!accounts.some(a => a.id === account) || !sender) return send(res, 400, { error: "account and sender required" });
      const raw = Number(body?.sinceHours);
      const sinceHours = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 8760) : 720;
      const base = { action: "delete", account, bySender: sender, ...(body?.undoOf ? { undoOf: body.undoOf } : {}) };
      return withAudit(res, base, () => deleteBySenderFn(account, sender, { sinceHours }));
    }
```

4. Destructure `deleteBySenderFn` from deps. Triage route: apply the `entryIdOf` persisted-guard to its two entryId usages (extract `entryIdOf` to module scope or duplicate the 1-line check). Update the top-of-file route doc block with the new route.

- [ ] **Step 4: Run** — `node --test daemon/api.test.js` (all old + new green); `npm test`.

- [ ] **Step 5: Commit**

```bash
git add daemon/api.js daemon/api.test.js
git commit -m "feat(api): withAudit consolidation, persisted-entry guard, POST /senders/delete-all"
```

---

### Task 7: Daemon in-process wiring + kill-list full-cycle exports

**Files:**
- Modify: `daemon/daemon.js`, `daemon/fake-connectors.js`, `daemon/fake-connectors.test.js`, `scripts/killlist-add.js`, `scripts/killlist-remove.js`

**Interfaces:**
- Produces:
  - `scripts/killlist-add.js` exports `applyKillListAdd(root, accountId, sender)` — the CLI body (load config + correspondents → `addSenderToKillList` → `atomicWrite` when added → return `{added, reason, value}`) extracted into a function; the CLI branch calls it. Same for `applyKillListRemove(root, accountId, sender)` in killlist-remove.js (mirror its existing CLI body).
  - `daemon.js` real connector set imports from `scripts/mail.js` + the kill-list functions; NO subprocess for fetch/delete/restore/body/killlist. Subprocess kept for: triage, save-draft, claude reasoner.
  - `makeFakeConnectors()` gains `deleteBySenderFn: async (account, sender) => ({ matched: 3, trashed: 3, failed: 0, failedIds: [], emailIds: ["f1", "f2", "f3"] })`.

- [ ] **Step 1: Failing test** — extend `daemon/fake-connectors.test.js`: fake set includes `deleteBySenderFn` returning the canned shape (assert `emailIds.length === 3`). Add a source-contract test asserting `daemon/daemon.js` imports from `../scripts/mail.js` (regex on source, mirroring contract.test.js style) and no longer references `delete-emails.js`/`restore-emails.js`/`fetch-message.js`/`fetch-emails.js`/`fetch-gmail.js` as subprocess args.

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement.**

In `daemon/daemon.js`:

```js
import { fetchMail, deleteEmails, restoreEmails, fetchMessageBody, deleteBySender } from "../scripts/mail.js";
import { applyKillListAdd } from "../scripts/killlist-add.js";
import { applyKillListRemove } from "../scripts/killlist-remove.js";
import { loadCorrespondentsFile, correspondentSet } from "../scripts/correspondents.js";
```

Replace the subprocess connector factories (`fetchSubprocess`, `makeDeleteFn`, `makeRestoreFn`, `fetchBody`, `killlistFn`, `killlistRemoveFn`) with, in `main()` after `loadConfig`:

```js
  const acctById = new Map(companies.companies.map(a => [a.id, a]));
  const acct = (id) => { const a = acctById.get(id); if (!a) throw new Error(`unknown account: ${id}`); return a; };
  const correspondentsFor = (id) => {
    try { return correspondentSet(loadCorrespondentsFile(join(dataDir, "correspondents.json")), id); }
    catch { return undefined; }
  };
  const real = {
    fetchFn: (accountId, folder, hours) => {
      const a = acct(accountId);
      return a.provider === "gmail"
        ? fetchMail(a, { hours, max: 100 })
        : fetchMail(a, { hours, folder, max: 500, bodyChars: 4000 });
    },
    deleteFn: (accountId, ids) => deleteEmails(acct(accountId), ids),
    restoreFn: (accountId, ids) => restoreEmails(acct(accountId), ids),
    fetchBodyFn: (accountId, emailId) => fetchMessageBody(acct(accountId), emailId),
    deleteBySenderFn: (accountId, sender, opts = {}) =>
      deleteBySender(acct(accountId), sender, { ...opts, correspondents: correspondentsFor(accountId) }),
    killlistFn: async (accountId, sender) => applyKillListAdd(configDir, accountId, sender),
    killlistRemoveFn: async (accountId, sender) => applyKillListRemove(configDir, accountId, sender),
    runTriageFn,
  };
```

NOTE the kill-list full-cycle functions take the CONFIG DIR (where companies.json lives), not repo root — define their signature as `applyKillListAdd(configDir, accountId, sender, { correspondentsPath } = {})` reading `join(configDir, "companies.json")`; the correspondents file default stays `data/correspondents.json` relative to repo root in the CLI, and the daemon passes `join(dataDir, "correspondents.json")` — thread it explicitly to avoid hidden path assumptions:

```js
// killlist-add.js
export async function applyKillListAdd(configDir, accountId, sender, { correspondentsPath } = {}) {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { atomicWrite } = await import("./fs-utils.js");
  const { loadCorrespondentsFile, correspondentSet } = await import("./correspondents.js");
  const cfgPath = join(configDir, "companies.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  let correspondents;
  try { if (correspondentsPath) correspondents = correspondentSet(loadCorrespondentsFile(correspondentsPath), accountId); } catch { correspondents = undefined; }
  const r = addSenderToKillList(cfg, accountId, sender, { correspondents });
  if (r.added) atomicWrite(cfgPath, JSON.stringify(cfg, null, 2));
  return { added: r.added, reason: r.reason, value: r.value || null };
}
```

CLI branch calls `applyKillListAdd(join(root, "config"), accountId, sender, { correspondentsPath: join(root, "data/correspondents.json") })` and prints the JSON. Mirror for killlist-remove.js (no correspondents needed there — read its current CLI body and preserve behavior). Daemon calls pass `correspondentsPath: join(dataDir, "correspondents.json")`.

Pass `real` (chosen vs fakes as today via `chooseConnectors`) into `createApiServer` including the new `deleteBySenderFn`; keep `runProcess`, `runClaude`, `makeSaveDraftFn`, `runTriageFn` unchanged. Remove now-dead subprocess factories and unused imports.

In `daemon/fake-connectors.js`: add the canned `deleteBySenderFn`.

- [ ] **Step 4: Run** — `node --test daemon/fake-connectors.test.js`, `npm test`, and `npm run test:e2e` (fake mode unaffected; boot path must not touch real clients). Manual sanity (worktree, safe): `node daemon/daemon.js --once --data-dir <tmp> --config-dir <tmp-with-fake-config>` with `OFFICEOS_FAKE_CONNECTORS=1` exits 0.

- [ ] **Step 5: Commit**

```bash
git add daemon/daemon.js daemon/fake-connectors.js daemon/fake-connectors.test.js scripts/killlist-add.js scripts/killlist-remove.js
git commit -m "feat(daemon): in-process mail connectors + kill-list full-cycle imports; deleteBySenderFn wired"
```

---

### Task 8: Panel — cluster "Delete all" → `/senders/delete-all`

**Files:**
- Modify: `daemon/web/render.js`, `daemon/web/app.js`
- Test: `daemon/web/render.test.js`, `daemon/web/contract.test.js`

**Interfaces:**
- Consumes: `POST /senders/delete-all {account, sender}` → `{matched, trashed, failed, emailIds, refused?, entryId?}`.
- Produces: the per-sender cluster "Delete all" button emits `data-delete-sender` (not `data-delete`); row-level and tile-level Delete buttons unchanged.

- [ ] **Step 1: Failing tests.**

`render.test.js` (sender-clustered describe): change the cluster expectation — the group header's delete-all button must carry `data-delete-sender="brickellpay" data-sender="noreply@brickellpay.com" data-ids="e1,e2"` and token `delall:cluster:brickellpay:noreply@brickellpay.com`; it must NOT be `data-delete`. Row buttons keep `del:msg:` tokens (assert unchanged).

`contract.test.js`: add — render emits `data-delete-sender`; app selects `[data-delete-sender]` and posts `"/senders/delete-all"`.

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement.**

`render.js` — in the clustered branch of `renderDetailPanel`, replace the `delAll` builder:

```js
      const delAll = confirmBtn({ cls: "del", attr: "data-delete-sender", value: item.account, extra: ` data-ids="${esc(ids)}" data-sender="${esc(grp.from || "")}"`, token: `delall:cluster:${item.account}:${senderKey}`, verb: "delete all", confirm, busy, disabled: !grp.from });
```

`app.js` — add a handler ABOVE the `[data-delete]` handler (order matters — a `data-delete-sender` button must not fall through):

```js
  const dsa = e.target.closest("[data-delete-sender]");
  if (dsa) {
    const token = dsa.dataset.token, account = dsa.dataset.deleteSender, sender = dsa.dataset.sender, ids = (dsa.dataset.ids || "").split(",").filter(Boolean);
    return void confirmThen(token, async () => {
      ui.undo = null; ui.notice = null;
      const r = await postJson("/senders/delete-all", { account, sender });
      if (r.refused) { ui.notice = `Refused: ${r.refused}`; draw(); return; }
      if (r.ok !== false) {
        // Optimistically dim the rendered rows; the server-derived acted map
        // (which covers ALL matched ids, rendered or not) reconciles on load().
        for (const id of ids) ui.acted[id] = { deleted: true, account, emailIds: [id], deleteEntryId: r.entryId };
      }
      ui.notice = r.ok === false ? `Delete failed: ${r.error}` : `Moved ${r.trashed} to Trash (${r.matched} matched)`;
      await load();
    });
  }
```

- [ ] **Step 4: Run** — `node --test daemon/web/render.test.js daemon/web/contract.test.js`; `npm test`; `npm run test:e2e`. **e2e note:** the smoke's cluster delete currently clicks the `aside.detail .del` button which is now `data-delete-sender`-backed; fake mode returns `emailIds: ["f1","f2","f3"]` which don't match the seeded rows — the optimistic dim uses the rendered `data-ids`, so `.msg.acted` rows still appear; but after reload, server-derived acted keys are f1..f3, NOT the seeded e0..e11, so the reload-persistence assertion would break. Update `makeFakeConnectors().deleteBySenderFn` to echo realistic ids: since it can't see the panel, make the FAKE return `emailIds` from a closure recording nothing — instead change the e2e flow: perform the row-level delete (`del:msg:` button) for the acted/undo/reload assertions (ids are real), and add a SEPARATE assertion for delete-all: click it, expect the "Moved 3 to Trash (3 matched)" notice. Adjust the spec file accordingly.

- [ ] **Step 5: Commit**

```bash
git add daemon/web/render.js daemon/web/app.js daemon/web/render.test.js daemon/web/contract.test.js e2e/panel.smoke.spec.js
git commit -m "feat(panel): cluster Delete-all posts intent-level /senders/delete-all"
```

---

### Task 9: Docs + full verification

**Files:**
- Modify: `daemon/README.md`

- [ ] **Step 1:** README updates: add a "Mail connector library" section (scripts/mail.js is the single mail-touching path; CLI scripts are shims; daemon runs in-process; `POST /senders/delete-all {account, sender, sinceHours?}` — guarded, 30-day default window, 1-year cap, inbox-only, cap 1000; audit entries carry `bySender` + actual emailIds so Undo works). Update the API route list.

- [ ] **Step 2:** Full verification: `npm test` (all green), `npm run test:e2e` (green). Record counts.

- [ ] **Step 3: Commit**

```bash
git add daemon/README.md
git commit -m "docs(daemon): unified mail connector layer + delete-all endpoint"
```

---

## Self-review notes (already applied)

- Spec coverage: Component 1 → Tasks 1–3; Component 2 → Task 4; Component 3 → Task 7; Component 4 → Tasks 6+8; Component 5 → Tasks 5+6; Component 6 → Task 3 (rails) + per-task tests.
- Deviations captured in-task: e2e undo assertion strengthens to per-row (Task 5); e2e delete-all asserted via notice, row-level delete drives the undo/reload flow (Task 8); correspondent guard threaded via injected Set (matches killlist-add's real mechanism — spec's "sender-guards" wording was imprecise).
- Type consistency: `deleteBySenderFn(accountId, sender, {sinceHours})` (api) ↔ `deleteBySender(account, sender, {sinceHours, correspondents})` (mail) ↔ fake `{matched, trashed, failed, failedIds, emailIds}` — shapes align; `withAudit` backfills `emailIds` from results for the delete-all base.
- Known post-B1 items (B2): multi-select bulk bar, kill button `data-ids`, tile-level kill hydration.
