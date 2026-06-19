# Panel Actions — Plan B: Delete + Add to Kill List

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add **Delete** (soft-delete → Trash) and **Add to Kill List** (append sender to the permanent kill-list) buttons to every tile and every detail message row, each behind a two-click confirm.

**Architecture:** Two user-command endpoints (`POST /messages/delete`, `POST /senders/killlist`) backed by injected connector fns wired in `daemon.js`. Delete reuses the rails-guard-tested `delete-emails.js`/`delete-gmail-emails.js` (soft-delete only); kill-list uses a new `killlist-add.js` that appends an email-exact rule to `company.alwaysDelete` reusing `promote-senders`' guards. The panel threads a `ui.confirm` token through render for the two-click confirm and shows a transient `ui.notice` bar for results.

**Tech Stack:** Node ESM, `node:test`, vanilla browser JS/CSS.

**Spec:** `docs/superpowers/specs/2026-06-18-panel-actions-design.md` (Plan B of 3). Plan A (bodies) is merged.

**Baseline:** full suite green (525/525). Run `npm test`. Keep green.

**Rails (non-negotiable):** Delete only soft-deletes (deleteditems/trash) — never permanent/empty-trash. Kill-list writes config only — never sends/deletes. No auto-send. The rails-guard test is extended to the new connector.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `scripts/killlist-add.js` | append a sender to a company's kill-list (guarded) | create |
| `daemon/daemon.js` | wire `deleteFn` (chunked) + `killlistFn` | modify |
| `daemon/api.js` | `POST /messages/delete`, `POST /senders/killlist` | modify |
| `daemon/web/render.js` | Delete/Kill-list buttons + two-click confirm + notice bar | modify |
| `daemon/web/app.js` | confirm-token + notice state + handlers | modify |
| `daemon/web/styles.css` | button + notice styling | modify |
| tests | `scripts/test/killlist-add.test.js` (create); extend `rails-guard-connectors.test.js`, `api.test.js`, `render.test.js`, `contract.test.js` | |

---

## Task 1: `killlist-add.js` connector + pure `addSenderToKillList`

**Files:**
- Create: `scripts/killlist-add.js`
- Test: `scripts/test/killlist-add.test.js`
- Modify: `scripts/test/rails-guard-connectors.test.js`

- [ ] **Step 1: Write the failing unit test**

Create `scripts/test/killlist-add.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addSenderToKillList } from "../killlist-add.js";

function cfg() {
  return { companies: [
    { id: "brickell", myEmail: "me@brickellpay.com", neverDelete: [], alwaysDelete: [] },
  ] };
}

describe("addSenderToKillList", () => {
  it("appends an email-exact rule for a new sender", () => {
    const r = addSenderToKillList(cfg(), "brickell", "Promo@News.Example.com");
    assert.equal(r.added, true);
    const rules = r.cfg.companies[0].alwaysDelete;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].type, "email");
    assert.equal(rules[0].value, "promo@news.example.com"); // lowercased
    assert.match(rules[0].label, /panel/i);
  });
  it("refuses a sender already on the kill-list (dedupe)", () => {
    const c = cfg();
    c.companies[0].alwaysDelete = [{ type: "email", value: "promo@news.example.com" }];
    const r = addSenderToKillList(c, "brickell", "promo@news.example.com");
    assert.equal(r.added, false);
    assert.match(r.reason, /already/i);
  });
  it("refuses a protected sender (own domain / neverDelete)", () => {
    const c = cfg();
    c.companies[0].neverDelete = [{ type: "domain", value: "vip.example.com" }];
    assert.equal(addSenderToKillList(c, "brickell", "ceo@vip.example.com").added, false);
    assert.equal(addSenderToKillList(c, "brickell", "x@brickellpay.com").added, false); // own domain
  });
  it("refuses a correspondent the user has emailed", () => {
    const corr = new Set(["friend@example.com"]);
    const r = addSenderToKillList(cfg(), "brickell", "friend@example.com", { correspondents: corr });
    assert.equal(r.added, false);
    assert.match(r.reason, /correspond/i);
  });
  it("refuses an unknown account", () => {
    assert.equal(addSenderToKillList(cfg(), "ghost", "x@y.com").added, false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/test/killlist-add.test.js`
Expected: FAIL — cannot import `addSenderToKillList`.

- [ ] **Step 3: Create `scripts/killlist-add.js`**

```js
/**
 * killlist-add.js <accountId>   (sender JSON on stdin: { "sender": "x@y.com" })
 *
 * Appends an EMAIL-EXACT rule to a company's alwaysDelete kill-list so future
 * mail from that sender auto-deletes. Config write ONLY — never sends or deletes
 * mail. Guarded (mirrors promote-senders): refuses protected senders, anyone the
 * user corresponds with, and senders already on the list.
 *
 * Prints { added: bool, reason: string|null, value: string } to stdout.
 */
import { isProtectedSender } from "./sender-guards.js";

/** Pure: returns { cfg, added, reason }. correspondents = Set<lowercased email> (optional). */
export function addSenderToKillList(cfg, accountId, sender, { correspondents } = {}) {
  const email = String(sender || "").trim().toLowerCase();
  const company = (cfg.companies || []).find(c => c.id === accountId);
  if (!company) return { cfg, added: false, reason: `unknown account: ${accountId}` };
  if (!email || !email.includes("@")) return { cfg, added: false, reason: "not a valid email address" };
  if (isProtectedSender(company, email)) return { cfg, added: false, reason: "protected sender (priority/never-delete/own domain)" };
  if (correspondents && correspondents.has(email)) return { cfg, added: false, reason: "you've emailed this sender (correspondent)" };
  company.alwaysDelete ||= [];
  const domain = email.split("@")[1] || "";
  for (const rule of company.alwaysDelete) {
    if (rule.type === "email" && (rule.value || "").toLowerCase() === email) return { cfg, added: false, reason: "already on the kill-list" };
    if (rule.type === "domain" && (rule.value || "").toLowerCase() === domain) return { cfg, added: false, reason: "domain already kill-listed" };
  }
  company.alwaysDelete.push({ type: "email", value: email, label: `added from panel` });
  return { cfg, added: true, reason: null, value: email };
}

if (process.argv[1] && process.argv[1].endsWith("killlist-add.js")) {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { atomicWrite } = await import("./fs-utils.js");
  const { loadCorrespondentsFile, correspondentSet } = await import("./correspondents.js");

  const accountId = process.argv[2];
  if (!accountId) { console.error("Usage: node scripts/killlist-add.js <accountId>  (sender JSON on stdin)"); process.exit(1); }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  let input = "";
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) input += chunk;
  let sender;
  try { sender = JSON.parse(input).sender; } catch { console.error("stdin must be JSON { sender }"); process.exit(1); }

  const cfgPath = join(root, "config/companies.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  let correspondents;
  try {
    const corrFile = loadCorrespondentsFile(join(root, "data/correspondents.json"));
    correspondents = correspondentSet(corrFile, accountId);
  } catch { correspondents = undefined; }

  const r = addSenderToKillList(cfg, accountId, sender, { correspondents });
  if (r.added) atomicWrite(cfgPath, JSON.stringify(cfg, null, 2));
  process.stdout.write(JSON.stringify({ added: r.added, reason: r.reason, value: r.value || null }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/test/killlist-add.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Extend the rails-guard for the new connector**

In `scripts/test/rails-guard-connectors.test.js`, append:

```js
describe("connector rails guard — killlist-add writes config only", () => {
  it("killlist-add.js never sends or deletes mail", () => {
    const src = read("killlist-add.js");
    const hits = [...SEND, ...PERM_DELETE].filter(rx => rx.test(src)).map(String);
    assert.deepEqual(hits, [], `kill-list connector must not send/delete: ${hits.join(", ")}`);
    assert.doesNotMatch(src, /deleteditems|messages\.trash|\/move\b/, "must not touch mail at all");
  });
});
```

- [ ] **Step 6: Run the rails-guard test**

Run: `node --test scripts/test/rails-guard-connectors.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/killlist-add.js scripts/test/killlist-add.test.js scripts/test/rails-guard-connectors.test.js
git commit -m "feat(connector): killlist-add.js — guarded kill-list append (config-only)"
```

---

## Task 2: Endpoints + daemon wiring

**Files:**
- Modify: `daemon/api.js`, `daemon/daemon.js`
- Test: `daemon/api.test.js`

- [ ] **Step 1: Add failing endpoint tests**

In `daemon/api.test.js`, add stubs to the `before()` setup. After the `fetchBodyFn` definition (before the `createApiServer(...)` call), add:

```js
  const deleted = [];
  const deleteFn = async (account, ids) => { deleted.push({ account, ids }); return { trashed: ids.length, failed: 0 }; };
  const killed = [];
  const killlistFn = async (account, sender) => { killed.push({ account, sender }); return sender.includes("vip") ? { added: false, reason: "protected sender" } : { added: true, value: sender }; };
```

Update the `createApiServer({...})` call to pass them:

```js
  server = createApiServer({ store, ctxFor, getLastTickAt: () => "t", ackStore, clock: { now: () => "t" },
    accounts: [{ id: "brickell" }], fetchBodyFn, deleteFn, killlistFn });
```

Append two describe blocks at the end of the file:

```js
describe("POST /messages/delete", () => {
  it("soft-deletes the given ids for a known account", async () => {
    const res = await fetch(`${base}/messages/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", emailIds: ["a", "b"] }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.trashed, 2);
  });
  it("400s on unknown account or missing ids", async () => {
    assert.equal((await fetch(`${base}/messages/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "ghost", emailIds: ["a"] }) })).status, 400);
    assert.equal((await fetch(`${base}/messages/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", emailIds: [] }) })).status, 400);
  });
});

describe("POST /senders/killlist", () => {
  it("adds a sender and reports added", async () => {
    const body = await (await fetch(`${base}/senders/killlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", sender: "promo@x.com" }) })).json();
    assert.equal(body.added, true);
  });
  it("surfaces a guard refusal as added:false with a reason", async () => {
    const body = await (await fetch(`${base}/senders/killlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", sender: "ceo@vip.com" }) })).json();
    assert.equal(body.added, false);
    assert.match(body.reason, /protected/);
  });
  it("400s on unknown account or missing sender", async () => {
    assert.equal((await fetch(`${base}/senders/killlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "ghost", sender: "x@y.com" }) })).status, 400);
    assert.equal((await fetch(`${base}/senders/killlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell" }) })).status, 400);
  });
});
```

- [ ] **Step 2: Run the api test to verify it fails**

Run: `node --test daemon/api.test.js`
Expected: FAIL — the new POST routes fall through (404), so the status/body assertions fail.

- [ ] **Step 3: Add a JSON-body reader + the two routes in `daemon/api.js`**

Add a small body reader helper near `send` (after the `send` function, ~line 33):

```js
function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}
```

Destructure the new deps — update the deps line to add `deleteFn, killlistFn`:

```js
  const { store, ctxFor, getLastTickAt, webDir = DEFAULT_WEB_DIR, ackStore, clock, accounts = [], fetchBodyFn, deleteFn, killlistFn } = deps;
```

Add the routes among the POST handlers (after the `unackMatch` block from the undo plan, before the GET serveStatic fallback):

```js
    if (req.method === "POST" && path === "/messages/delete") {
      const body = await readJson(req);
      const account = body?.account, ids = body?.emailIds;
      if (!accounts.some(a => a.id === account) || !Array.isArray(ids) || ids.length === 0) return send(res, 400, { error: "account and non-empty emailIds required" });
      try { return send(res, 200, await deleteFn(account, ids)); }
      catch (err) { return send(res, 200, { ok: false, error: err.message }); }
    }
    if (req.method === "POST" && path === "/senders/killlist") {
      const body = await readJson(req);
      const account = body?.account, sender = body?.sender;
      if (!accounts.some(a => a.id === account) || !sender) return send(res, 400, { error: "account and sender required" });
      try { return send(res, 200, await killlistFn(account, sender)); }
      catch (err) { return send(res, 200, { ok: false, error: err.message }); }
    }
```

- [ ] **Step 4: Run the api test to verify it passes**

Run: `node --test daemon/api.test.js`
Expected: PASS (all).

- [ ] **Step 5: Wire `deleteFn` (chunked) + `killlistFn` in `daemon/daemon.js`**

Add after `makeSaveDraftFn` (after `fetchBody`, ~line 90):

```js
function makeDeleteFn() {
  const { companies } = loadConfig();
  // Chunk ids so argv never overflows on Windows (~8k char limit); sum results.
  return async (accountId, ids) => {
    const account = companies.companies.find(c => c.id === accountId);
    const script = account?.provider === "gmail" ? "delete-gmail-emails.js" : "delete-emails.js";
    let trashed = 0, failed = 0;
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const r = await runProcess("node", [join(root, "scripts", script), accountId, ...chunk]);
      if (r.status !== 0) throw new Error(r.stderr || `delete failed for ${accountId}`);
      const m = /Done:\s*(\d+) trashed(?:,\s*(\d+) failed)?/.exec(r.stdout);
      trashed += m ? Number(m[1]) : 0;
      failed += m && m[2] ? Number(m[2]) : 0;
    }
    return { trashed, failed };
  };
}

async function killlistFn(accountId, sender) {
  const r = await runProcess("node", [join(root, "scripts", "killlist-add.js"), accountId], { input: JSON.stringify({ sender }) });
  if (r.status !== 0) throw new Error(r.stderr || `killlist-add failed for ${accountId}`);
  return JSON.parse(r.stdout);
}
```

Update the `createApiServer({...})` call to add the two deps:

```js
  const server = createApiServer({ store, ctxFor, getLastTickAt: () => lastTickAt, ackStore, clock: { now: () => new Date().toISOString() }, accounts: companies.companies, fetchBodyFn: fetchBody, deleteFn: makeDeleteFn(), killlistFn });
```

- [ ] **Step 6: Verify the daemon loads**

Run: `node --check daemon/daemon.js && node --test daemon/api.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add daemon/api.js daemon/daemon.js daemon/api.test.js
git commit -m "feat(daemon): /messages/delete + /senders/killlist endpoints + wiring"
```

---

## Task 3: Delete + Kill List buttons with two-click confirm + notice bar

**Files:**
- Modify: `daemon/web/render.js`, `daemon/web/app.js`, `daemon/web/styles.css`
- Test: `daemon/web/render.test.js`, `daemon/web/contract.test.js`

- [ ] **Step 1: Add failing tests**

In `daemon/web/render.test.js`, append:

```js
describe("destructive buttons + confirm", () => {
  const gw = {
    id: "brickell:gateway:nmi:1", account: "brickell", jobType: "gateway", title: "T", status: "at_risk",
    group: { rootCause: "r", members: [{ subject: "s", emailId: "e1", from: "support@nmi.com", fromName: "NMI" }] },
    display: { primarySender: "NMI", messageCount: 1, latestDate: null, accountLabel: "Brickell Pay" },
    source: [], proposals: [],
  };
  it("renders Delete + Kill list buttons on a card", () => {
    const html = renderItemCard(gw, 0);
    assert.match(html, /data-delete="brickell"/);
    assert.match(html, /data-killlist="brickell"/);
    assert.match(html, /Delete/);
    assert.match(html, /Kill list/);
  });
  it("shows a confirm label when the confirm token matches", () => {
    const html = renderItemCard(gw, 0, { confirm: "del:tile:brickell:gateway:nmi:1" });
    assert.match(html, /Confirm/);
  });
  it("renderNoticeBar shows a message + empty when null", () => {
    assert.match(renderNoticeBar("Moved 2 to Trash"), /Moved 2 to Trash/);
    assert.equal(renderNoticeBar(null), "");
  });
});
```

Update the render.test import line to include `renderNoticeBar`:

```js
import { renderHeader, renderItemCard, renderAccountSection, renderDetailPanel, renderUndoBar, renderNoticeBar, relativeTime, safeUrl } from "./render.js";
```

In `daemon/web/contract.test.js`, add inside the top-level describe:

```js
  it("app handles delete and killlist actions the cards emit", () => {
    for (const attr of ["data-delete", "data-killlist"]) {
      assert.match(render, new RegExp(attr), `render must emit ${attr}`);
      assert.match(app, new RegExp(`\\[${attr}\\]`), `app must select [${attr}]`);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test daemon/web/render.test.js daemon/web/contract.test.js`
Expected: FAIL — no delete/killlist buttons, `renderNoticeBar` not exported, app lacks the handlers.

- [ ] **Step 3: Add the buttons + confirm + notice in `daemon/web/render.js`**

Add a confirm-aware helper and notice renderer; wire buttons into the card and detail rows.

First add near the top (after `safeUrl`):

```js
// Two-click confirm: a button shows "Confirm <verb>?" when `confirm` equals its token.
function confirmBtn({ cls, attr, value, extra = "", token, verb, confirm, disabled = false }) {
  const armed = confirm && confirm === token;
  const label = armed ? `Confirm ${verb}?` : verb[0].toUpperCase() + verb.slice(1);
  return `<button class="${cls}${armed ? " armed" : ""}" ${attr}="${esc(value)}"${extra} data-token="${esc(token)}"${disabled ? " disabled" : ""}>${esc(label)}</button>`;
}

export function renderNoticeBar(notice) {
  if (!notice) return "";
  return `<div class="notice"><span>${esc(notice)}</span></div>`;
}
```

Change `renderItemCard` to accept `opts` and emit the two buttons. Replace the signature line and the final `actions` return:

- Signature: `export function renderItemCard(item, nowMs = Date.now(), opts = {}) {`
- After the existing `detailBtn` line add:

```js
  const confirm = opts.confirm || null;
  const ids = (item.group?.members || []).map(m => m.emailId).filter(Boolean).join(",");
  const senders = [...new Set((item.group?.members || []).map(m => m.from).filter(Boolean))];
  const delBtn = ids
    ? confirmBtn({ cls: "del", attr: "data-delete", value: item.account, extra: ` data-ids="${esc(ids)}"`, token: `del:tile:${item.id}`, verb: "delete", confirm })
    : "";
  const killBtn = confirmBtn({ cls: "kill", attr: "data-killlist", value: item.account, extra: ` data-sender="${esc(senders[0] || "")}"`, token: `kill:tile:${item.id}`, verb: "kill list", confirm, disabled: senders.length !== 1 });
```

- In the returned `<div class="actions">...`, append `${delBtn}${killBtn}` after the existing buttons:

```js
    + `<div class="actions">${approveBtn}${routeBtn}${ackBtn}${detailBtn}${delBtn}${killBtn}${dismissBtn}</div></div>`;
```

Update `renderAccountSection` to pass `opts` through:

```js
export function renderAccountSection(group, collapsed, nowMs = Date.now(), opts = {}) {
  ...
  const body = collapsed ? "" : `<div class="list">${group.items.map(i => renderItemCard(i, nowMs, opts)).join("")}</div>`;
  ...
}
```

In `renderDetailPanel(item, nowMs = Date.now(), opts = {})`, add per-message Delete/Kill-list buttons. In the `msgs` map, after computing `who`/`when`/`bodySlot`, build row buttons and append:

```js
  const confirm = opts.confirm || null;
  const msgs = members.map(m => {
    const who = m.fromName || m.from || m.vendor || "";
    const when = relativeTime(m.receivedAt, nowMs);
    const bodySlot = m.emailId ? `<div class="msgbody" data-body-for="${esc(m.emailId)}"><span class="bodyload">Loading…</span></div>` : "";
    const rowDel = m.emailId ? confirmBtn({ cls: "del", attr: "data-delete", value: item.account, extra: ` data-ids="${esc(m.emailId)}"`, token: `del:msg:${m.emailId}`, verb: "delete", confirm }) : "";
    const rowKill = m.from ? confirmBtn({ cls: "kill", attr: "data-killlist", value: item.account, extra: ` data-sender="${esc(m.from)}"`, token: `kill:msg:${m.emailId || m.from}`, verb: "kill list", confirm }) : "";
    return `<div class="msg"><div class="msgsub">${esc(m.subject || "(no subject)")}</div>`
      + `<div class="msgmeta">${esc(who)}${who && when ? " · " : ""}${esc(when)}</div>`
      + `<div class="msgactions">${rowDel}${rowKill}</div>`
      + `${bodySlot}</div>`;
  }).join("");
```

(Signature change: make `renderDetailPanel(item, nowMs = Date.now(), opts = {})`.)

- [ ] **Step 4: Wire `daemon/web/app.js`**

(a) Import `renderNoticeBar`:

```js
import { renderHeader, renderAccountSection, renderDetailPanel, renderSelectControls, renderUndoBar, renderNoticeBar, esc } from "./render.js";
```

(b) Add `confirm: null` and `notice: null` to `ui`:

```js
const ui = { account: "", query: "", collapsed: new Set(), detailItemId: null, undo: null, confirm: null, notice: null };
```

(c) In `draw()`, pass `opts` to sections + detail and render the notice bar. Change the relevant lines:

```js
  const opts = { confirm: ui.confirm };
  const sections = groups.map(g => renderAccountSection(g, ui.collapsed.has(g.account), now, opts)).join("");
  const detail = ui.detailItemId ? renderDetailPanel(findItem(view, ui.detailItemId), now, opts) : "";
```

and append both bars to the innerHTML:

```js
    + detail
    + renderUndoBar(ui.undo)
    + renderNoticeBar(ui.notice);
```

(d) Add a helper after `actThenOfferUndo`:

```js
// Two-click confirm: first click arms (shows "Confirm …?"), second runs `go`.
function confirmThen(token, go) {
  if (ui.confirm === token) { ui.confirm = null; go(); }
  else { ui.confirm = token; draw(); }
}
async function postJson(url, payload) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  return res.json();
}
```

(e) In the click handler, add delete + killlist branches BEFORE the approve branch, and clear `ui.confirm`/`ui.notice` on every non-confirm action. Insert after the `[data-undo]` block:

```js
  const del = e.target.closest("[data-delete]");
  if (del) {
    const token = del.dataset.token, account = del.dataset.delete, ids = (del.dataset.ids || "").split(",").filter(Boolean);
    return void confirmThen(token, async () => { ui.undo = null; const r = await postJson("/messages/delete", { account, emailIds: ids }); ui.notice = r.ok === false ? `Delete failed: ${r.error}` : `Moved ${r.trashed} to Trash`; await load(); });
  }
  const kill = e.target.closest("[data-killlist]");
  if (kill) {
    const token = kill.dataset.token, account = kill.dataset.killlist, sender = kill.dataset.sender;
    return void confirmThen(token, async () => { ui.undo = null; const r = await postJson("/senders/killlist", { account, sender }); ui.notice = r.added ? `Kill-listed ${sender}` : `Not kill-listed: ${r.reason || r.error}`; await load(); });
  }
```

In each of the existing non-confirm branches (approve/dismiss/ack/detail-close/detail/collapse/select/bulk and the undo branch), also clear `ui.confirm = null` and `ui.notice = null` at their start (alongside the existing `ui.undo = null` clears). For the undo branch, clear them too. Concretely, change the top of the handler so the first line after the `[data-undo]` handling clears both:

```js
appEl.addEventListener("click", (e) => {
  const u = e.target.closest("[data-undo]");
  if (u) { ui.confirm = null; ui.notice = null; if (ui.undo) { const url = ui.undo.undoUrl; ui.undo = null; post(url); } return; }
  const del = e.target.closest("[data-delete]");
  if (del) { /* as above */ }
  const kill = e.target.closest("[data-killlist]");
  if (kill) { /* as above */ }
  // every remaining branch clears the transient bars first:
  ui.confirm = null; ui.notice = null;
  const a = e.target.closest("[data-approve]");
  ...
});
```

(Keep the existing `ui.undo = null` clears in each remaining branch as they are. The single `ui.confirm = null; ui.notice = null;` line placed after the del/kill branches and before the approve branch covers approve/dismiss/ack/detail/collapse/select/bulk in one shot.)

Note: `dismiss`/`ack` use `actThenOfferUndo`, which sets `ui.undo`; that's fine — the confirm/notice are already cleared by the shared line above.

- [ ] **Step 5: Style in `daemon/web/styles.css`**

Append:

```css
.del { background:#3a1f24; color:var(--risk); }
.kill { background:#2a2433; color:#c9a9e6; }
.del[disabled], .kill[disabled] { opacity:.4; cursor:default; }
.armed { outline:2px solid currentColor; }
.msgactions { display:flex; gap:8px; margin-top:8px; }
.notice { position:fixed; left:16px; bottom:60px; background:#1b2740; border:1px solid var(--line); border-radius:8px; padding:8px 14px; color:var(--txt); font-size:13px; z-index:20; }
```

- [ ] **Step 6: Run the web suite**

Run: `node --test daemon/web`
Expected: PASS (all — existing render tests that call `renderItemCard(item)` / `renderDetailPanel(item, nowMs)` still work since `opts` defaults to `{}`).

- [ ] **Step 7: Commit**

```bash
git add daemon/web/render.js daemon/web/app.js daemon/web/styles.css daemon/web/render.test.js daemon/web/contract.test.js
git commit -m "feat(panel): Delete + Kill list buttons with two-click confirm"
```

---

## Task 4: Full suite + rails + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS, total above the 525 baseline.

- [ ] **Step 2: Rails re-check**

Run: `node --test scripts/test/rails-guard-connectors.test.js`
Expected: PASS — delete connectors soft-delete only; `killlist-add.js` touches no mail.

- [ ] **Step 3: Manual smoke (operator)**

Restart the daemon from the main checkout and open the panel. Confirm: a tile's **Delete** asks "Confirm delete?" on first click and trashes its emails on the second (a "Moved N to Trash" notice appears); **Kill list** asks to confirm then reports "Kill-listed <sender>" (or a refusal reason for a protected/correspondent sender); per-message Delete/Kill-list in Details work the same; any other click cancels an armed confirm. Verify in Outlook/Gmail that deleted items are in Trash/Deleted Items (recoverable), not gone.

No commit unless the smoke surfaces a fix.

---

## Self-Review

**Spec coverage (Plan B):**
- Delete (soft-delete) endpoint + connector reuse → Task 2 + existing `delete-*.js`. ✓
- Add to Kill List (guarded, config-only) → Task 1 (`addSenderToKillList` + `killlist-add.js`) + Task 2 endpoint. ✓
- Buttons on every tile AND every message row → Task 3 (`renderItemCard` + `renderDetailPanel`). ✓
- Two-click confirm → Task 3 (`confirmBtn` + `ui.confirm` + `confirmThen`). ✓
- Refusal/result surfaced → Task 3 notice bar. ✓
- Kill-list does NOT auto-delete the current email (separate buttons) → delete and killlist are independent branches. ✓
- Rails: delete soft-only (reused guarded connectors), kill-list config-only (guarded + rails test) → Task 1 + Task 4. ✓
- Tile kill-list uses an email address, disabled when members span >1 sender → Task 3 (`senders.length !== 1` disables). ✓

**Placeholder scan:** none — code is complete. (Task 3 Step 4 describes edits with full code blocks; the "as above" references point to code given in the same step.)

**Type/name consistency:** endpoints `/messages/delete` (`{account, emailIds}`) and `/senders/killlist` (`{account, sender}`); daemon `makeDeleteFn` returns `{trashed, failed}`, `killlistFn` returns `{added, reason, value}`; render `confirmBtn`/`renderNoticeBar`, attrs `data-delete`/`data-ids`/`data-killlist`/`data-sender`/`data-token`; app `ui.confirm`/`ui.notice`/`confirmThen`/`postJson`. Tokens `del:tile:<id>`/`kill:tile:<id>`/`del:msg:<emailId>`/`kill:msg:<emailId>` are produced by render and consumed by `confirmThen` via `data-token`. Consistent across tasks. ✓
