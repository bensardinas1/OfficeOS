# Panel Bulk Actions + Conversation Drill-in (Cluster B2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select multiple tiles, sender-clusters, and conversations in the panel and bulk Delete / Kill / Delete-and-Kill / Undo them via a sticky footer bar; the handled drill-in groups human mail by provider conversation ID.

**Architecture:** `mail.js` maps a unified `conversationId`; the handled normalizer stamps `conversationId` + `automated` per member; a pure `groupHandledMembers` (view-model.js) splits the drill-in into Conversations vs Bulk senders; typed selection keys (`item:`/`cluster:`/`conv:`) feed a pure `resolveBulkPlan` (selection.js) whose ops the app executes sequentially against the existing guarded endpoints. Spec: `docs/superpowers/specs/2026-07-14-panel-bulk-actions-design.md`.

**Tech Stack:** Node 24 ESM, `node:test`, zero new dependencies, vanilla browser JS (no Node APIs in `daemon/web/`).

## Global Constraints

- **Soft-delete only:** all bulk deletes go through existing endpoints → `mail.js deleteEmails` (Outlook move→deleteditems / Gmail trash). No new mail-touching code paths anywhere in this plan.
- **Conversations and tiles delete by precise emailId list; ONLY sender-clusters use the (guarded, windowed, capped) `/senders/delete-all` query.**
- **No subject-based grouping in any action logic** — `conversationId`/`threadId` only; the `Re:/Fwd:` strip is display-only.
- Two-click confirm (existing `confirmBtn`/`confirmThen`) before any bulk mutation; `Working (k/n)…` disables the bar during a run; refusals/failures/skips are counted in the aggregate notice, never dropped.
- `daemon/web/` files are browser ES modules — no `node:` imports.
- Full suite (`npm test`, baseline 632) and `npm run test:e2e` (baseline 2) must stay green after every task.
- Commit after every task; conventional commits; body ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Never commit `.superpowers/` or `data/`.

---

## File map

| File | Task | Role |
|---|---|---|
| `scripts/mail.js` + `scripts/test/mail.test.js` | 1 | unified `conversationId` |
| `daemon/normalizers/handled.js` + test | 2 | member `conversationId` + `automated` |
| `daemon/web/view-model.js` + `view-model.test.js` | 3 | pure `groupHandledMembers` + `stripReplyPrefix` |
| `daemon/web/render.js` + `render.test.js` | 4, 5, 7 | two-section drill-in; kill `data-ids`; bulk bar + typed checkbox keys |
| `daemon/web/selection.js` + `selection.test.js` | 6 | typed keys, `resolveBulkPlan`, `pendingApprovalsFor` update |
| `daemon/web/app.js` + `contract.test.js` | 8 | bulk handlers + `runBulk` loop |
| `daemon/web/styles.css` | 7 | `.bulkbar`, `.convgrp` styles |
| `e2e/panel.smoke.spec.js` | 9 | conversation render + bulk delete/undo flows |
| `daemon/README.md` | 10 | docs |

Note: `daemon/web/view-model.test.js` and `daemon/web/selection.test.js` exist already (TC3 / workbench eras) — extend them; if a name differs, find with `ls daemon/web/*.test.js` and extend the matching file (create `selection.test.js` only if absent).

---

### Task 1: `conversationId` in the unified email shape

**Files:**
- Modify: `scripts/mail.js`
- Test: `scripts/test/mail.test.js`

**Interfaces:**
- Produces: every email returned by `fetchMail` carries `conversationId` — Outlook: Graph's `conversationId` (added to `OUTLOOK_SELECT` and `mapOutlookMessage`); Gmail: set from the message's existing `threadId` after `mapGmailMessage`. `null`/absent tolerated downstream.

- [ ] **Step 1: Failing tests.** In `scripts/test/mail.test.js`: add `conversationId: "conv-A"` to the `graphMsg(i)` fixture object, and in the outlook pagination test assert `emails[0].conversationId === "conv-A"`. The `gmailMeta(id)` fixture already returns `threadId: \`t-${id}\`` — in the gmail pagination test assert `emails.every(e => e.conversationId === e.threadId && e.conversationId)`.

- [ ] **Step 2: Verify fail** — `node --test scripts/test/mail.test.js`.

- [ ] **Step 3: Implement.** In `scripts/mail.js`:
1. `OUTLOOK_SELECT` gains `conversationId`: `"id,conversationId,subject,from,receivedDateTime,isRead,bodyPreview,importance,hasAttachments,internetMessageHeaders"`.
2. `mapOutlookMessage` adds `conversationId: msg.conversationId || null,` (place after `id`).
3. In `fetchMail`'s Gmail branch, after `e.fromName = e.fromName || e.from;` add `e.conversationId = e.threadId || null;`.

- [ ] **Step 4: Run** — `node --test scripts/test/mail.test.js` green; `npm test` green (632, counts unchanged — assertions extended, not added… if you added new `it` blocks the count grows; either is fine as long as all pass).

- [ ] **Step 5: Commit** — `feat(mail): unified conversationId (Outlook conversationId / Gmail threadId)`.

---

### Task 2: handled members carry `conversationId` + `automated`

**Files:**
- Modify: `daemon/normalizers/handled.js`
- Test: `daemon/normalizers/handled.test.js`

**Interfaces:**
- Produces: each member gains `conversationId` (pass-through, `null` when absent) and `automated` (boolean — `looksAutomated(e.from, e.hasListUnsubscribe)`, computed for EVERY member regardless of category; the counts logic is unchanged).

- [ ] **Step 1: Failing test.** Add to `daemon/normalizers/handled.test.js`:

```js
  it("stamps conversationId and automated on every member", () => {
    const classified = { categories: {
      action: { emails: [ { id: "h1", from: "wayne@brickellpay.com", subject: "decision?", receivedAt: "2026-06-20T00:00:00Z", conversationId: "cv-9" } ] },
      fyi:    { emails: [ { id: "n1", from: "noreply@brickellpay.com", subject: "alert", receivedAt: "2026-06-20T00:00:00Z", hasListUnsubscribe: true } ] },
    } };
    const it0 = normalizeHandled(classified, account, typeConfig)[0];
    const h = it0.group.members.find(m => m.emailId === "h1");
    const n = it0.group.members.find(m => m.emailId === "n1");
    assert.equal(h.conversationId, "cv-9");
    assert.equal(h.automated, false);
    assert.equal(n.conversationId, null);
    assert.equal(n.automated, true);
  });
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement.** In `normalizeHandled`, change the member push to:

```js
    for (const e of emails) all.push({
      subject: e.subject, from: e.from, fromName: e.fromName,
      receivedAt: e.receivedAt || e.received, emailId: e.id,
      conversationId: e.conversationId || null,
      automated: looksAutomated(e.from, e.hasListUnsubscribe),
    });
```

(Counts loop untouched.)

- [ ] **Step 4: Run** — `node --test daemon/normalizers/handled.test.js`; `npm test` green.

- [ ] **Step 5: Commit** — `feat(handled): members carry conversationId + automated verdict`.

---

### Task 3: `groupHandledMembers` (pure)

**Files:**
- Modify: `daemon/web/view-model.js`
- Test: `daemon/web/view-model.test.js`

**Interfaces:**
- Produces:
  - `stripReplyPrefix(s)` — removes leading `Re:`/`Fw:`/`Fwd:` chains (display-only helper).
  - `groupHandledMembers(members) -> { conversations, senders }` where each conversation = `{ key, label, latestAt, senderCount, members[] }` (members oldest-first; groups newest-activity-first; key = `conversationId` or `msg:<emailId>` singleton fallback) and each sender group = `{ from, label, members[] }` (largest-first — same ordering as today's cluster view). Routing: `automated === false` → conversations; `automated === true` OR missing (stale model) → senders.

- [ ] **Step 1: Failing tests.** Append to `daemon/web/view-model.test.js`:

```js
import { groupHandledMembers, stripReplyPrefix } from "./view-model.js";

describe("stripReplyPrefix", () => {
  it("strips stacked Re:/Fwd:/Fw: prefixes, case-insensitive", () => {
    assert.equal(stripReplyPrefix("RE: Fwd: re: Path Peptides underwriting"), "Path Peptides underwriting");
    assert.equal(stripReplyPrefix("Regular subject"), "Regular subject");
    assert.equal(stripReplyPrefix(""), "");
  });
});

describe("groupHandledMembers", () => {
  const m = (id, from, conv, automated, at, subject) =>
    ({ emailId: id, from, fromName: from, conversationId: conv, automated, receivedAt: at, subject });

  it("routes human mail to conversations grouped by conversationId, automated to sender groups", () => {
    const members = [
      m("e1", "luis@brickellpay.com", "cv-1", false, "2026-07-01T00:00:00Z", "Path Peptides underwriting"),
      m("e2", "mckenna@partner.com", "cv-1", false, "2026-07-02T00:00:00Z", "RE: Path Peptides underwriting"),
      m("e3", "noise@wp.com", null, true, "2026-07-03T00:00:00Z", "New order #1"),
      m("e4", "noise@wp.com", null, true, "2026-07-04T00:00:00Z", "New order #2"),
    ];
    const g = groupHandledMembers(members);
    assert.equal(g.conversations.length, 1);
    assert.equal(g.conversations[0].key, "cv-1");
    assert.equal(g.conversations[0].label, "Path Peptides underwriting"); // latest subject, prefix stripped
    assert.equal(g.conversations[0].senderCount, 2);
    assert.deepEqual(g.conversations[0].members.map(x => x.emailId), ["e1", "e2"]); // oldest-first
    assert.equal(g.senders.length, 1);
    assert.equal(g.senders[0].members.length, 2);
  });

  it("orders conversations newest-activity-first and falls back to singleton groups", () => {
    const members = [
      m("a1", "x@y.com", null, false, "2026-07-01T00:00:00Z", "Solo one"),   // no convId → singleton
      m("b1", "z@y.com", "cv-2", false, "2026-07-05T00:00:00Z", "Newer thread"),
    ];
    const g = groupHandledMembers(members);
    assert.deepEqual(g.conversations.map(c => c.key), ["cv-2", "msg:a1"]);
  });

  it("members missing the automated field fall back to sender groups (stale model)", () => {
    const legacy = { emailId: "l1", from: "who@y.com", subject: "old", receivedAt: "2026-07-01T00:00:00Z" };
    const g = groupHandledMembers([legacy]);
    assert.equal(g.conversations.length, 0);
    assert.equal(g.senders.length, 1);
  });

  it("handles empty/missing input", () => {
    assert.deepEqual(groupHandledMembers([]), { conversations: [], senders: [] });
    assert.deepEqual(groupHandledMembers(undefined), { conversations: [], senders: [] });
  });
});
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement** (append to `daemon/web/view-model.js`):

```js
/** Display-only: strip stacked Re:/Fw:/Fwd: prefixes from a subject. */
export function stripReplyPrefix(s) {
  return String(s || "").replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim();
}

/**
 * Split a handled tile's members for the two-section drill-in. Human mail
 * (automated === false) groups by provider conversationId (singleton fallback
 * per message); automated OR legacy members (no `automated` field) keep the
 * sender-cluster view. No subject heuristics — labels are display-only.
 */
export function groupHandledMembers(members) {
  const convs = new Map();
  const senders = new Map();
  for (const m of members || []) {
    if (m.automated === false) {
      const key = m.conversationId || `msg:${m.emailId}`;
      if (!convs.has(key)) convs.set(key, []);
      convs.get(key).push(m);
    } else {
      const from = (m.from || "").toLowerCase() || "__unknown__";
      if (!senders.has(from)) senders.set(from, { from: m.from || "", label: m.fromName || m.from || "(unknown sender)", members: [] });
      senders.get(from).members.push(m);
    }
  }
  const conversations = [...convs.entries()].map(([key, list]) => {
    const sorted = list.slice().sort((a, b) => String(a.receivedAt || "").localeCompare(String(b.receivedAt || "")));
    const latest = sorted[sorted.length - 1];
    const senderCount = new Set(sorted.map(x => (x.from || "").toLowerCase()).filter(Boolean)).size;
    return { key, label: stripReplyPrefix(latest.subject) || "(no subject)", latestAt: latest.receivedAt || "", senderCount, members: sorted };
  }).sort((a, b) => String(b.latestAt).localeCompare(String(a.latestAt)));
  return { conversations, senders: [...senders.values()].sort((a, b) => b.members.length - a.members.length) };
}
```

- [ ] **Step 4: Run** — view-model tests + `npm test` green.

- [ ] **Step 5: Commit** — `feat(panel): pure groupHandledMembers — conversations vs bulk senders`.

---

### Task 4: Two-section drill-in for handled tiles

**Files:**
- Modify: `daemon/web/render.js`
- Test: `daemon/web/render.test.js`

**Interfaces:**
- Consumes: `groupHandledMembers`/`stripReplyPrefix` from `./view-model.js` (render.js may import view-model — both are browser modules; contract test note: keep render.js free of DOM/node APIs as before).
- Produces: for `jobType === "handled"`, the detail pane renders a `Conversations` section (`.convgrp` blocks with header checkbox `data-select="conv:<account>:<key>"`, `.cgname` label, `.cgmeta` `N messages · M senders`) followed by the existing sender-cluster section under a `Bulk senders` heading (each `.sghdr` gains checkbox `data-select="cluster:<account>:<senderEmail>"`). `triage` keeps today's single clustered view (with the new cluster checkboxes too — same code path). Either section omitted when empty. Row rendering (acted tags, bodies, per-row undo) identical in both sections.

- [ ] **Step 1: Failing tests.** Add to the "sender-clustered detail" describe in `daemon/web/render.test.js` (reuse its `handled` fixture, extending members):

```js
  const convHandled = {
    id: "brickellpay:handled", account: "brickellpay", jobType: "handled", title: "T", status: "ok",
    display: { accountLabel: "Brickell Pay" },
    group: { rootCause: "handled", members: [
      { subject: "Path Peptides underwriting", from: "luis@brickellpay.com", fromName: "Luis", emailId: "c1", receivedAt: "2026-07-01T00:00:00Z", conversationId: "cv-1", automated: false },
      { subject: "RE: Path Peptides underwriting", from: "mckenna@partner.com", fromName: "McKenna", emailId: "c2", receivedAt: "2026-07-02T00:00:00Z", conversationId: "cv-1", automated: false },
      { subject: "New order #1", from: "noise@wp.com", fromName: "WP", emailId: "n1", receivedAt: "2026-07-03T00:00:00Z", conversationId: null, automated: true },
    ] },
    source: [], proposals: [],
  };
  it("renders handled drill-in as Conversations + Bulk senders with typed checkboxes", () => {
    const html = renderDetailPanel(convHandled, 0);
    assert.match(html, /Conversations/);
    assert.match(html, /Bulk senders/);
    assert.match(html, /data-select="conv:brickellpay:cv-1"/);
    assert.match(html, /Path Peptides underwriting/);
    assert.match(html, /2 messages · 2 senders/);
    assert.match(html, /data-select="cluster:brickellpay:noise@wp.com"/);
    // conversation rows keep sender attribution and appear once (not scattered into clusters)
    assert.doesNotMatch(html, /data-select="cluster:brickellpay:luis@brickellpay.com"/);
  });
  it("omits the Conversations section when all members are automated", () => {
    const noisy = { ...convHandled, group: { ...convHandled.group, members: convHandled.group.members.filter(m => m.automated) } };
    const html = renderDetailPanel(noisy, 0);
    assert.doesNotMatch(html, /Conversations/);
    assert.match(html, /Bulk senders/);
  });
  it("triage tiles keep clusters only, now with cluster checkboxes", () => {
    const tri = { ...convHandled, id: "x:triage", jobType: "triage" };
    const html = renderDetailPanel(tri, 0);
    assert.doesNotMatch(html, /Conversations/);
    assert.match(html, /data-select="cluster:brickellpay:/);
  });
```

Also update any existing sender-cluster tests that assert exact `.sghdr` markup if the checkbox insertion breaks their regexes (loosen to `match` on the essential attrs — do not delete assertions).

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement in `render.js`.**
1. `import { groupHandledMembers } from "./view-model.js";` at top.
2. Extract the per-row builder used by the clustered branch into a local `const msgRow = (m, { withWho = false } = {}) => {...}` (the existing `rowsHtml` body; when `withWho` is true prepend `${esc(m.fromName || m.from || "")} · ` to the `msgmeta` line — conversation rows need sender attribution).
3. Extract today's sender-cluster block into `const senderClusterHtml = (grpList) => grpList.map(grp => {...existing code, plus checkbox...}).join("")` where the `.sghdr` opens with `<label class="sgsel"><input type="checkbox" data-select="cluster:${esc(item.account)}:${esc(grp.from || "")}"></label>` before `.sgname`. It takes the grouped list in today's `{from, label, members}` shape.
4. Branch:

```js
  if (clustered) {
    const buildSenderGroups = (list) => { /* today's Map-based grouping over `list`, returning ordered [{from,label,members}] */ };
    if (item.jobType === "handled") {
      const g = groupHandledMembers(rawMembers);
      const convHtml = g.conversations.map(c => {
        const rows = c.members.map(m => msgRow(m, { withWho: true })).join("");
        return `<div class="convgrp"><div class="cghdr">`
          + `<label class="cgsel"><input type="checkbox" data-select="conv:${esc(item.account)}:${esc(c.key)}"></label>`
          + `<span class="cgname">${esc(c.label)}</span>`
          + `<span class="cgmeta">${c.members.length} message${c.members.length === 1 ? "" : "s"} · ${c.senderCount} sender${c.senderCount === 1 ? "" : "s"}</span>`
          + `</div>${rows}</div>`;
      }).join("");
      const senderHtml = senderClusterHtml(g.senders);
      msgs = `${convHtml ? `<div class="dsec-h">Conversations</div>${convHtml}` : ""}`
           + `${senderHtml ? `<div class="dsec-h">Bulk senders</div>${senderHtml}` : ""}`;
    } else {
      msgs = senderClusterHtml(buildSenderGroups(rawMembers));
    }
  } else { /* unchanged flat branch */ }
```

(`buildSenderGroups` is today's grouping loop lifted out so both paths share it; `g.senders` from groupHandledMembers is already in that shape.)

- [ ] **Step 4: Run** — `node --test daemon/web/render.test.js`; `npm test`; `npm run test:e2e` (e2e seeds automated-less members → they fall back to the senders section; the existing cluster selectors still resolve).

- [ ] **Step 5: Commit** — `feat(panel): conversation-grouped drill-in for handled tiles`.

---

### Task 5: Kill buttons gain `data-ids` (B1 leftover)

**Files:**
- Modify: `daemon/web/render.js`
- Test: `daemon/web/render.test.js`

**Interfaces:**
- Produces: tile-level `killBtn` (renderItemCard) and per-msg `rowKill` (flat detail branch) carry ` data-ids="<memberIds>"` / ` data-ids="<emailId>"` — the app.js killlist handler already reads `data-ids` and sends `emailIds`, so kill acted-state becomes server-derivable.

- [ ] **Step 1: Failing tests.** In the "acted state + delete-and-kill" describe: assert the card's kill button carries the ids — `assert.match(renderItemCard(gw, 0), /data-killlist="brickell"[^>]*data-ids="e1"/);` and in the flat detail describe assert `assert.match(renderDetailPanel(gw, 0), /data-killlist="brickell"[^>]*data-ids="e1"/);` (adjust to the fixtures' actual member ids — read them first).

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement.** `renderItemCard`'s `killBtn`: `extra` becomes `` ` data-ids="${esc(ids)}" data-sender="${esc(senders[0] || "")}"` ``. Flat-branch `rowKill`: `extra` becomes `` ` data-ids="${esc(m.emailId || "")}" data-sender="${esc(m.from)}"` ``.

- [ ] **Step 4: Run** — render tests + `npm test` green.

- [ ] **Step 5: Commit** — `fix(panel): tile and per-msg kill buttons carry data-ids (server-derivable kill state)`.

---

### Task 6: Typed keys + `resolveBulkPlan`

**Files:**
- Modify: `daemon/web/selection.js`
- Test: `daemon/web/selection.test.js` (extend; create if absent)

**Interfaces:**
- Consumes: view shape (`view.groups[].items[]`, members with `emailId/from/conversationId/automated`), acted map values (`{deleted?, killed?, account, emailIds, sender?, deleteEntryId?, killEntryId?}`).
- Produces:
  - `pendingApprovalsFor(items, selectedKeys)` now matches `item:`-prefixed keys.
  - `resolveBulkPlan(action, selectedKeys, view, acted = {}) -> { ops, skips }` with op kinds exactly: `approve {proposalId}`, `delete {account, emailIds, unit: "tile"|"conversation", label}`, `deleteBySender {account, sender, optimisticIds, label}`, `kill {account, sender, emailIds, label}`, `restore {account, emailIds, undoOf, label}`, `killRemove {account, sender, undoOf, label}`; skips are `{label, reason}`.

- [ ] **Step 1: Failing tests.** Create/extend `daemon/web/selection.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toggle, pendingApprovalsFor, resolveBulkPlan } from "./selection.js";

const mem = (id, from, conv, automated) => ({ emailId: id, from, fromName: from, conversationId: conv, automated, receivedAt: "2026-07-01T00:00:00Z", subject: id });
const view = { groups: [ { account: "b", items: [
  { id: "b:handled", account: "b", jobType: "handled", proposals: [], group: { members: [
    mem("c1", "luis@x.com", "cv-1", false), mem("c2", "mck@y.com", "cv-1", false),
    mem("n1", "noise@wp.com", null, true), mem("n2", "noise@wp.com", null, true),
  ] } },
  { id: "b:gw", account: "b", jobType: "gateway", proposals: [{ id: "p1", state: "pending" }], group: { members: [ mem("g1", "support@nmi.com", "cv-9", false) ] } },
] } ] };

describe("pendingApprovalsFor (typed keys)", () => {
  it("matches item:-prefixed keys only", () => {
    const items = view.groups[0].items;
    assert.deepEqual(pendingApprovalsFor(items, new Set(["item:b:gw"])), ["p1"]);
    assert.deepEqual(pendingApprovalsFor(items, new Set(["b:gw"])), []); // unprefixed no longer matches
  });
});

describe("resolveBulkPlan", () => {
  it("delete: tile → id-list; cluster → sender query; conv → id-list", () => {
    const sel = new Set(["item:b:gw", "cluster:b:noise@wp.com", "conv:b:cv-1"]);
    const plan = resolveBulkPlan("delete", sel, view);
    const kinds = plan.ops.map(o => o.kind).sort();
    assert.deepEqual(kinds, ["delete", "delete", "deleteBySender"]);
    const conv = plan.ops.find(o => o.unit === "conversation");
    assert.deepEqual(conv.emailIds.sort(), ["c1", "c2"]);
    const bySender = plan.ops.find(o => o.kind === "deleteBySender");
    assert.equal(bySender.sender, "noise@wp.com");
    assert.deepEqual(bySender.optimisticIds.sort(), ["n1", "n2"]);
  });

  it("dedupe: a tile's ids covered by a selected cluster drop out (skip when emptied)", () => {
    const v = { groups: [ { account: "b", items: [
      { id: "b:t", account: "b", jobType: "gateway", proposals: [], group: { members: [ mem("x1", "noise@wp.com", null, true) ] } },
    ] } ] };
    const plan = resolveBulkPlan("delete", new Set(["item:b:t", "cluster:b:noise@wp.com"]), v);
    assert.equal(plan.ops.filter(o => o.kind === "delete").length, 0);
    assert.equal(plan.ops.filter(o => o.kind === "deleteBySender").length, 1);
    assert.equal(plan.skips.length, 1);
    assert.match(plan.skips[0].reason, /covered/i);
  });

  it("delete skips fully-acted units with 'already deleted'", () => {
    const acted = { g1: { deleted: true, account: "b", emailIds: ["g1"], deleteEntryId: "d1" } };
    const plan = resolveBulkPlan("delete", new Set(["item:b:gw"]), view, acted);
    assert.equal(plan.ops.length, 0);
    assert.match(plan.skips[0].reason, /already deleted/i);
  });

  it("kill: clusters resolve; multi-sender conversations skip; single-sender tiles resolve; dedupes by account+sender", () => {
    const sel = new Set(["cluster:b:noise@wp.com", "conv:b:cv-1", "item:b:gw"]);
    const plan = resolveBulkPlan("kill", sel, view);
    assert.deepEqual(plan.ops.map(o => o.sender).sort(), ["noise@wp.com", "support@nmi.com"]);
    assert.equal(plan.skips.length, 1);
    assert.match(plan.skips[0].reason, /multiple senders/i);
    const wp = plan.ops.find(o => o.sender === "noise@wp.com");
    assert.deepEqual(wp.emailIds.sort(), ["n1", "n2"]);
  });

  it("delkill = delete ops then kill ops", () => {
    const plan = resolveBulkPlan("delkill", new Set(["cluster:b:noise@wp.com"]), view);
    assert.deepEqual(plan.ops.map(o => o.kind), ["deleteBySender", "kill"]);
  });

  it("undo: collects acted entries under selected units, deduped by entry id", () => {
    const acted = {
      c1: { deleted: true, account: "b", emailIds: ["c1"], deleteEntryId: "d9" },
      c2: { deleted: true, killed: true, account: "b", emailIds: ["c2"], deleteEntryId: "d9", sender: "mck@y.com", killEntryId: "k3" },
    };
    const plan = resolveBulkPlan("undo", new Set(["conv:b:cv-1"]), view, acted);
    const restore = plan.ops.find(o => o.kind === "restore");
    assert.equal(restore.undoOf, "d9");
    assert.deepEqual(restore.emailIds.sort(), ["c1", "c2"]); // one op for the shared entry
    const kr = plan.ops.find(o => o.kind === "killRemove");
    assert.deepEqual([kr.sender, kr.undoOf], ["mck@y.com", "k3"]);
  });

  it("undo skips units with nothing acted; approve resolves pending proposals of item keys", () => {
    const p1 = resolveBulkPlan("undo", new Set(["item:b:gw"]), view, {});
    assert.equal(p1.ops.length, 0);
    assert.equal(p1.skips.length, 1);
    const p2 = resolveBulkPlan("approve", new Set(["item:b:gw", "conv:b:cv-1"]), view, {});
    assert.deepEqual(p2.ops, [{ kind: "approve", proposalId: "p1" }]);
  });
});
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement** in `daemon/web/selection.js` (keep `toggle`; update `pendingApprovalsFor` to `selectedKeys.has(\`item:${i.id}\`)`):

```js
/**
 * resolveBulkPlan — pure: (action, typed selection, view, acted) -> {ops, skips}.
 * Units: item:<itemId> (tile — precise member ids), cluster:<account>:<sender>
 * (intent-level sender query), conv:<account>:<conversationKey> (precise ids).
 * Tiles/conversations NEVER become sender queries; only clusters do.
 */
export function resolveBulkPlan(action, selectedKeys, view, acted = {}) {
  const ops = [];
  const skips = [];
  const items = (view.groups || []).flatMap(g => g.items || []);
  const itemById = new Map(items.map(i => [i.id, i]));

  // Parse selection into units.
  const units = [];
  for (const k of selectedKeys) {
    if (k.startsWith("item:")) {
      const it = itemById.get(k.slice(5));
      if (it) units.push({ type: "tile", key: k, account: it.account, label: it.title || it.id, members: it.group?.members || [], item: it });
    } else if (k.startsWith("cluster:")) {
      const [, account, ...rest] = k.split(":");
      const sender = rest.join(":");
      const members = items.filter(i => i.account === account && (i.jobType === "handled" || i.jobType === "triage"))
        .flatMap(i => i.group?.members || [])
        .filter(m => (m.from || "").toLowerCase() === sender.toLowerCase());
      units.push({ type: "cluster", key: k, account, sender, label: sender, members });
    } else if (k.startsWith("conv:")) {
      const [, account, ...rest] = k.split(":");
      const convKey = rest.join(":");
      const members = items.filter(i => i.account === account && i.jobType === "handled")
        .flatMap(i => i.group?.members || [])
        .filter(m => (m.conversationId || `msg:${m.emailId}`) === convKey);
      units.push({ type: "conversation", key: k, account, label: members[0]?.subject || convKey, members });
    }
  }

  const clusterCovered = new Set(); // `${account}|${lowercased sender}` for selected clusters
  for (const u of units) if (u.type === "cluster") clusterCovered.add(`${u.account}|${u.sender.toLowerCase()}`);
  const isCovered = (u, m) => clusterCovered.has(`${u.account}|${(m.from || "").toLowerCase()}`);
  const isDeleted = (m) => !!acted[m.emailId]?.deleted;

  if (action === "approve") {
    for (const u of units) {
      if (u.type !== "tile") continue;
      for (const p of (u.item.proposals || []).filter(p => p.state === "pending")) ops.push({ kind: "approve", proposalId: p.id });
    }
    return { ops, skips };
  }

  const wantDelete = action === "delete" || action === "delkill";
  const wantKill = action === "kill" || action === "delkill";

  if (wantDelete) {
    for (const u of units) {
      if (u.type === "cluster") {
        ops.push({ kind: "deleteBySender", account: u.account, sender: u.sender, optimisticIds: u.members.map(m => m.emailId).filter(Boolean), label: u.label });
        continue;
      }
      const live = u.members.filter(m => m.emailId && !isDeleted(m));
      if (live.length === 0) { skips.push({ label: u.label, reason: "already deleted" }); continue; }
      const ids = live.filter(m => !isCovered(u, m)).map(m => m.emailId);
      if (ids.length === 0) { skips.push({ label: u.label, reason: "covered by selected sender" }); continue; }
      ops.push({ kind: "delete", account: u.account, emailIds: ids, unit: u.type, label: u.label });
    }
  }

  if (wantKill) {
    const bySender = new Map(); // `${account}|${sender}` -> {account, sender, emailIds:Set, label}
    for (const u of units) {
      const senders = [...new Set(u.members.map(m => (m.from || "").toLowerCase()).filter(Boolean))];
      const sender = u.type === "cluster" ? u.sender.toLowerCase() : (senders.length === 1 ? senders[0] : null);
      if (!sender) { skips.push({ label: u.label, reason: senders.length ? "multiple senders" : "no resolvable sender" }); continue; }
      const key = `${u.account}|${sender}`;
      if (!bySender.has(key)) bySender.set(key, { account: u.account, sender, emailIds: new Set(), label: u.label });
      for (const m of u.members) if (m.emailId) bySender.get(key).emailIds.add(m.emailId);
    }
    for (const c of bySender.values()) ops.push({ kind: "kill", account: c.account, sender: c.sender, emailIds: [...c.emailIds], label: c.label });
  }

  if (action === "undo") {
    const restores = new Map();   // deleteEntryId -> {account, emailIds:Set}
    const killRemoves = new Map(); // killEntryId -> {account, sender}
    for (const u of units) {
      let found = 0;
      const entries = u.members.map(m => acted[m.emailId]).filter(Boolean);
      if (u.type === "tile" && acted[u.item?.id]) entries.push(acted[u.item.id]);
      for (const a of entries) {
        if (a.deleted && a.deleteEntryId) {
          if (!restores.has(a.deleteEntryId)) restores.set(a.deleteEntryId, { account: a.account, emailIds: new Set() });
          for (const id of a.emailIds || []) restores.get(a.deleteEntryId).emailIds.add(id);
          found++;
        }
        if (a.killed && a.killEntryId) { killRemoves.set(a.killEntryId, { account: a.account, sender: a.sender }); found++; }
      }
      if (!found) skips.push({ label: u.label, reason: "nothing to undo" });
    }
    for (const [undoOf, r] of restores) ops.push({ kind: "restore", account: r.account, emailIds: [...r.emailIds], undoOf, label: "restore" });
    for (const [undoOf, k] of killRemoves) ops.push({ kind: "killRemove", account: k.account, sender: k.sender, undoOf, label: k.sender });
  }

  return { ops, skips };
}
```

- [ ] **Step 4: Run** — `node --test daemon/web/selection.test.js`; `npm test` green (the bulk-approve path in app.js still compiles — its behavior updates in Task 8; the contract smoke may reference `pendingApprovalsFor`, run it).

- [ ] **Step 5: Commit** — `feat(panel): typed selection keys + pure resolveBulkPlan`.

---

### Task 7: Sticky bulk bar + typed card checkboxes + CSS

**Files:**
- Modify: `daemon/web/render.js`, `daemon/web/styles.css`
- Test: `daemon/web/render.test.js`

**Interfaces:**
- Produces: `renderBulkBar(selectedCount, ui = {})` REPLACES `renderSelectControls` (export removed; app.js updated in Task 8 — to keep the suite green mid-task, keep a deprecated `renderSelectControls = () => ""` export until Task 8 removes its import, OR do the app.js import swap in this task; choose the latter: swap the import + call in app.js here, leaving the rest of app.js untouched). Card checkboxes emit `data-select="item:<item.id>"`.
- Bar: hidden at 0 selected; normal state renders count + `✓ Approve` (`data-bulk-approve`, single-shot) + two-click `confirmBtn`s `data-bulk-delete` / `data-bulk-kill` / `data-bulk-delkill` / `data-bulk-undo` (tokens `bulk:delete|kill|delkill|undo`) + `Clear` (`data-bulk-clear`); while `ui.bulkBusy` is set it renders ONLY `Working (done/total)…`.

- [ ] **Step 1: Failing tests.**

```js
import { renderBulkBar } from "./render.js";

describe("renderBulkBar", () => {
  it("renders nothing at 0 selected", () => assert.equal(renderBulkBar(0), ""));
  it("renders count, action buttons, and Clear", () => {
    const html = renderBulkBar(3, {});
    assert.match(html, /3 selected/);
    for (const attr of ["data-bulk-approve", "data-bulk-delete", "data-bulk-kill", "data-bulk-delkill", "data-bulk-undo", "data-bulk-clear"]) assert.match(html, new RegExp(attr));
    assert.match(html, /data-token="bulk:delete"/);
  });
  it("shows armed confirm labels via the shared confirm machinery", () => {
    assert.match(renderBulkBar(2, { confirm: "bulk:delete" }), /Confirm delete\?/);
  });
  it("shows only progress while a bulk run is in flight", () => {
    const html = renderBulkBar(2, { bulkBusy: { done: 1, total: 4 } });
    assert.match(html, /Working \(1\/4\)/);
    assert.doesNotMatch(html, /data-bulk-delete/);
  });
});
```

Also: change the `renderItemCard` checkbox test expectations — the card's checkbox becomes `data-select="item:<id>"` (update the existing assertions that reference `data-select="<raw id>"` if any).

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement.**
1. `renderItemCard`: checkbox becomes `<input type="checkbox" data-select="item:${esc(item.id)}">`.
2. Replace `renderSelectControls` with:

```js
export function renderBulkBar(selectedCount, ui = {}) {
  if (!selectedCount) return "";
  if (ui.bulkBusy) return `<div class="bulkbar"><span class="bulkcount">Working (${esc(ui.bulkBusy.done)}/${esc(ui.bulkBusy.total)})…</span></div>`;
  const confirm = ui.confirm || null;
  const b = (attr, token, cls, verb) => confirmBtn({ cls, attr, value: "1", token, verb, confirm });
  return `<div class="bulkbar">`
    + `<span class="bulkcount">${esc(selectedCount)} selected</span>`
    + `<button class="bulk-approve" data-bulk-approve>✓ Approve</button>`
    + b("data-bulk-delete", "bulk:delete", "del", "delete")
    + b("data-bulk-kill", "bulk:kill", "kill", "kill list")
    + b("data-bulk-delkill", "bulk:delkill", "delkill", "Delete and Kill")
    + b("data-bulk-undo", "bulk:undo", "ack", "undo")
    + `<button class="bulk-clear" data-bulk-clear>Clear</button>`
    + `</div>`;
}
```

3. In `daemon/web/app.js` ONLY swap the import (`renderSelectControls` → `renderBulkBar`) and the draw() call: `+ renderBulkBar(selected.size, { confirm: ui.confirm, bulkBusy: ui.bulkBusy })` (add `bulkBusy: null` to the `ui` literal). Nothing else in app.js this task.
4. `styles.css`: replace the `.bulk`/`.bulk-approve` block with:

```css
.bulkbar { position:fixed; left:0; right:0; bottom:0; z-index:9; display:flex; gap:10px; align-items:center; padding:10px 16px; background:#111a2e; border-top:1px solid var(--line); box-shadow:0 -4px 16px rgba(0,0,0,.4); }
.bulkbar .bulkcount { color:var(--txt); font-size:13px; margin-right:6px; }
.bulk-approve { background:#1f3a2a; color:var(--ok); }
.bulk-clear { background:transparent; color:#8a94a6; }
.dsec-h { margin:14px 0 6px; color:#8a94a6; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
.convgrp { margin:10px 0; border-top:1px solid var(--line); padding-top:8px; }
.cghdr { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.cghdr .cgname { font-weight:600; }
.cghdr .cgmeta { margin-left:auto; color:#8a94a6; font-size:12px; }
.convgrp .msg { padding:6px 0 6px 12px; border-top:none; }
```

- [ ] **Step 4: Run** — render tests, `npm test`, `npm run test:e2e` (the smoke never uses the bulk bar yet; card checkbox key change doesn't affect it).

- [ ] **Step 5: Commit** — `feat(panel): sticky bulk bar + typed card selection keys`.

---

### Task 8: `runBulk` execution loop + handlers

**Files:**
- Modify: `daemon/web/app.js`
- Test: `daemon/web/contract.test.js`

**Interfaces:**
- Consumes: `resolveBulkPlan` (Task 6 shapes), `renderBulkBar` attrs (Task 7), endpoints: `/messages/delete`, `/senders/delete-all`, `/senders/killlist`, `/messages/restore`, `/senders/killlist/remove`, `/proposals/:id/approve`.
- Produces: `[data-bulk-delete|kill|delkill|undo]` handlers via `confirmThen(token, () => runBulk(action))`; `[data-bulk-clear]` empties selection; the old `[data-bulk-approve]` handler now routes through `resolveBulkPlan("approve", ...)`.

- [ ] **Step 1: Failing contract tests.** Add:

```js
  it("app wires the bulk bar to resolveBulkPlan and the endpoints", () => {
    assert.match(app, /resolveBulkPlan/, "app must import/use resolveBulkPlan");
    for (const attr of ["data-bulk-delete", "data-bulk-kill", "data-bulk-delkill", "data-bulk-undo", "data-bulk-clear"]) {
      assert.match(app, new RegExp(`\\[${attr}\\]`), `app must select [${attr}]`);
    }
    assert.match(app, /bulkBusy/, "app must drive the Working state");
  });
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement in `app.js`.**
1. Import: `import { toggle, pendingApprovalsFor, resolveBulkPlan } from "./selection.js";`
2. Add `runBulk` (below `markActed`):

```js
// Sequential bulk executor. Ops come from the pure resolveBulkPlan; every op's
// outcome is tallied — refusals, failures, and skips surface in one aggregate
// notice, and a thrown op aborts the remainder with a "stopped after k/n" note.
async function runBulk(action) {
  const view = toPanelView(lastModel);
  const plan = resolveBulkPlan(action, selected, view, ui.acted);
  ui.undo = null; ui.notice = null;
  if (plan.ops.length === 0) {
    ui.notice = plan.skips.length ? `Nothing to do · ${plan.skips.length} skipped (${plan.skips[0].reason})` : "Nothing to do";
    draw(); return;
  }
  ui.bulkBusy = { done: 0, total: plan.ops.length };
  draw();
  const t = { trashed: 0, senders: 0, tiles: 0, conversations: 0, killed: 0, restored: 0, unkilled: 0, refused: 0, failed: 0, approved: 0 };
  let aborted = null;
  for (const op of plan.ops) {
    try {
      if (op.kind === "delete") {
        const r = await postJson("/messages/delete", { account: op.account, emailIds: op.emailIds });
        if (r.ok === false) t.failed++;
        else {
          t.trashed += r.trashed || 0;
          t[op.unit === "conversation" ? "conversations" : "tiles"]++;
          for (const id of op.emailIds) ui.acted[id] = { deleted: true, account: op.account, emailIds: [id], deleteEntryId: r.entryId };
        }
      } else if (op.kind === "deleteBySender") {
        const r = await postJson("/senders/delete-all", { account: op.account, sender: op.sender });
        if (r.refused) t.refused++;
        else if (r.ok === false) t.failed++;
        else {
          t.trashed += r.trashed || 0; t.senders++;
          for (const id of op.optimisticIds) ui.acted[id] = { deleted: true, account: op.account, emailIds: [id], deleteEntryId: r.entryId };
        }
      } else if (op.kind === "kill") {
        const r = await postJson("/senders/killlist", { account: op.account, sender: op.sender, emailIds: op.emailIds });
        if (r.added) {
          t.killed++;
          for (const id of op.emailIds) ui.acted[id] = { ...(ui.acted[id] || {}), killed: true, account: op.account, emailIds: [id], sender: op.sender, killEntryId: r.entryId };
        } else t.refused++;
      } else if (op.kind === "restore") {
        const r = await postJson("/messages/restore", { account: op.account, emailIds: op.emailIds, undoOf: op.undoOf });
        if (r.ok === false) t.failed++;
        else { t.restored += r.restored || 0; for (const id of op.emailIds) delete ui.acted[id]; }
      } else if (op.kind === "killRemove") {
        const r = await postJson("/senders/killlist/remove", { account: op.account, sender: op.sender, undoOf: op.undoOf });
        if (r.ok === false || r.removed === false) t.failed++; else t.unkilled++;
      } else if (op.kind === "approve") {
        await fetch(`/proposals/${encodeURIComponent(op.proposalId)}/approve`, { method: "POST" });
        t.approved++;
      }
    } catch (err) { aborted = `stopped after ${ui.bulkBusy.done}/${ui.bulkBusy.total}: ${err?.message || err}`; break; }
    ui.bulkBusy.done++;
    draw();
  }
  const plural = (n, s) => `${n} ${s}${n === 1 ? "" : "s"}`;
  const parts = [];
  if (t.trashed) {
    const u = [];
    if (t.senders) u.push(plural(t.senders, "sender"));
    if (t.tiles) u.push(plural(t.tiles, "tile"));
    if (t.conversations) u.push(plural(t.conversations, "conversation"));
    parts.push(`Deleted ${t.trashed}${u.length ? ` (${u.join(", ")})` : ""}`);
  }
  if (t.killed) parts.push(`kill-listed ${t.killed}`);
  if (t.restored) parts.push(`restored ${t.restored}`);
  if (t.unkilled) parts.push(`un-kill-listed ${t.unkilled}`);
  if (t.approved) parts.push(`approved ${t.approved}`);
  if (t.refused) parts.push(`${t.refused} refused (protected)`);
  if (t.failed) parts.push(`${t.failed} failed`);
  if (plan.skips.length) parts.push(`${plan.skips.length} skipped (${plan.skips[0].reason}${plan.skips.length > 1 ? ", …" : ""})`);
  if (aborted) parts.push(aborted);
  ui.notice = parts.join(" · ") || "Nothing to do";
  selected = new Set();
  ui.bulkBusy = null;
  await load();
}
```

3. Handlers — insert ABOVE the `[data-loadbody]` handler (bulk buttons must not fall through to per-row handlers):

```js
  const bAct = e.target.closest("[data-bulk-delete],[data-bulk-kill],[data-bulk-delkill],[data-bulk-undo]");
  if (bAct) {
    if (ui.bulkBusy) return;
    const ds = bAct.dataset;
    const action = "bulkDelete" in ds ? "delete" : "bulkKill" in ds ? "kill" : "bulkDelkill" in ds ? "delkill" : "undo";
    return void confirmThen(ds.token, () => runBulk(action));
  }
  const bClear = e.target.closest("[data-bulk-clear]");
  if (bClear) { selected = new Set(); ui.confirm = null; draw(); return; }
```

4. Replace the existing `[data-bulk-approve]` handler body with `return void runBulk("approve");` (keeping its `ui.undo = null;`).
5. The old direct use of `pendingApprovalsFor`/`filterItems` in that handler goes away (resolveBulkPlan covers it); remove now-unused imports if any (`filterItems` may still be used elsewhere — check before removing).

- [ ] **Step 4: Run** — contract + render + selection tests; `npm test`; `npm run test:e2e`.

- [ ] **Step 5: Commit** — `feat(panel): bulk execution loop with progress + aggregate summary`.

---

### Task 9: e2e — conversation view + bulk flows

**Files:**
- Modify: `e2e/panel.smoke.spec.js`

**Interfaces:**
- Consumes: everything above; fake connectors (delete/restore return per-id success; `deleteBySenderFn` canned f1-f3).

- [ ] **Step 1: Extend the seed.** In the seed's `members`, mark the 12 noise members `automated: true, conversationId: null`, and ADD a 3-member human conversation:

```js
  const conv = [
    { subject: "Path Peptides underwriting", from: "luis@brickell.example", fromName: "Luis", emailId: "h0", receivedAt: now, conversationId: "cv-1", automated: false },
    { subject: "RE: Path Peptides underwriting", from: "mckenna@partner.example", fromName: "McKenna", emailId: "h1", receivedAt: now, conversationId: "cv-1", automated: false },
    { subject: "RE: Path Peptides underwriting", from: "boarding@partner.example", fromName: "Boarding", emailId: "h2", receivedAt: now, conversationId: "cv-1", automated: false },
  ];
```

and include `...conv` in the item's members. (Title/count strings in existing assertions may need the member total updated — read the current spec file first.)

- [ ] **Step 2: New test — conversation renders as ONE group and bulk-deletes as one unit.**

```js
test("multi-sender conversation: one group, bulk delete + undo via the bar", async ({ page }) => {
  await page.goto(base);
  await page.locator("button.detail").first().click();
  const pane = page.locator("aside.detail");
  await expect(pane).toBeVisible();
  // one conversation group, correct meta, all three senders inside it
  await expect(pane.locator(".convgrp")).toHaveCount(1);
  await expect(pane.locator(".cghdr .cgname")).toContainText("Path Peptides underwriting");
  await expect(pane.locator(".cghdr .cgmeta")).toContainText("3 messages · 3 senders");

  // select the conversation → sticky bar appears
  await pane.locator('[data-select="conv:brickell:cv-1"]').check();
  const bar = page.locator(".bulkbar");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("1 selected");

  // two-click bulk delete
  await bar.locator("[data-bulk-delete]").click();
  await expect(bar.locator("[data-bulk-delete]")).toContainText("Confirm");
  await bar.locator("[data-bulk-delete]").click();
  await expect(page.locator(".notice")).toContainText(/Deleted 3 \(1 conversation\)/);

  // rows acted; survives reload (real ids → server-derived)
  await page.locator("button.detail").first().click();
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(3);
  await page.reload();
  await page.locator("button.detail").first().click();
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(3);

  // bulk undo the same conversation
  await page.locator('aside.detail [data-select="conv:brickell:cv-1"]').check();
  await page.locator(".bulkbar [data-bulk-undo]").click();
  await page.locator(".bulkbar [data-bulk-undo]").click();
  await expect(page.locator(".notice")).toContainText(/restored 3/);
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(0);
  await page.reload();
  await page.locator("button.detail").first().click();
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(0);
});
```

Adjust selectors against the real rendered markup if needed (the assertions are the contract). Note the existing row-level and delete-all tests must still pass — the noise cluster remains in the senders section with its buttons.

- [ ] **Step 3: Run** — `npm run test:e2e` (now 3 tests) twice for flake; `npm test`.

- [ ] **Step 4: Commit** — `test(e2e): conversation group render + bulk delete/undo flows`.

---

### Task 10: Docs + full verification

**Files:**
- Modify: `daemon/README.md`

- [ ] **Step 1:** Update the Panel section: two-section handled drill-in (Conversations = human mail by provider conversation ID; Bulk senders = automated mail), multi-select (tiles, sender-clusters, conversations) with the sticky bulk bar (Approve / Delete / Kill list / Delete & Kill / Undo / Clear; two-click confirm; aggregate summary; conversations/tiles delete by precise ids, only sender-clusters use the guarded delete-all query). Note the daemon restart requirement for the conversationId plumbing.

- [ ] **Step 2:** Full verification: `npm test` + `npm run test:e2e` — record exact counts.

- [ ] **Step 3: Commit** — `docs(daemon): bulk actions + conversation drill-in`.

---

## Self-review notes (already applied)

- Spec coverage: Component 0 → Tasks 1–2; Component 1 → Task 6; Component 2 → Tasks 3–4; Component 3 → Task 7; Component 4 → Task 8; Component 5 → Task 5; Component 6 → per-task tests + Task 9.
- Type consistency: op shapes in Task 6's resolver match Task 8's runBulk consumers exactly (`unit`, `optimisticIds`, `undoOf`, `proposalId`); `groupHandledMembers` group shapes match Task 4's render consumption; typed keys consistent across Tasks 4/6/7/8/9 (`item:`/`cluster:<account>:<sender>`/`conv:<account>:<key>`).
- Known seam risk called out in-task: existing render/e2e assertions touching `.sghdr`/checkbox markup may need loosening (Tasks 4/7/9 each instruct reading current fixtures first).
- YAGNI held: no select-all, no persistence, no snackbar-undo-all (spec's out-of-scope list).
