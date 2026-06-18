# Panel Actions — Plan A: Message Bodies in Details

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each message's body inside the panel's slide-in Details view, fetched on demand (never persisted).

**Architecture:** A new read-only connector `scripts/fetch-message.js` fetches one message's body by id (Outlook Graph or Gmail, branching on the account's provider, stripped to plain text). The daemon exposes `GET /messages/:id/body?account=` backed by an injected `fetchBodyFn`. The detail panel renders a per-message body placeholder; `app.js` lazy-loads each body when the panel opens and caches it. No body is written to `world-model.json`.

**Tech Stack:** Node ESM, `node:test`, Microsoft Graph + googleapis (already deps), vanilla browser JS/CSS.

**Spec:** `docs/superpowers/specs/2026-06-18-panel-actions-design.md` (this is Plan A of 3).

**Baseline:** full suite green (505/505). Run `npm test` from repo root. Keep green.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `scripts/fetch-message.js` | fetch one message body by id (read-only) | create |
| `daemon/daemon.js` | wire `fetchBodyFn` + `accounts` into the API | modify |
| `daemon/api.js` | `GET /messages/:id/body` route | modify |
| `daemon/web/render.js` | per-message body placeholder in detail panel | modify |
| `daemon/web/app.js` | lazy body fetch + cache on panel open | modify |
| `daemon/web/styles.css` | body block styling | modify |
| `scripts/test/rails-guard-connectors.test.js` | assert fetch-message.js is read-only | modify |
| `scripts/test/fetch-message.test.js` | unit test the pure Gmail body extractor | create |
| `daemon/api.test.js` | test the body endpoint | modify |
| `daemon/web/render.test.js`, `contract.test.js` | placeholder + glue contract | modify |

---

## Task 1: `fetch-message.js` connector + pure Gmail body extractor

**Files:**
- Create: `scripts/fetch-message.js`
- Test: `scripts/test/fetch-message.test.js`

- [ ] **Step 1: Write the failing test for the pure extractor**

Create `scripts/test/fetch-message.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractGmailBody } from "../fetch-message.js";

const b64 = (s) => Buffer.from(s, "utf-8").toString("base64");

describe("extractGmailBody", () => {
  it("prefers text/plain", () => {
    const payload = { mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { data: b64("hello plain") } },
      { mimeType: "text/html", body: { data: b64("<p>hello html</p>") } },
    ] };
    assert.equal(extractGmailBody(payload), "hello plain");
  });
  it("falls back to stripped text/html when no plain part", () => {
    const payload = { mimeType: "text/html", body: { data: b64("<p>hi <b>there</b></p>") } };
    assert.equal(extractGmailBody(payload), "hi there");
  });
  it("recurses into nested parts", () => {
    const payload = { mimeType: "multipart/mixed", parts: [
      { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/plain", body: { data: b64("nested plain") } },
      ] },
    ] };
    assert.equal(extractGmailBody(payload), "nested plain");
  });
  it("returns empty string for an empty/absent payload", () => {
    assert.equal(extractGmailBody(null), "");
    assert.equal(extractGmailBody({ mimeType: "text/plain" }), "");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/test/fetch-message.test.js`
Expected: FAIL — cannot import `extractGmailBody` (module/file does not exist).

- [ ] **Step 3: Create the connector**

Create `scripts/fetch-message.js`:

```js
/**
 * fetch-message.js <accountId> <messageId>
 *
 * Fetches ONE message's body by id and prints { id, body } (plain text) to
 * stdout. Read-only: no send, no delete. Branches on the account's provider
 * (Outlook Graph vs Gmail). HTML bodies are stripped to text before output;
 * the panel never renders raw HTML.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripHtml } from "./fetch-emails.js";
import "dotenv/config";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pure: best-effort plain text from a Gmail message payload. Prefers text/plain,
 * then stripped text/html, then a top-level body; recurses into multipart parts.
 */
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

async function outlookBody(accountId, messageId) {
  const { buildGraphClient } = await import("./graph-client.js");
  const email = process.env[`${accountId.toUpperCase()}_EMAIL`];
  const client = await buildGraphClient(accountId);
  const path = email ? `/users/${email}/messages/${messageId}` : `/me/messages/${messageId}`;
  const msg = await client.api(path).select("id,body").get();
  return { id: msg.id, body: stripHtml(msg.body?.content || "") };
}

async function gmailBody(messageId) {
  const { buildGmailClient } = await import("./gmail-client.js");
  const gmail = await buildGmailClient();
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  return { id: res.data.id, body: extractGmailBody(res.data.payload) };
}

if (process.argv[1] && process.argv[1].endsWith("fetch-message.js")) {
  const accountId = process.argv[2];
  const messageId = process.argv[3];
  if (!accountId || !messageId) {
    console.error("Usage: node scripts/fetch-message.js <accountId> <messageId>");
    process.exit(1);
  }
  try {
    const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
    const account = companies.companies.find((c) => c.id === accountId);
    if (!account) throw new Error(`unknown account: ${accountId}`);
    const out = account.provider === "gmail" ? await gmailBody(messageId) : await outlookBody(accountId, messageId);
    process.stdout.write(JSON.stringify(out));
  } catch (err) {
    console.error(`fetch-message.js failed: ${err.message}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/test/fetch-message.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-message.js scripts/test/fetch-message.test.js
git commit -m "feat(connector): fetch-message.js — read one message body (read-only)"
```

---

## Task 2: `GET /messages/:id/body` endpoint + daemon wiring

**Files:**
- Modify: `daemon/api.js`, `daemon/daemon.js`
- Test: `daemon/api.test.js`

- [ ] **Step 1: Add a failing endpoint test**

In `daemon/api.test.js`, extend the `before()` setup so the server has `accounts` and a stub `fetchBodyFn`. Replace the `createApiServer(...)` line (currently line 23) with:

```js
  const fetchBodyFn = async (account, emailId) => {
    if (emailId === "boom") throw new Error("nope");
    return { id: emailId, body: `body of ${emailId} for ${account}` };
  };
  server = createApiServer({ store, ctxFor, getLastTickAt: () => "t", ackStore, clock: { now: () => "t" },
    accounts: [{ id: "brickell" }], fetchBodyFn });
```

Add a new describe block at the end of the file:

```js
describe("GET /messages/:id/body", () => {
  it("returns the body for a known account", async () => {
    const res = await fetch(`${base}/messages/m1/body?account=brickell`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.body, "body of m1 for brickell");
  });
  it("400s on unknown/missing account", async () => {
    assert.equal((await fetch(`${base}/messages/m1/body`)).status, 400);
    assert.equal((await fetch(`${base}/messages/m1/body?account=ghost`)).status, 400);
  });
  it("surfaces a connector error as ok:false (not a crash)", async () => {
    const body = await (await fetch(`${base}/messages/boom/body?account=brickell`)).json();
    assert.equal(body.ok, false);
    assert.match(body.error, /nope/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test daemon/api.test.js`
Expected: FAIL — `/messages/m1/body` falls through to `serveStatic` → 404 (not 200/400 as asserted).

- [ ] **Step 3: Add the route in `daemon/api.js`**

In `createApiServer`, destructure the new deps. Change the deps line (currently line 36) to:

```js
  const { store, ctxFor, getLastTickAt, webDir = DEFAULT_WEB_DIR, ackStore, clock, accounts = [], fetchBodyFn } = deps;
```

Add the route handler immediately after the `/events` block (after its `return;`, before the `approveMatch` line ~104):

```js
    const bodyMatch = path.match(/^\/messages\/([^/]+)\/body$/);
    if (req.method === "GET" && bodyMatch) {
      const emailId = decodeURIComponent(bodyMatch[1]);
      const account = url.searchParams.get("account") || "";
      if (!accounts.some(a => a.id === account)) return send(res, 400, { error: "unknown or missing account" });
      try {
        const out = await fetchBodyFn(account, emailId);
        return send(res, 200, { id: emailId, body: out.body || "" });
      } catch (err) {
        return send(res, 200, { ok: false, error: err.message });
      }
    }
```

(This sits before the final `if (req.method === "GET") return serveStatic(path, res);` so it is matched first.)

- [ ] **Step 4: Run the api test to verify it passes**

Run: `node --test daemon/api.test.js`
Expected: PASS (all, including the three new body tests).

- [ ] **Step 5: Wire `fetchBodyFn` + `accounts` in `daemon/daemon.js`**

In `daemon/daemon.js`, add an async body fetcher after `makeSaveDraftFn` (after line ~83):

```js
async function fetchBody(accountId, emailId) {
  const r = await runProcess("node", [join(root, "scripts", "fetch-message.js"), accountId, emailId], { timeoutMs: 20000 });
  if (r.status !== 0) throw new Error(r.stderr || `fetch-message failed for ${accountId}`);
  return JSON.parse(r.stdout);
}
```

Then update the `createApiServer({...})` call (currently line ~115) to pass the new deps:

```js
  const server = createApiServer({ store, ctxFor, getLastTickAt: () => lastTickAt, ackStore, clock: { now: () => new Date().toISOString() }, accounts: companies.companies, fetchBodyFn: fetchBody });
```

- [ ] **Step 6: Verify the daemon still loads (syntax/import check)**

Run: `node --check daemon/daemon.js && node --test daemon/api.test.js`
Expected: PASS (no syntax error; api tests green).

- [ ] **Step 7: Commit**

```bash
git add daemon/api.js daemon/daemon.js daemon/api.test.js
git commit -m "feat(daemon): GET /messages/:id/body endpoint + fetchBody wiring"
```

---

## Task 3: Detail-panel body placeholder + lazy load + styling

**Files:**
- Modify: `daemon/web/render.js`, `daemon/web/app.js`, `daemon/web/styles.css`
- Test: `daemon/web/render.test.js`, `daemon/web/contract.test.js`

- [ ] **Step 1: Add failing tests for the placeholder + glue contract**

In `daemon/web/render.test.js`, inside the `renderDetailPanel` describe, add:

```js
  it("renders a lazy body placeholder per message keyed by emailId", () => {
    const html = renderDetailPanel(item, Date.parse("2026-06-18T12:00:00Z"));
    assert.match(html, /data-body-for="a"/);
    assert.match(html, /data-body-for="b"/);
    assert.match(html, /bodyload/);
  });
```

In `daemon/web/contract.test.js`, add a new test:

```js
  it("app.js lazy-loads message bodies the detail panel asks for", () => {
    assert.match(render, /data-body-for=/, "render must emit data-body-for placeholders");
    assert.match(app, /\/messages\//, "app must fetch /messages/:id/body");
    assert.match(app, /data-body-for/, "app must fill the body placeholders");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test daemon/web/render.test.js daemon/web/contract.test.js`
Expected: FAIL — no `data-body-for` in render output; `app.js` lacks `/messages/` and `data-body-for`.

- [ ] **Step 3: Add the body placeholder in `daemon/web/render.js`**

In `renderDetailPanel`, replace the `msgs` mapping (the `const msgs = members.map(...)` block) with one that appends a body placeholder:

```js
  const msgs = members.map(m => {
    const who = m.fromName || m.from || m.vendor || "";
    const when = relativeTime(m.receivedAt, nowMs);
    const bodySlot = m.emailId
      ? `<div class="msgbody" data-body-for="${esc(m.emailId)}"><span class="bodyload">Loading…</span></div>`
      : "";
    return `<div class="msg"><div class="msgsub">${esc(m.subject || "(no subject)")}</div>`
      + `<div class="msgmeta">${esc(who)}${who && when ? " · " : ""}${esc(when)}</div>`
      + `${bodySlot}</div>`;
  }).join("");
```

- [ ] **Step 4: Add lazy body loading in `daemon/web/app.js`**

At module top (after the `let selected = new Set();` line), add a body cache:

```js
const bodyCache = new Map(); // emailId -> { text } | { error }
```

Add these two functions (place them above the `appEl.addEventListener("click", ...)` handler):

```js
function fillBody(el, v) {
  el.textContent = v.error ? `⚠ ${v.error}` : (v.text || "(empty)");
}

function loadBodies(item) {
  if (!item) return;
  for (const m of item.group?.members || []) {
    const id = m.emailId;
    if (!id) continue;
    const el = appEl.querySelector(`[data-body-for="${CSS.escape(id)}"]`);
    if (!el) continue;
    if (bodyCache.has(id)) { fillBody(el, bodyCache.get(id)); continue; }
    fetch(`/messages/${encodeURIComponent(id)}/body?account=${encodeURIComponent(item.account)}`)
      .then(r => r.json())
      .then(d => { const v = d.ok === false ? { error: d.error || "error" } : { text: d.body || "" }; bodyCache.set(id, v); fillBody(el, v); })
      .catch(() => fillBody(el, { error: "Couldn't load body" }));
  }
}
```

In `draw()`, after the `for (const id of selected) {...}` checkbox-restore loop and before the closing brace of `draw()`, add:

```js
  if (ui.detailItemId) loadBodies(findItem(view, ui.detailItemId));
```

(`view` is already in scope in `draw()`. `textContent` escapes the body — no HTML is ever injected.)

- [ ] **Step 5: Style the body block in `daemon/web/styles.css`**

Append:

```css
.detail .msgbody { margin-top:6px; font-size:12px; color:var(--txt); white-space:pre-wrap; word-break:break-word; max-height:160px; overflow:auto; background:#0c111b; border:1px solid var(--line); border-radius:6px; padding:8px; }
.detail .bodyload { color:#8a94a6; }
```

- [ ] **Step 6: Run the web suite to verify pass**

Run: `node --test daemon/web/render.test.js daemon/web/contract.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add daemon/web/render.js daemon/web/app.js daemon/web/styles.css daemon/web/render.test.js daemon/web/contract.test.js
git commit -m "feat(panel): lazy-load message bodies in the detail panel"
```

---

## Task 4: Rails-guard extension + full suite

**Files:**
- Modify: `scripts/test/rails-guard-connectors.test.js`

- [ ] **Step 1: Add a failing rails-guard assertion for the new connector**

In `scripts/test/rails-guard-connectors.test.js`, add a describe block at the end:

```js
describe("connector rails guard — fetch-message is read-only", () => {
  it("fetch-message.js never sends or permanent-deletes", () => {
    const src = read("fetch-message.js");
    const hits = [...SEND, ...PERM_DELETE].filter(rx => rx.test(src)).map(String);
    assert.deepEqual(hits, [], `read-only connector must not send/delete: ${hits.join(", ")}`);
    assert.doesNotMatch(src, /\/move\b/, "must not move/delete messages");
  });
});
```

- [ ] **Step 2: Run the rails-guard test**

Run: `node --test scripts/test/rails-guard-connectors.test.js`
Expected: PASS — `fetch-message.js` contains only a read (`.get()`), no send/delete/move. (If it fails, the connector is doing something it must not — fix the connector, not the test.)

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS — all green, total above the 505 baseline (this plan adds tests).

- [ ] **Step 4: Commit**

```bash
git add scripts/test/rails-guard-connectors.test.js
git commit -m "test(rails): fetch-message.js is read-only (no send/delete)"
```

- [ ] **Step 5: Manual smoke (operator)**

Restart the daemon from the main checkout (`node daemon/daemon.js --port 8138`), open `http://localhost:8138/`, click **Details** on any tile, and confirm each message now shows its body below the subject/sender line (with a brief "Loading…" then the text, or "Couldn't load body" on failure). No commit needed unless the smoke surfaces a fix.

---

## Self-Review

**Spec coverage (Plan A scope only):**
- "Show each message's body in Details" → Tasks 1 (connector), 2 (endpoint), 3 (UI). ✓
- "Bodies fetched on demand, not persisted" → Task 1 returns body transiently; Task 3 fetches on panel open, caches in-memory only; nothing touches `world-model.json`. ✓
- "HTML stripped, never rendered as HTML" → `stripHtml` in connector + `textContent` fill in app.js. ✓
- "Read-only / rails" → Task 4 guard. ✓
- Delete / Kill-list / Run-triage are **out of scope for Plan A** (Plans B and C) — correctly excluded. ✓

**Placeholder scan:** none — every code step is complete.

**Type/name consistency:** `extractGmailBody`, `fetchBody`/`fetchBodyFn`, endpoint `GET /messages/:id/body?account=`, response `{ id, body }`, render attr `data-body-for`, app `bodyCache`/`loadBodies`/`fillBody` are used identically across Tasks 1–4. The endpoint returns `{ id, body }` (and `{ ok:false, error }` on connector error); `app.js` reads `d.body` / `d.ok === false` — consistent. The api-test stub `fetchBodyFn` returns `{ id, body }`, matching the real `fetchBody`. ✓
