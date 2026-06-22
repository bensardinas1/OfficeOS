# Handled Honest Count + Sender-Clustered Drill-In — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** (A) the handled summary counts only non-automated mail as "needs a reply or decision"; (B) the handled/triage drill-in is grouped by sender with per-sender bulk Delete/Kill/Delete-&-kill.

**Architecture:** A is a handled-local count split using the existing pure `looksAutomated`. B reworks `renderDetailPanel` to cluster handled/triage members by sender (reusing the existing delete/killlist/delkill endpoints + per-emailId acted state); `app.js` cluster handlers expand a bulk action to per-member acted entries.

**Tech Stack:** Node ESM, `node:test`, vanilla browser JS/CSS.

**Spec:** `docs/superpowers/specs/2026-06-22-handled-honest-count-and-sender-clusters-design.md`.

**Baseline:** full suite green. Run `npm test`. Keep green.

---

## Task 1: A — honest count (handled-local)

**Files:** Modify `daemon/normalizers/handled.js`; Test `daemon/normalizers/handled.test.js`.

- [ ] **Step 1: Failing test.** In `daemon/normalizers/handled.test.js`, add (the `typeConfig` there already flags `action` actionable):

```js
  it("counts automated/no-reply actionable mail as informational, not needs-a-reply", () => {
    const classified = { categories: { action: { emails: [
      { id: "p1", from: "wayne@brickellpay.com", subject: "decision?", receivedAt: "2026-06-20T00:00:00Z" },
      { id: "a1", from: "noreply@brickellpay.com", subject: "alert", receivedAt: "2026-06-20T00:00:00Z" },
      { id: "a2", from: "notifications@github.com", subject: "PR", receivedAt: "2026-06-20T00:00:00Z" },
    ] } } };
    const it0 = normalizeHandled(classified, account, typeConfig)[0];
    assert.equal(it0.group.counts.needsYou, 1);   // only wayne@ (a person)
    assert.equal(it0.group.counts.waiting, 2);     // the two automated senders
    assert.equal(it0.group.members.length, 3);     // all still listed
    assert.match(it0.title, /1 needs a reply or decision/);
  });
```

- [ ] **Step 2:** `node --test daemon/normalizers/handled.test.js` → FAIL (currently needsYou=3).

- [ ] **Step 3:** In `daemon/normalizers/handled.js`, add the import at top (after the existing `import { withinLookback } ...`):

```js
import { looksAutomated } from "../../scripts/sender-guards.js";
```

Replace the per-category counting line. Find:

```js
    if (actionable.has(id)) needsYou += emails.length; else waiting += emails.length;
```

with:

```js
    if (actionable.has(id)) {
      for (const e of emails) {
        if (looksAutomated(e.from, e.hasListUnsubscribe)) waiting++; else needsYou++;
      }
    } else {
      waiting += emails.length;
    }
```

(Everything else — member collection, cap, moreCount, title/subtitle — is unchanged.)

- [ ] **Step 4:** `node --test daemon/normalizers/handled.test.js` → PASS (new + existing).

- [ ] **Step 5: Commit.**

```bash
git add daemon/normalizers/handled.js daemon/normalizers/handled.test.js
git commit -m "feat(handled): automated/no-reply mail counts as informational, not needs-a-reply"
```

---

## Task 2: B (render) — sender-clustered detail for handled/triage

**Files:** Modify `daemon/web/render.js`, `daemon/web/styles.css`; Test `daemon/web/render.test.js`.

- [ ] **Step 1: Failing tests.** In `daemon/web/render.test.js`, append:

```js
describe("sender-clustered detail (handled/triage)", () => {
  const handled = {
    id: "brickellpay:handled", account: "brickellpay", jobType: "handled", title: "T", status: "ok",
    display: { accountLabel: "Brickell Pay" },
    group: { rootCause: "handled", members: [
      { subject: "s1", from: "noreply@brickellpay.com", fromName: "Brickell Pay", emailId: "e1", receivedAt: "2026-06-20T00:00:00Z" },
      { subject: "s2", from: "noreply@brickellpay.com", fromName: "Brickell Pay", emailId: "e2", receivedAt: "2026-06-21T00:00:00Z" },
      { subject: "s3", from: "hello@secureframe.com", fromName: "Secureframe", emailId: "e3", receivedAt: "2026-06-19T00:00:00Z" },
    ] },
    source: [], proposals: [],
  };
  it("groups by sender with a header count and per-cluster bulk buttons", () => {
    const html = renderDetailPanel(handled, 0);
    assert.match(html, /Brickell Pay \(2\)/);
    assert.match(html, /Secureframe \(1\)/);
    assert.match(html, /data-delete="brickellpay" data-ids="e1,e2"/);   // cluster delete-all carries the group's ids
    assert.match(html, /data-killlist="brickellpay" data-sender="noreply@brickellpay.com"/);
    assert.match(html, /data-delkill="brickellpay"/);
    assert.doesNotMatch(html, /del:msg:e1/);   // no per-row delete tokens in clustered view
  });
  it("keeps finding tiles flat with per-row buttons", () => {
    const gw = { id: "brickellpay:gateway:nmi:1", account: "brickellpay", jobType: "gateway", title: "T", status: "at_risk",
      group: { rootCause: "r", members: [{ subject: "s", emailId: "e1", from: "support@nmi.com", fromName: "NMI" }] }, display: {}, source: [], proposals: [] };
    assert.match(renderDetailPanel(gw, 0), /del:msg:e1/);   // flat per-row delete unchanged
  });
});
```

- [ ] **Step 2:** `node --test daemon/web/render.test.js` → FAIL.

- [ ] **Step 3: Rework `renderDetailPanel` in `daemon/web/render.js`.** Replace the whole function with the version below. It keeps the metadata/links/wrapper identical and only changes the message-list section: flat for findings, sender-grouped for `handled`/`triage`.

```js
export function renderDetailPanel(item, nowMs = Date.now(), opts = {}) {
  if (!item) return "";
  const d = item.display || {};
  const g = item.group || {};
  const confirm = opts.confirm || null;
  const acted = opts.acted || {};
  const statusLabel = item.status === "at_risk" ? "at risk" : (item.acknowledged ? "acknowledged" : "ok");
  const rows = [
    ["Inbox", d.accountLabel || item.account],
    ["Root cause", g.rootCause || ""],
    ["Status", statusLabel],
  ];
  if (g.merchant) rows.push(["Merchant", g.merchant]);
  if (g.gwId) rows.push(["Gateway ID", g.gwId]);
  if (g.severity) rows.push(["Severity", g.severity]);
  const meta = rows.map(([k, v]) =>
    `<div class="drow"><span class="dk">${esc(k)}</span><span class="dv">${esc(v)}</span></div>`).join("");

  const members = (g.members || []).slice()
    .sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
  const autoBodies = members.length <= 5;
  const clustered = item.jobType === "handled" || item.jobType === "triage";

  // A single message's body region (auto-load vs click-to-expand) + acted/undo or buttons.
  const bodyRegionFor = (m) => m.emailId
    ? (autoBodies
        ? `<div class="msgbody" data-body-for="${esc(m.emailId)}"><span class="bodyload">Loading…</span></div>`
        : `<button class="showbody" data-loadbody="${esc(m.emailId)}">Show message</button><div class="msgbody" data-body-for="${esc(m.emailId)}" hidden></div>`)
    : "";

  let msgs;
  if (clustered) {
    const groups = new Map();
    for (const m of members) {
      const from = (m.from || "").toLowerCase();
      const key = from || "__unknown__";
      if (!groups.has(key)) groups.set(key, { from, label: m.fromName || m.from || "(unknown sender)", members: [] });
      groups.get(key).members.push(m);
    }
    const ordered = [...groups.values()].sort((a, b) => b.members.length - a.members.length);
    msgs = ordered.map(grp => {
      const ids = grp.members.map(m => m.emailId).filter(Boolean).join(",");
      const senderKey = (grp.from || "unknown").replace(/[^a-z0-9._@-]/gi, "_");
      const delAll = confirmBtn({ cls: "del", attr: "data-delete", value: item.account, extra: ` data-ids="${esc(ids)}"`, token: `del:cluster:${item.account}:${senderKey}`, verb: "delete all", confirm, disabled: !ids });
      const killAll = confirmBtn({ cls: "kill", attr: "data-killlist", value: item.account, extra: ` data-ids="${esc(ids)}" data-sender="${esc(grp.from || "")}"`, token: `kill:cluster:${item.account}:${senderKey}`, verb: "kill list", confirm, disabled: !grp.from });
      const dkAll = confirmBtn({ cls: "delkill", attr: "data-delkill", value: item.account, extra: ` data-ids="${esc(ids)}" data-sender="${esc(grp.from || "")}"`, token: `delkill:cluster:${item.account}:${senderKey}`, verb: "Delete and Kill", confirm, disabled: !ids || !grp.from });
      const rowsHtml = grp.members.map(m => {
        const ma = acted[m.emailId];
        const when = relativeTime(m.receivedAt, nowMs);
        const tag = ma ? `<div class="msgactions"><span class="actedtag">${esc(actedBadge(ma))}</span><button class="undo" data-undo-acted="${esc(m.emailId)}">Undo</button></div>` : "";
        return `<div class="msg${ma ? " acted" : ""}"><div class="msgsub">${esc(m.subject || "(no subject)")}</div>`
          + `<div class="msgmeta">${esc(when)}</div>${tag}${bodyRegionFor(m)}</div>`;
      }).join("");
      return `<div class="sendergrp"><div class="sghdr"><span class="sgname">${esc(grp.label)} (${grp.members.length})</span>`
        + `<span class="sgactions">${delAll}${killAll}${dkAll}</span></div>${rowsHtml}</div>`;
    }).join("");
  } else {
    msgs = members.map(m => {
      const who = m.fromName || m.from || m.vendor || "";
      const when = relativeTime(m.receivedAt, nowMs);
      const ma = acted[m.emailId];
      const rowDel = m.emailId ? confirmBtn({ cls: "del", attr: "data-delete", value: item.account, extra: ` data-ids="${esc(m.emailId)}"`, token: `del:msg:${m.emailId}`, verb: "delete", confirm }) : "";
      const rowKill = m.from ? confirmBtn({ cls: "kill", attr: "data-killlist", value: item.account, extra: ` data-sender="${esc(m.from)}"`, token: `kill:msg:${m.emailId || m.from}`, verb: "kill list", confirm }) : "";
      const rowDelkill = (m.emailId && m.from) ? confirmBtn({ cls: "delkill", attr: "data-delkill", value: item.account, extra: ` data-ids="${esc(m.emailId)}" data-sender="${esc(m.from)}"`, token: `delkill:msg:${m.emailId}`, verb: "Delete and Kill", confirm }) : "";
      const rowActions = ma
        ? `<span class="actedtag">${esc(actedBadge(ma))}</span><button class="undo" data-undo-acted="${esc(m.emailId)}">Undo</button>`
        : `${rowDel}${rowKill}${rowDelkill}`;
      return `<div class="msg${ma ? " acted" : ""}"><div class="msgsub">${esc(m.subject || "(no subject)")}</div>`
        + `<div class="msgmeta">${esc(who)}${who && when ? " · " : ""}${esc(when)}</div>`
        + `<div class="msgactions">${rowActions}</div>${bodyRegionFor(m)}</div>`;
    }).join("");
  }
  const moreNote = g.moreCount > 0 ? `<div class="dmore">+ ${esc(g.moreCount)} more not shown</div>` : "";

  const links = (item.source || [])
    .filter(s => s.kind === "url" && safeUrl(s.url))
    .map(s => `<a class="route" target="_blank" rel="noopener" href="${esc(s.url)}">↗ Open in system of record</a>`)
    .join("");

  return `<div class="backdrop" data-detail-close></div>`
    + `<aside class="detail" role="dialog" aria-label="Item detail">`
    + `<button class="detail-close" data-detail-close aria-label="Close">✕</button>`
    + `<div class="dtitle">${esc(item.title)}</div>`
    + `<div class="dmeta">${meta}</div>`
    + `<div class="dmsgs-h">Messages</div><div class="dmsgs">${msgs}</div>${moreNote}`
    + `${links ? `<div class="dlinks">${links}</div>` : ""}`
    + `</aside>`;
}
```

- [ ] **Step 4: styles** — append to `daemon/web/styles.css`:

```css
.sendergrp { margin:10px 0; border-top:1px solid var(--line); padding-top:8px; }
.sghdr { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.sghdr .sgname { font-weight:600; }
.sghdr .sgactions { margin-left:auto; display:flex; gap:6px; }
.sendergrp .msg { padding:6px 0 6px 12px; border-top:none; }
```

- [ ] **Step 5:** `node --test daemon/web/render.test.js` → PASS (the existing renderDetailPanel tests use `gateway`/non-handled items → still flat → unchanged).

- [ ] **Step 6: Commit.**

```bash
git add daemon/web/render.js daemon/web/styles.css daemon/web/render.test.js
git commit -m "feat(panel): sender-clustered drill-in for handled/triage with per-cluster bulk actions"
```

---

## Task 3: B (app) — cluster handlers mark per-member acted

**Files:** Modify `daemon/web/app.js`; Test `daemon/web/contract.test.js`.

The existing `[data-delete]`/`[data-killlist]`/`[data-delkill]` handlers set `ui.acted[key]` where `key = token.split(":").slice(2).join(":")`. For cluster tokens (`*:cluster:<account>:<senderKey>`) that key is not an emailId, so the rows wouldn't dim. Fix: when the token is a cluster action, mark **each member emailId** acted instead.

- [ ] **Step 1: contract test.** In `daemon/web/contract.test.js`, add:

```js
  it("app marks per-member acted for cluster actions", () => {
    assert.match(app, /:cluster:/, "app must recognize cluster tokens");
  });
```

- [ ] **Step 2:** `node --test daemon/web/contract.test.js` → FAIL.

- [ ] **Step 3:** In `daemon/web/app.js`, add a helper after `confirmThen` (or near the top of the handlers):

```js
// Record an acted result. Cluster tokens (*:cluster:*) mark every member emailId
// so each row dims; tile/msg tokens key by their single id as before.
function markActed(token, key, ids, patch) {
  if (token.includes(":cluster:")) {
    for (const id of ids) ui.acted[id] = { ...(ui.acted[id] || {}), ...patch, account: patch.account, emailIds: [id] };
  } else {
    ui.acted[key] = { ...(ui.acted[key] || {}), ...patch };
  }
}
```

Update the three handlers to use it. **Delete** handler — replace its `go` body so the acted recording is:

```js
  const del = e.target.closest("[data-delete]");
  if (del) {
    const token = del.dataset.token, account = del.dataset.delete, ids = (del.dataset.ids || "").split(",").filter(Boolean);
    const key = token.split(":").slice(2).join(":");
    return void confirmThen(token, async () => { ui.undo = null; ui.notice = null; const r = await postJson("/messages/delete", { account, emailIds: ids }); if (r.ok !== false) markActed(token, key, ids, { deleted: true, account, emailIds: ids }); ui.notice = r.ok === false ? `Delete failed: ${r.error}` : `Moved ${r.trashed} to Trash`; await load(); });
  }
```

**Kill** handler — cluster kill carries `data-ids` (the group's members) so we can dim them:

```js
  const kill = e.target.closest("[data-killlist]");
  if (kill) {
    const token = kill.dataset.token, account = kill.dataset.killlist, sender = kill.dataset.sender, ids = (kill.dataset.ids || "").split(",").filter(Boolean);
    const key = token.split(":").slice(2).join(":");
    return void confirmThen(token, async () => { ui.undo = null; ui.notice = null; const r = await postJson("/senders/killlist", { account, sender }); if (r.added) markActed(token, key, ids, { killed: true, account, sender }); ui.notice = r.added ? `Kill-listed ${sender}` : `Not kill-listed: ${r.reason || r.error}`; await load(); });
  }
```

**Delete-and-Kill** handler:

```js
  const dk = e.target.closest("[data-delkill]");
  if (dk) {
    const token = dk.dataset.token, account = dk.dataset.delkill, ids = (dk.dataset.ids || "").split(",").filter(Boolean), sender = dk.dataset.sender;
    const key = token.split(":").slice(2).join(":");
    return void confirmThen(token, async () => {
      ui.undo = null; ui.notice = null;
      const dr = await postJson("/messages/delete", { account, emailIds: ids });
      const kr = await postJson("/senders/killlist", { account, sender });
      const deleted = dr.ok !== false, killed = !!kr.added;
      if (deleted || killed) markActed(token, key, ids, { deleted, killed, account, emailIds: ids, sender });
      ui.notice = `Deleted ${dr.trashed ?? 0} · ${kr.added ? "kill-listed" : "kill-list: " + (kr.reason || kr.error)}`;
      await load();
    });
  }
```

(The `markActed` per-member branch sets `emailIds: [id]` for each so a row's Undo restores just that email; for `killed`, it stores `sender` via the patch.)

Note: for the cluster **kill** patch, `markActed`'s per-member entry must keep `sender` — adjust the per-member spread to include the full patch (it does: `...patch` carries `sender`/`account`), and `emailIds:[id]` overrides only that field. Confirm the per-member entry has `{killed, account, sender, emailIds:[id]}` so undo-acted can call killlist-remove with `sender` and restore with `emailIds`.

- [ ] **Step 4:** `node --test "daemon/web/**/*.test.js"` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add daemon/web/app.js daemon/web/contract.test.js
git commit -m "feat(panel): cluster bulk actions mark each member acted (per-row dim + undo)"
```

---

## Task 4: Full suite + manual smoke

- [ ] **Step 1:** `npm test` → green, above baseline.
- [ ] **Step 2 (operator):** Restart the daemon. The Brickell Pay handled tile headline should now be a small "N need a reply or decision" with a large "+ N informational". Open its Details → messages grouped by sender ("Brickell Pay (33)", …); a sender header's **Delete all** (two-click) dims every row in that group with Undo; **Kill list** kill-lists the sender; **Delete and kill** does both. Finding tiles still show flat per-row buttons.

---

## Self-Review

**Spec coverage:** A (automated→informational, handled-local) → Task 1; B render clustering + per-cluster bulk → Task 2; B app per-member acted for clusters → Task 3; findings stay flat → Task 2 `else` branch + test; tests + smoke → Tasks 1–4. ✓
**Placeholders:** none — full code given. ✓
**Consistency:** cluster tokens `*:cluster:<account>:<senderKey>`; cluster Kill carries `data-ids` so `markActed` can dim members; `markActed` per-member entries carry `{deleted|killed, account, sender?, emailIds:[id]}` matching the existing `data-undo-acted` reverse logic (restore uses `emailIds`, killlist-remove uses `sender`). `looksAutomated(e.from, e.hasListUnsubscribe)` import path `../../scripts/sender-guards.js`. ✓
