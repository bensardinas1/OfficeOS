# Acted-State + Per-Row Undo + Delete-and-Kill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Mark deleted/kill-listed items (dim + strike + badge) with a per-item Undo, and add a combined "Delete and Kill" button.

**Architecture:** New reverse connectors (restore-from-Trash, kill-list-remove) + endpoints back a per-item Undo; the panel records acted items client-side (`ui.acted`) and renders them dimmed with an Undo; "Delete and Kill" composes the two existing POSTs.

**Tech Stack:** Node ESM, `node:test`, vanilla browser JS/CSS.

**Spec:** `docs/superpowers/specs/2026-06-19-acted-state-undo-delete-kill-design.md`.

**Baseline:** full suite green (553+). Run `npm test`. Keep green. Rails-guard must stay green.

---

## Task 1: Reverse connectors + endpoints + daemon wiring

**Files:**
- Create: `scripts/restore-emails.js`, `scripts/restore-gmail-emails.js`, `scripts/killlist-remove.js`, `scripts/test/killlist-remove.test.js`
- Modify: `daemon/api.js`, `daemon/daemon.js`, `daemon/api.test.js`, `scripts/test/rails-guard-connectors.test.js`

- [ ] **Step 1: Failing unit test for `removeSenderFromKillList`**

Create `scripts/test/killlist-remove.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { removeSenderFromKillList } from "../killlist-remove.js";

function cfg() {
  return { companies: [ { id: "brickell", alwaysDelete: [
    { type: "email", value: "promo@x.com", label: "added from panel" },
    { type: "domain", value: "ads.example.com", label: "keep" },
  ] } ] };
}

describe("removeSenderFromKillList", () => {
  it("removes a matching email-exact rule", () => {
    const r = removeSenderFromKillList(cfg(), "brickell", "Promo@X.com");
    assert.equal(r.removed, true);
    assert.ok(!r.cfg.companies[0].alwaysDelete.some(x => x.value === "promo@x.com"));
    assert.ok(r.cfg.companies[0].alwaysDelete.some(x => x.value === "ads.example.com")); // others kept
  });
  it("is a no-op with a reason when the sender is not on the list", () => {
    const r = removeSenderFromKillList(cfg(), "brickell", "nobody@x.com");
    assert.equal(r.removed, false);
    assert.match(r.reason, /not on the kill-list/i);
  });
  it("refuses an unknown account", () => {
    assert.equal(removeSenderFromKillList(cfg(), "ghost", "x@y.com").removed, false);
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `node --test scripts/test/killlist-remove.test.js` → FAIL (no module).

- [ ] **Step 3: Create `scripts/killlist-remove.js`**

```js
/**
 * killlist-remove.js <accountId>   (sender JSON on stdin: { "sender": "x@y.com" })
 *
 * Removes an EMAIL-EXACT rule from a company's alwaysDelete kill-list (undo of
 * killlist-add). Config write ONLY — never sends or deletes mail.
 * Prints { removed: bool, reason: string|null }.
 */
export function removeSenderFromKillList(cfg, accountId, sender) {
  const email = String(sender || "").trim().toLowerCase();
  const company = (cfg.companies || []).find(c => c.id === accountId);
  if (!company) return { cfg, removed: false, reason: `unknown account: ${accountId}` };
  const before = (company.alwaysDelete || []).length;
  company.alwaysDelete = (company.alwaysDelete || []).filter(
    r => !(r.type === "email" && (r.value || "").toLowerCase() === email)
  );
  if (company.alwaysDelete.length === before) return { cfg, removed: false, reason: "not on the kill-list" };
  return { cfg, removed: true, reason: null };
}

if (process.argv[1] && process.argv[1].endsWith("killlist-remove.js")) {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { atomicWrite } = await import("./fs-utils.js");
  const accountId = process.argv[2];
  if (!accountId) { console.error("Usage: node scripts/killlist-remove.js <accountId>  (sender JSON on stdin)"); process.exit(1); }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let input = "";
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) input += chunk;
  let sender;
  try { sender = JSON.parse(input).sender; } catch { console.error("stdin must be JSON { sender }"); process.exit(1); }
  const cfgPath = join(root, "config/companies.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  const r = removeSenderFromKillList(cfg, accountId, sender);
  if (r.removed) atomicWrite(cfgPath, JSON.stringify(cfg, null, 2));
  process.stdout.write(JSON.stringify({ removed: r.removed, reason: r.reason }));
}
```

- [ ] **Step 4: Create the restore connectors**

`scripts/restore-emails.js` (Outlook — move back to inbox):

```js
/**
 * restore-emails.js <companyId> <messageId1> [messageId2 ...]
 *
 * Moves the specified messages from Deleted Items back to the Inbox (undo of a
 * soft delete). Move only — never sends or permanent-deletes.
 */
import { buildGraphClient } from "./graph-client.js";

const [, , companyId, ...messageIds] = process.argv;
if (!companyId || messageIds.length === 0) {
  console.error("Usage: node scripts/restore-emails.js <companyId> <messageId1> [messageId2 ...]");
  process.exit(1);
}
const client = await buildGraphClient(companyId);
let restored = 0, failed = 0;
for (const id of messageIds) {
  try { await client.api(`/me/messages/${id}/move`).post({ destinationId: "inbox" }); restored++; }
  catch (err) { console.error(`FAILED: ${id} — ${err.message}`); failed++; }
}
console.log(`Done: ${restored} restored${failed ? `, ${failed} failed` : ""}.`);
```

`scripts/restore-gmail-emails.js` (Gmail — untrash):

```js
/**
 * restore-gmail-emails.js <accountId> <messageId1> [messageId2 ...]
 *
 * Untrashes the specified Gmail messages (undo of a soft delete). Untrash only —
 * never sends or permanent-deletes.
 */
import { buildGmailClient } from "./gmail-client.js";
import { verifyGmailAccount } from "./gmail-verify.js";

const [, , accountIdArg, ...messageIds] = process.argv;
if (!accountIdArg || messageIds.length === 0) {
  console.error("Usage: node scripts/restore-gmail-emails.js <accountId> <messageId1> [messageId2 ...]");
  process.exit(1);
}
const gmail = await buildGmailClient();
await verifyGmailAccount(gmail, accountIdArg);
let restored = 0, failed = 0;
for (const id of messageIds) {
  try { await gmail.users.messages.untrash({ userId: "me", id }); restored++; }
  catch (err) { console.error(`Failed to untrash ${id}: ${err.message}`); failed++; }
}
console.log(`Done: ${restored} restored${failed ? `, ${failed} failed` : ""}.`);
```

- [ ] **Step 5: Extend the rails-guard**

In `scripts/test/rails-guard-connectors.test.js`, append:

```js
describe("connector rails guard — restore + killlist-remove", () => {
  for (const f of ["restore-emails.js", "restore-gmail-emails.js"]) {
    it(`${f} restores (move/untrash) and never sends or permanent-deletes`, () => {
      const src = read(f);
      const hits = [...SEND, ...PERM_DELETE].filter(rx => rx.test(src)).map(String);
      assert.deepEqual(hits, [], `${f} must not send/permanent-delete: ${hits.join(", ")}`);
    });
  }
  it("killlist-remove.js never touches mail", () => {
    const src = read("killlist-remove.js");
    const hits = [...SEND, ...PERM_DELETE].filter(rx => rx.test(src)).map(String);
    assert.deepEqual(hits, [], `must not send/delete: ${hits.join(", ")}`);
    assert.doesNotMatch(src, /deleteditems|messages\.trash|\/move\b/, "config-only");
  });
});
```

- [ ] **Step 6: Run unit + rails tests → pass**

Run: `node --test scripts/test/killlist-remove.test.js scripts/test/rails-guard-connectors.test.js` → PASS.

- [ ] **Step 7: API endpoints + tests**

In `daemon/api.test.js` `before()`, after the existing stubs add:

```js
  const restoreFn = async (account, ids) => ({ restored: ids.length, failed: 0 });
  const killlistRemoveFn = async (account, sender) => (sender.includes("nope") ? { removed: false, reason: "not on the kill-list" } : { removed: true });
```

Add `restoreFn, killlistRemoveFn` to the `createApiServer({...})` call (keep all existing deps).

Append:

```js
describe("POST /messages/restore", () => {
  it("restores ids for a known account", async () => {
    const body = await (await fetch(`${base}/messages/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", emailIds: ["a", "b"] }) })).json();
    assert.equal(body.restored, 2);
  });
  it("400s on unknown account / empty ids", async () => {
    assert.equal((await fetch(`${base}/messages/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "ghost", emailIds: ["a"] }) })).status, 400);
    assert.equal((await fetch(`${base}/messages/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", emailIds: [] }) })).status, 400);
  });
});
describe("POST /senders/killlist/remove", () => {
  it("removes a sender", async () => {
    const body = await (await fetch(`${base}/senders/killlist/remove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", sender: "promo@x.com" }) })).json();
    assert.equal(body.removed, true);
  });
  it("surfaces removed:false when absent", async () => {
    const body = await (await fetch(`${base}/senders/killlist/remove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", sender: "nope@x.com" }) })).json();
    assert.equal(body.removed, false);
  });
});
```

Run `node --test daemon/api.test.js` → FAIL (routes 404).

In `daemon/api.js`: extend the deps destructure with `restoreFn, killlistRemoveFn`. Add routes (after the existing `/messages/delete` + `/senders/killlist` blocks, before serveStatic):

```js
    if (req.method === "POST" && path === "/messages/restore") {
      const body = await readJson(req);
      const account = body?.account, ids = body?.emailIds;
      if (!accounts.some(a => a.id === account) || !Array.isArray(ids) || ids.length === 0) return send(res, 400, { error: "account and non-empty emailIds required" });
      try { return send(res, 200, await restoreFn(account, ids)); }
      catch (err) { return send(res, 200, { ok: false, error: err.message }); }
    }
    if (req.method === "POST" && path === "/senders/killlist/remove") {
      const body = await readJson(req);
      const account = body?.account, sender = body?.sender;
      if (!accounts.some(a => a.id === account) || !sender) return send(res, 400, { error: "account and sender required" });
      try { return send(res, 200, await killlistRemoveFn(account, sender)); }
      catch (err) { return send(res, 200, { ok: false, error: err.message }); }
    }
```

Run `node --test daemon/api.test.js` → PASS.

- [ ] **Step 8: Daemon wiring**

In `daemon/daemon.js` add (mirroring `makeDeleteFn`/`killlistFn`):

```js
function makeRestoreFn() {
  const { companies } = loadConfig();
  return async (accountId, ids) => {
    const account = companies.companies.find(c => c.id === accountId);
    const script = account?.provider === "gmail" ? "restore-gmail-emails.js" : "restore-emails.js";
    let restored = 0, failed = 0;
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const r = await runProcess("node", [join(root, "scripts", script), accountId, ...chunk]);
      if (r.status !== 0) throw new Error(r.stderr || `restore failed for ${accountId}`);
      const m = /Done:\s*(\d+) restored(?:,\s*(\d+) failed)?/.exec(r.stdout);
      restored += m ? Number(m[1]) : 0;
      failed += m && m[2] ? Number(m[2]) : 0;
    }
    return { restored, failed };
  };
}

async function killlistRemoveFn(accountId, sender) {
  const r = await runProcess("node", [join(root, "scripts", "killlist-remove.js"), accountId], { input: JSON.stringify({ sender }) });
  if (r.status !== 0) throw new Error(r.stderr || `killlist-remove failed for ${accountId}`);
  return JSON.parse(r.stdout);
}
```

Add `restoreFn: makeRestoreFn(), killlistRemoveFn` to the `createApiServer({...})` call (keep all existing deps).

Run `node --check daemon/daemon.js && node --test daemon/api.test.js` → PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/restore-emails.js scripts/restore-gmail-emails.js scripts/killlist-remove.js scripts/test/killlist-remove.test.js scripts/test/rails-guard-connectors.test.js daemon/api.js daemon/daemon.js daemon/api.test.js
git commit -m "feat(daemon): restore-from-trash + killlist-remove (undo) endpoints + connectors"
```

---

## Task 2: Acted-state render + Delete-and-Kill + per-item Undo (UI)

**Files:**
- Modify: `daemon/web/render.js`, `daemon/web/app.js`, `daemon/web/styles.css`
- Test: `daemon/web/render.test.js`, `daemon/web/contract.test.js`

**Read the current `daemon/web/render.js` and `daemon/web/app.js` first** (they have evolved through prior plans) and apply these additively.

- [ ] **Step 1: Failing tests**

In `daemon/web/render.test.js`, add (import `renderItemCard`, `renderDetailPanel` already present):

```js
describe("acted state + delete-and-kill", () => {
  const gw = {
    id: "brickell:gateway:nmi:1", account: "brickell", jobType: "gateway", title: "T", status: "at_risk",
    group: { rootCause: "r", members: [{ subject: "s", emailId: "e1", from: "support@nmi.com", fromName: "NMI" }] },
    display: { primarySender: "NMI", messageCount: 1, latestDate: null, accountLabel: "Brickell Pay" },
    source: [], proposals: [],
  };
  it("renders a Delete and Kill button on a card", () => {
    assert.match(renderItemCard(gw, 0), /data-delkill="brickell"/);
    assert.match(renderItemCard(gw, 0), /Delete and Kill/);
  });
  it("dims an acted tile with a badge + Undo instead of action buttons", () => {
    const html = renderItemCard(gw, 0, { acted: { "brickell:gateway:nmi:1": { deleted: true, killed: true } } });
    assert.match(html, /acted/);
    assert.match(html, /Deleted \+ kill-listed/);
    assert.match(html, /data-undo-acted="brickell:gateway:nmi:1"/);
    assert.doesNotMatch(html, /data-delete=/); // normal buttons hidden when acted
  });
  it("dims an acted detail row with the right badge", () => {
    const html = renderDetailPanel(gw, 0, { acted: { e1: { deleted: true } } });
    assert.match(html, /data-undo-acted="e1"/);
    assert.match(html, /Deleted/);
  });
});
```

In `daemon/web/contract.test.js`, add:

```js
  it("app handles delete-and-kill and per-item undo", () => {
    for (const attr of ["data-delkill", "data-undo-acted"]) {
      assert.match(render, new RegExp(attr), `render must emit ${attr}`);
      assert.match(app, new RegExp(`\\[${attr}\\]`), `app must select [${attr}]`);
    }
  });
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: render.js — acted badge + buttons.**

Add a helper near `confirmBtn`:

```js
function actedBadge(a) {
  if (a.deleted && a.killed) return "Deleted + kill-listed";
  if (a.deleted) return "Deleted";
  if (a.killed) return "Kill-listed";
  return "Acted";
}
function actedRow(key) {
  return `<div class="actedwrap"><span class="actedtag"></span><button class="undo" data-undo-acted="${esc(key)}">Undo</button></div>`;
}
```

In `renderItemCard(item, nowMs, opts)`: at the top compute `const acted = (opts.acted || {})[item.id];`. When `acted` is truthy, render the card with class `card acted` and, in place of the `<div class="actions">…</div>`, render `<div class="actions"><span class="actedtag">${esc(actedBadge(acted))}</span><button class="undo" data-undo-acted="${esc(item.id)}">Undo</button></div>` and SKIP the approve/route/ack/detail/delete/kill/dismiss buttons. When not acted, also add the new **Delete and Kill** button to the normal actions: `<button class="delkill" data-delkill="${esc(item.account)}" data-ids="${esc(ids)}" data-sender="${esc(senders[0] || "")}" data-token="delkill:tile:${esc(item.id)}"${senders.length !== 1 || !ids ? " disabled" : ""}>Delete and Kill</button>` (reuse the existing `ids`/`senders` already computed in the card).

In `renderDetailPanel(item, nowMs, opts)`: compute `const acted = opts.acted || {};` and in the per-message map, when `acted[m.emailId]` is truthy render the row's action area as `<div class="msgactions"><span class="actedtag">${esc(actedBadge(acted[m.emailId]))}</span><button class="undo" data-undo-acted="${esc(m.emailId)}">Undo</button></div>` (skip the row's delete/kill); otherwise render the existing row buttons PLUS a per-row Delete-and-Kill: `<button class="delkill" data-delkill="${esc(item.account)}" data-ids="${esc(m.emailId)}" data-sender="${esc(m.from || "")}" data-token="delkill:msg:${esc(m.emailId)}"${m.from ? "" : " disabled"}>Delete and Kill</button>`. Apply `class="msg acted"` when acted.

(Confirm tokens: the two-click confirm for `data-delkill` reuses the existing `confirm`/`confirmThen` machinery — the disabled/confirm rendering can reuse `confirmBtn` if convenient; otherwise emit the button directly with `data-token` and let app.js arm it like delete/kill.)

- [ ] **Step 4: app.js — mark acted, delete-and-kill, per-item undo.**

- Add `acted: {}` to `ui` (an object keyed by acted-key).
- In `draw()`, pass `acted: ui.acted` into the render opts (alongside `confirm`).
- After a successful **delete** action, set `ui.acted[key] = { ...(ui.acted[key]||{}), deleted: true, account, emailIds: ids }` where for a tile `key=item.id`/`ids`=all member ids, for a row `key=emailId`/`ids=[emailId]`. After a successful **kill**, set `{ killed: true, account, sender }`. (Adjust the existing `[data-delete]`/`[data-killlist]` handlers to record the acted key on success.)
- New `[data-delkill]` handler: two-click confirm (reuse `confirmThen` with the `data-token`), then `await postJson("/messages/delete", {account, emailIds: ids})` and `await postJson("/senders/killlist", {account, sender})`, then set `ui.acted[key] = { deleted: true, killed: true, account, emailIds: ids, sender }`, `load()`.
- New `[data-undo-acted]` handler: `const key = el.dataset.undoActed; const a = ui.acted[key]; if (!a) return;` then `if (a.deleted) await postJson("/messages/restore", {account: a.account, emailIds: a.emailIds});` and `if (a.killed) await postJson("/senders/killlist/remove", {account: a.account, sender: a.sender});` then `delete ui.acted[key]; ui.notice = "Undone"; load();`. On failure set `ui.notice = "Undo failed: …"` and keep the key.
- Keep the acted key for a deleted item only until the next model reload naturally drops it (deleted email gone). For kill-only, it persists (email remains) until Undo.

- [ ] **Step 5: styles.css**

```css
.card.acted, .msg.acted { opacity:.55; }
.card.acted .title, .msg.acted .msgsub { text-decoration:line-through; }
.actedtag { font-size:12px; color:#8a94a6; }
.delkill { background:#3a1f33; color:#e59ad6; }
.delkill[disabled] { opacity:.4; cursor:default; }
```

- [ ] **Step 6: Run `node --test "daemon/web/**/*.test.js"` → PASS.**

- [ ] **Step 7: Commit**

```bash
git add daemon/web/render.js daemon/web/app.js daemon/web/styles.css daemon/web/render.test.js daemon/web/contract.test.js
git commit -m "feat(panel): acted dim+strike+badge + per-item Undo + Delete and Kill"
```

---

## Task 3: Full suite + manual smoke

- [ ] **Step 1:** `npm test` → green, above baseline; rails-guard green.
- [ ] **Step 2 (operator):** Restart the daemon; in the panel, Delete a row → it dims/strikes "Deleted" with Undo → Undo restores it (verify it returns to the inbox in Outlook/Gmail). Kill a row → "Kill-listed" + Undo (removes the rule from `company.alwaysDelete`). "Delete and Kill" → "Deleted + kill-listed", Undo reverses both. Multi-sender tiles disable tile-level Kill / Delete-and-Kill.

---

## Self-Review

**Spec coverage:** restore (undo delete) + killlist-remove (undo kill) connectors/endpoints → Task 1; acted dim+strike+badge+Undo + Delete-and-Kill on rows+tiles → Task 2; rails-guard for new connectors → Task 1; tests + smoke → Tasks 1–3. ✓
**Placeholders:** Task 1 is fully concrete; Task 2 gives concrete helpers + precise integration instructions against the current (evolved) render/app files — the implementer reads those and applies additively. ✓
**Consistency:** endpoints `/messages/restore` `{account,emailIds}`→`{restored,failed}`, `/senders/killlist/remove` `{account,sender}`→`{removed,reason}`; daemon `makeRestoreFn`/`killlistRemoveFn`; render `data-delkill`/`data-undo-acted`/`actedBadge`; app `ui.acted` keyed by tile id or emailId. ✓
