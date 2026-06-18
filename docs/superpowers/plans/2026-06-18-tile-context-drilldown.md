# Tile Context + Inbox Grouping + Drill-Down Detail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the panel's tiles by inbox, give each tile sender/date/count context, and add a slide-in detail panel — all over the existing zero-dependency vanilla `daemon/web/` surface.

**Architecture:** Recognizers already carry `from`/`fromName`/`receivedAt`; normalizers just need to pass them onto `group.members`. The scheduler stamps each account's `label`/`accountType`. The pure `view-model.js` derives per-tile display fields and per-group metadata; pure `render.js` builds sections, enriched cards, and the detail panel; `app.js` adds collapse + detail UI state. No API/connector/classification changes.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, vanilla browser JS/CSS (no build, no deps).

**Spec:** `docs/superpowers/specs/2026-06-18-tile-context-drilldown-design.md`

**Baseline:** full suite currently green (479/479). Run `npm test` from the repo root. Keep everything green.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `daemon/normalizers/{gateway,audit,exposed}.js` | per-job item building | add `from`/`fromName` to members |
| `daemon/normalizers/owed-risk.js` | owed_risk items | add `receivedAt`/`fromName` to members |
| `daemon/scheduler.js` | one tick | stamp `label`/`accountType` on account state |
| `daemon/web/view-model.js` | pure model→view transform | derive `item.display`, group meta, ordering, `findItem`, `filterGroups` |
| `daemon/web/render.js` | pure HTML builders | `relativeTime`, enriched card, `renderAccountSection`, `renderDetailPanel` |
| `daemon/web/app.js` | DOM glue | collapse + detail state, sections, Esc/backdrop |
| `daemon/web/styles.css` | panel styling | sections, chip/subline, off-canvas panel |
| `daemon/web/contract.test.js` | render↔handler contract | cover new data-attrs |

---

## Task 1: Normalizer member shape — pass sender + date through

**Files:**
- Modify: `daemon/normalizers/gateway.js:45`, `daemon/normalizers/audit.js:42`, `daemon/normalizers/exposed.js:47`, `daemon/normalizers/owed-risk.js:43`
- Test: `daemon/normalizers/gateway.test.js`, `audit.test.js`, `exposed.test.js`, `owed-risk.test.js`

- [ ] **Step 1: Add member-field assertions to the four normalizer tests (failing)**

In `daemon/normalizers/gateway.test.js`, change email `c` (line 19) to include sender fields:

```js
  { id: "c", from: "support@nmi.com", fromName: "NMI Support", subject: "Re: [NMI Ticket 1260651] Tokenization Error - GW ID 1218748", preview: "Our customer, Path Peptides (GW ID 1218748) is seeing tokenization errors", receivedAt: "2026-06-11T00:00:00Z" },
```

Add a new test inside `describe("normalizeGateway", ...)`:

```js
  it("carries member sender + date through for tile context", () => {
    const open = normalizeGateway(emails, account, rules).find(i => i.group.rootCause === "nmi:1260651");
    const m = open.group.members[0];
    assert.equal(m.from, "support@nmi.com");
    assert.equal(m.fromName, "NMI Support");
    assert.equal(m.receivedAt, "2026-06-11T00:00:00Z");
  });
```

In `daemon/normalizers/audit.test.js`, change email `a` (line 13-14) to add `fromName`:

```js
  { id: "a", from: "hello@secureframe.com", fromName: "Secureframe", subject: "Your auditor marked a test as Action required",
    preview: "Your auditor manually updated the test Load balancers for cloud infrastructure traffic (Azure) to Action required.", receivedAt: "2026-06-15T00:00:00Z" },
```

Add a test inside `describe("normalizeAudit", ...)`:

```js
  it("carries member sender + date through for tile context", () => {
    const m = normalizeAudit(emails, account, rules)[0].group.members.find(x => x.emailId === "a");
    assert.equal(m.from, "hello@secureframe.com");
    assert.equal(m.fromName, "Secureframe");
    assert.equal(m.receivedAt, "2026-06-15T00:00:00Z");
  });
```

In `daemon/normalizers/exposed.test.js`, change email `b` (line 18) to add `fromName`:

```js
  { id: "b", from: "defender-noreply@microsoft.com", fromName: "Microsoft Defender", subject: "New vulnerabilities notification from Microsoft Defender for Endpoint", preview: "Vulnerability Name CVE-2026-48778 Severity High CVSS 7.8 Notepad++", receivedAt: "2026-06-09T00:00:00Z" },
```

Add a test inside `describe("normalizeExposed", ...)`:

```js
  it("carries member sender + date through for tile context", () => {
    const cve = normalizeExposed(emails, account, rules).find(i => i.group.rootCause === "cve:CVE-2026-48778");
    const m = cve.group.members[0];
    assert.equal(m.from, "defender-noreply@microsoft.com");
    assert.equal(m.fromName, "Microsoft Defender");
    assert.equal(m.receivedAt, "2026-06-09T00:00:00Z");
  });
```

In `daemon/normalizers/owed-risk.test.js`, change emails `e1`/`e2` (lines 13-14) to add `receivedAt`:

```js
  { id: "e1", from: "billing@acme.com", fromName: "Acme", subject: "Payment failed — card ending in 4821", preview: "", receivedAt: "2026-06-14T00:00:00Z" },
  { id: "e2", from: "ar@globex.com", fromName: "Globex", subject: "Your card ending in 4821 was declined", preview: "", receivedAt: "2026-06-15T00:00:00Z" },
```

Add a test inside `describe("normalizeOwedRisk", ...)`:

```js
  it("carries member receivedAt + fromName through for tile context", () => {
    const card = normalizeOwedRisk(emails, account, rules).find(i => i.group.rootCause === "card_4821");
    const m = card.group.members.find(x => x.emailId === "e1");
    assert.equal(m.receivedAt, "2026-06-14T00:00:00Z");
    assert.equal(m.fromName, "Acme");
  });
```

- [ ] **Step 2: Run the four test files to confirm the new tests fail**

Run: `node --test daemon/normalizers/gateway.test.js daemon/normalizers/audit.test.js daemon/normalizers/exposed.test.js daemon/normalizers/owed-risk.test.js`
Expected: FAIL — the four new "carries … through" tests fail (members lack the fields); all pre-existing tests still pass.

- [ ] **Step 3: Add the fields in the four normalizers**

`daemon/normalizers/gateway.js` — replace the members map on line 45:

```js
        members: members.map(m => ({ subject: m.subject, emailId: m.id, receivedAt: m.receivedAt, from: m.from, fromName: m.fromName })),
```

`daemon/normalizers/audit.js` — replace the members map on line 42:

```js
        members: members.map(m => ({ subject: m.subject, emailId: m.id, receivedAt: m.receivedAt, from: m.from, fromName: m.fromName })),
```

`daemon/normalizers/exposed.js` — replace the members map on line 47:

```js
        members: members.map(m => ({ subject: m.subject, emailId: m.id, receivedAt: m.receivedAt, from: m.from, fromName: m.fromName })),
```

`daemon/normalizers/owed-risk.js` — replace the members map on line 43:

```js
        members: members.map(m => ({ vendor: m.fromName || m.from, from: m.from, fromName: m.fromName, subject: m.subject, emailId: m.id, receivedAt: m.receivedAt })),
```

- [ ] **Step 4: Run the four test files to confirm they pass**

Run: `node --test daemon/normalizers/gateway.test.js daemon/normalizers/audit.test.js daemon/normalizers/exposed.test.js daemon/normalizers/owed-risk.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/gateway.js daemon/normalizers/audit.js daemon/normalizers/exposed.js daemon/normalizers/owed-risk.js daemon/normalizers/gateway.test.js daemon/normalizers/audit.test.js daemon/normalizers/exposed.test.js daemon/normalizers/owed-risk.test.js
git commit -m "feat(normalizers): carry member sender + date for tile context"
```

---

## Task 2: Scheduler stamps account label + type

**Files:**
- Modify: `daemon/scheduler.js:21-63`
- Test: `daemon/scheduler.test.js`

- [ ] **Step 1: Add assertions to existing scheduler tests (failing)**

In `daemon/scheduler.test.js`, inside the first test (`"produces a grouped owed_risk item …"`), after the `assert.equal(model.accounts.brickell.status, "ok");` line (line 53), add:

```js
      assert.equal(model.accounts.brickell.label, "brickell");
      assert.equal(model.accounts.brickell.accountType, "business");
```

Inside the stale test (`"marks an account stale …"`), after `assert.equal(model.accounts.brickell.status, "stale");` (line 65), add:

```js
      assert.equal(model.accounts.brickell.accountType, "business");
```

- [ ] **Step 2: Run the scheduler test to confirm failure**

Run: `node --test daemon/scheduler.test.js`
Expected: FAIL — `model.accounts.brickell.label`/`accountType` are `undefined`.

- [ ] **Step 3: Stamp label + accountType in both account-state branches**

In `daemon/scheduler.js`, at the top of the `for (const account of accounts)` loop body (right after line 22 `const typeConfig = typeConfigs[account.accountType];`), add:

```js
    const acctMeta = { label: account.label || account.name || account.id, accountType: account.accountType };
```

Replace the stale-branch assignment (line 48):

```js
      accountsState[account.id] = { status: "stale", lastTickAt: clock.now, ...acctMeta };
```

Replace the ok-branch assignment (line 62):

```js
    accountsState[account.id] = { status: "ok", lastTickAt: clock.now, ...acctMeta };
```

- [ ] **Step 4: Run the scheduler test to confirm pass**

Run: `node --test daemon/scheduler.test.js`
Expected: PASS (all tests, including the unchanged "emits update only when changed" — account-meta is not part of the item diff).

- [ ] **Step 5: Commit**

```bash
git add daemon/scheduler.js daemon/scheduler.test.js
git commit -m "feat(scheduler): stamp account label + type on world model"
```

---

## Task 3: View-model derivations (display fields, group meta, ordering, findItem, filterGroups)

**Files:**
- Modify: `daemon/web/view-model.js`
- Test: `daemon/web/view-model.test.js`

- [ ] **Step 1: Write failing tests for the new derivations**

In `daemon/web/view-model.test.js`, update the import (line 3):

```js
import { toPanelView, filterItems, filterGroups, findItem } from "./view-model.js";
```

Replace the `model` fixture (lines 5-16) with one that carries account labels, member senders/dates, and two accounts that both have items (so ordering is observable):

```js
const model = {
  generatedAt: "2026-06-17T12:00:00Z",
  accounts: {
    brickell: { status: "ok", lastTickAt: "t", label: "Brickell Pay", accountType: "business" },
    summit: { status: "ok", lastTickAt: "t", label: "Summit Miami", accountType: "business" },
  },
  items: [
    { id: "brickell:owed_risk:card_4821", jobType: "owed_risk", account: "brickell", title: "2 failed payments — one root cause", status: "at_risk",
      group: { rootCause: "card_4821", members: [
        { vendor: "Acme", from: "billing@acme.com", fromName: "Acme", subject: "s1", emailId: "e1", receivedAt: "2026-06-14T00:00:00Z" },
        { vendor: "Acme", from: "billing@acme.com", fromName: "Acme", subject: "s2", emailId: "e2", receivedAt: "2026-06-16T00:00:00Z" },
      ] }, source: [], proposedActions: ["draft_chase", "route:billing_portal"], lastChanged: "t" },
    { id: "brickell:owed_risk:vendor:initech.com", jobType: "owed_risk", account: "brickell", title: "1 failed payment", status: "at_risk",
      group: { rootCause: "vendor:initech.com", members: [{ vendor: "Initech", from: "ar@initech.com", fromName: "Initech", subject: "s3", emailId: "e3", receivedAt: "2026-06-10T00:00:00Z" }] },
      source: [], proposedActions: ["draft_chase"], lastChanged: "t" },
    { id: "summit:handled", jobType: "handled", account: "summit", title: "Summit — all handled", status: "ok",
      group: { rootCause: "summary", members: [{ subject: "x", emailId: "z", receivedAt: "2026-06-12T00:00:00Z", from: "a@b.com", fromName: "Bee" }] }, source: [], proposedActions: [], lastChanged: "t" },
  ],
  proposals: [
    { id: "brickell:owed_risk:card_4821::draft_chase", itemId: "brickell:owed_risk:card_4821", action: "draft_chase", state: "pending", preview: { summary: "x", drafts: [{}, {}] } },
    { id: "brickell:owed_risk:vendor:initech.com::draft_chase", itemId: "brickell:owed_risk:vendor:initech.com", action: "draft_chase", state: "executed", preview: { summary: "y", drafts: [{}] } },
  ],
};
```

The existing `toPanelView` tests (`counts…`, `attaches…`, `groups…`, `tolerates empty`) and the `filterItems` test continue to apply against this fixture — keep them. Add a new `describe` block:

```js
describe("toPanelView display + grouping", () => {
  it("derives display: sender, latest date, count per item", () => {
    const v = toPanelView(model);
    const card = v.groups.flatMap(g => g.items).find(i => i.id === "brickell:owed_risk:card_4821");
    assert.equal(card.display.messageCount, 2);
    assert.equal(card.display.latestDate, "2026-06-16T00:00:00Z");
    assert.equal(card.display.primarySender, "Acme");
    assert.equal(card.display.accountLabel, "Brickell Pay");
    assert.equal(card.display.accountType, "business");
  });

  it("surfaces label/type/atRiskCount per group and orders most-at-risk first", () => {
    const v = toPanelView(model);
    assert.equal(v.groups[0].account, "brickell");      // 2 at_risk
    assert.equal(v.groups[0].label, "Brickell Pay");
    assert.equal(v.groups[0].accountType, "business");
    assert.equal(v.groups[0].atRiskCount, 2);
    assert.equal(v.groups[1].account, "summit");         // 0 at_risk (handled is ok)
    assert.equal(v.groups[1].atRiskCount, 0);
  });

  it("falls back to account id when no label is present", () => {
    const v = toPanelView({ ...model, accounts: { brickell: { status: "ok" }, summit: { status: "ok" } } });
    assert.equal(v.groups.find(g => g.account === "brickell").label, "brickell");
  });
});

describe("findItem", () => {
  it("finds an item across groups by id, with display attached", () => {
    const v = toPanelView(model);
    const hit = findItem(v, "brickell:owed_risk:card_4821");
    assert.ok(hit);
    assert.equal(hit.display.accountLabel, "Brickell Pay");
    assert.equal(findItem(v, "nope"), null);
  });
});

describe("filterGroups", () => {
  it("filters items within each group and drops emptied groups", () => {
    const v = toPanelView(model);
    const g = filterGroups(v, { query: "initech" });
    assert.equal(g.length, 1);
    assert.equal(g[0].account, "brickell");
    assert.equal(g[0].items.length, 1);
    assert.equal(filterGroups(v, { query: "nope" }).length, 0);
  });
});
```

- [ ] **Step 2: Run the view-model test to confirm failure**

Run: `node --test daemon/web/view-model.test.js`
Expected: FAIL — `findItem`/`filterGroups` are not exported; `display`/group meta undefined.

- [ ] **Step 3: Implement the derivations**

Replace the entire contents of `daemon/web/view-model.js` with:

```js
/**
 * view-model.js — pure transforms from /model JSON into a render-ready view.
 * Imported by both the Node tests and the browser panel, so it must not use
 * any node: APIs.
 */

/** Per-tile display fields derived purely from an item's members + account meta. */
function deriveDisplay(item, accounts) {
  const members = item.group?.members || [];
  let latestDate = null;
  const counts = new Map();
  let primarySender = null, top = 0;
  for (const m of members) {
    if (m.receivedAt && (!latestDate || m.receivedAt > latestDate)) latestDate = m.receivedAt;
    const name = (item.jobType === "owed_risk" ? (m.vendor || m.fromName || m.from) : (m.fromName || m.from)) || null;
    if (name) {
      const n = (counts.get(name) || 0) + 1;
      counts.set(name, n);
      if (n > top) { top = n; primarySender = name; } // strict > keeps the first on ties
    }
  }
  const acct = accounts?.[item.account] || {};
  return {
    primarySender,
    latestDate,
    messageCount: members.length,
    accountLabel: acct.label || item.account,
    accountType: acct.accountType || null,
  };
}

export function toPanelView(model) {
  const proposalsByItem = new Map();
  for (const p of model.proposals || []) {
    if (!proposalsByItem.has(p.itemId)) proposalsByItem.set(p.itemId, []);
    proposalsByItem.get(p.itemId).push(p);
  }
  const items = (model.items || []).map(i => ({
    ...i,
    proposals: proposalsByItem.get(i.id) || [],
    display: deriveDisplay(i, model.accounts),
  }));

  const byAccount = new Map();
  for (const it of items) {
    if (!byAccount.has(it.account)) byAccount.set(it.account, []);
    byAccount.get(it.account).push(it);
  }
  const groups = [...byAccount.entries()].map(([account, accountItems]) => {
    const acct = model.accounts?.[account] || {};
    return {
      account,
      label: acct.label || account,
      accountType: acct.accountType || null,
      status: acct.status || "ok",
      atRiskCount: accountItems.filter(i => i.status === "at_risk").length,
      items: accountItems,
    };
  });
  groups.sort((a, b) =>
    b.atRiskCount - a.atRiskCount ||
    (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));

  const staleAccounts = Object.entries(model.accounts || {})
    .filter(([, s]) => s.status === "stale").map(([id]) => id);

  return {
    generatedAt: model.generatedAt || null,
    needsYouCount: items.filter(i => i.status === "at_risk").length,
    pendingCount: (model.proposals || []).filter(p => p.state === "pending").length,
    groups,
    staleAccounts,
  };
}

/** Flat list of items matching the filter — used by bulk-approve selection. */
export function filterItems(view, opts = {}) {
  const all = view.groups.flatMap(g => g.items);
  const q = (opts.query || "").toLowerCase();
  return all.filter(i =>
    (!opts.account || i.account === opts.account) &&
    (!opts.jobType || i.jobType === opts.jobType) &&
    (!q || `${i.title} ${i.group?.rootCause || ""}`.toLowerCase().includes(q))
  );
}

/** Groups with items filtered the same way; groups left empty are dropped. */
export function filterGroups(view, opts = {}) {
  const q = (opts.query || "").toLowerCase();
  return view.groups
    .map(g => ({
      ...g,
      items: g.items.filter(i =>
        (!opts.account || i.account === opts.account) &&
        (!opts.jobType || i.jobType === opts.jobType) &&
        (!q || `${i.title} ${i.group?.rootCause || ""}`.toLowerCase().includes(q))
      ),
    }))
    .filter(g => g.items.length > 0);
}

/** Locate an item (with its derived display) across all groups by id. */
export function findItem(view, id) {
  for (const g of view.groups) {
    const hit = g.items.find(i => i.id === id);
    if (hit) return hit;
  }
  return null;
}
```

- [ ] **Step 4: Run the view-model test to confirm pass**

Run: `node --test daemon/web/view-model.test.js`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add daemon/web/view-model.js daemon/web/view-model.test.js
git commit -m "feat(panel): derive tile display fields, group meta, findItem, filterGroups"
```

---

## Task 4: `relativeTime` helper in render.js

**Files:**
- Modify: `daemon/web/render.js`
- Test: `daemon/web/render.test.js`

- [ ] **Step 1: Write the failing test**

In `daemon/web/render.test.js`, update the import (line 3) to add `relativeTime`:

```js
import { renderHeader, renderItemCard, renderAccountSection, renderDetailPanel, relativeTime, safeUrl } from "./render.js";
```

Add a new describe block at the end of the file:

```js
describe("relativeTime", () => {
  const now = Date.parse("2026-06-18T12:00:00Z");
  it("buckets seconds/minutes/hours/days and falls back to a short date", () => {
    assert.equal(relativeTime("2026-06-18T11:59:30Z", now), "just now");
    assert.equal(relativeTime("2026-06-18T11:30:00Z", now), "30m ago");
    assert.equal(relativeTime("2026-06-18T09:00:00Z", now), "3h ago");
    assert.equal(relativeTime("2026-06-16T12:00:00Z", now), "2d ago");
    assert.equal(relativeTime("2026-06-01T12:00:00Z", now), "Jun 1");
  });
  it("returns empty string for missing/invalid input", () => {
    assert.equal(relativeTime(null, now), "");
    assert.equal(relativeTime("not-a-date", now), "");
  });
});
```

- [ ] **Step 2: Run render test to confirm failure**

Run: `node --test daemon/web/render.test.js`
Expected: FAIL — `relativeTime` is not a function / not exported.

- [ ] **Step 3: Implement `relativeTime`**

In `daemon/web/render.js`, add after the `safeUrl` function (after line 12):

```js
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Deterministic relative-time label. nowMs is injected so tests don't depend on the clock. */
export function relativeTime(iso, nowMs) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(then);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
```

- [ ] **Step 4: Run render test to confirm the new block passes**

Run: `node --test daemon/web/render.test.js`
Expected: the `relativeTime` block PASSES. (Other render tests may still pass here; they are updated in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add daemon/web/render.js daemon/web/render.test.js
git commit -m "feat(panel): deterministic relativeTime helper"
```

---

## Task 5: Enrich `renderItemCard` (jobType chip, date, sender/count subline, Details button)

**Files:**
- Modify: `daemon/web/render.js:22-42`
- Test: `daemon/web/render.test.js`

- [ ] **Step 1: Update render tests for the enriched card (failing)**

In `daemon/web/render.test.js`, replace the gateway fallback test (lines 54-65) with a test that reflects the new card (sender + count from `display`, subjects move to the detail panel) and add Details/chip assertions:

```js
  it("shows the jobType chip, primary sender, message count, and a Details button", () => {
    const gw = {
      id: "brickell:gateway:nmi:1260651", account: "brickell", jobType: "gateway",
      title: "NMI #1260651 · Tokenization Error", status: "at_risk",
      group: { rootCause: "nmi:1260651", members: [{ subject: "Re: [NMI Ticket 1260651]", emailId: "c", from: "support@nmi.com", fromName: "NMI Support", receivedAt: "2026-06-18T10:00:00Z" }] },
      display: { primarySender: "NMI Support", messageCount: 1, latestDate: "2026-06-18T10:00:00Z", accountLabel: "Brickell Pay", accountType: "business" },
      source: [{ kind: "url", url: "https://support.nmi.com/hc/requests/1260651" }], proposals: [],
    };
    const html = renderItemCard(gw, Date.parse("2026-06-18T12:00:00Z"));
    assert.match(html, /class="chip">gateway</);
    assert.match(html, /NMI Support/);
    assert.match(html, /1 message/);
    assert.match(html, /2h ago/);
    assert.match(html, /data-detail="brickell:gateway:nmi:1260651"/);
  });
  it("does not render member subjects on the card (they belong in the detail panel)", () => {
    const gw = {
      id: "x", account: "brickell", jobType: "gateway", title: "T", status: "ok",
      group: { rootCause: "r", members: [{ subject: "SECRET-SUBJECT", emailId: "c", from: "a@b.com", fromName: "Bee" }] },
      display: { primarySender: "Bee", messageCount: 1, latestDate: null, accountLabel: "Brickell Pay" },
      source: [], proposals: [],
    };
    assert.doesNotMatch(renderItemCard(gw, 0), /SECRET-SUBJECT/);
  });
```

The existing tests (`renders the title, root cause, and an approve button`, the two escaping/url tests, and the Acknowledge tests) keep working because the title, ids, `data-route`, and `data-ack` are unchanged. Leave them as-is.

- [ ] **Step 2: Run render test to confirm failure**

Run: `node --test daemon/web/render.test.js`
Expected: FAIL — no `chip`, no `data-detail`, sender/count not rendered.

- [ ] **Step 3: Rewrite `renderItemCard`**

In `daemon/web/render.js`, replace `renderItemCard` (lines 22-42) with:

```js
export function renderItemCard(item, nowMs = Date.now()) {
  const d = item.display || {};
  const pending = (item.proposals || []).find(p => p.state === "pending");
  const routeUrl = safeUrl((item.source || []).find(s => s.kind === "url")?.url);
  const approveBtn = pending
    ? `<button class="approve" data-approve="${esc(pending.id)}">✓ Approve ${esc(pending.action)}</button>` : "";
  const dismissBtn = pending
    ? `<button class="dismiss" data-dismiss="${esc(pending.id)}">dismiss</button>` : "";
  const routeBtn = routeUrl
    ? `<a class="route" target="_blank" rel="noopener" href="${esc(routeUrl)}" data-route="${esc(routeUrl)}">↗ Open</a>` : "";
  const ackBtn = (item.acknowledgeable && !item.acknowledged)
    ? `<button class="ack" data-ack="${esc(item.id)}" data-fp="${esc(item.fingerprint || "")}">Acknowledge</button>` : "";
  const detailBtn = `<button class="detail" data-detail="${esc(item.id)}">Details</button>`;

  const when = relativeTime(d.latestDate, nowMs);
  const count = d.messageCount ?? (item.group?.members || []).length;
  const subline = [
    d.primarySender ? esc(d.primarySender) : "",
    count ? `${count} message${count === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");

  return `<div class="card ${esc(item.status)}" data-item="${esc(item.id)}">`
    + `<label class="sel"><input type="checkbox" data-select="${esc(item.id)}"> select</label>`
    + `<div class="cardhdr"><span class="chip">${esc(item.jobType || "")}</span>`
    + `${when ? `<span class="when">${esc(when)}</span>` : ""}</div>`
    + `<div class="title">${esc(item.title)}</div>`
    + `${subline ? `<div class="meta">${subline}</div>` : ""}`
    + `<div class="actions">${approveBtn}${routeBtn}${ackBtn}${detailBtn}${dismissBtn}</div></div>`;
}
```

- [ ] **Step 4: Run render test to confirm pass**

Run: `node --test daemon/web/render.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/web/render.js daemon/web/render.test.js
git commit -m "feat(panel): enrich tile with chip, sender, count, date, Details button"
```

---

## Task 6: `renderAccountSection(group, collapsed, nowMs)`

**Files:**
- Modify: `daemon/web/render.js`
- Test: `daemon/web/render.test.js`

- [ ] **Step 1: Write the failing test**

In `daemon/web/render.test.js`, add a describe block:

```js
describe("renderAccountSection", () => {
  const group = {
    account: "brickell", label: "Brickell Pay", accountType: "business", atRiskCount: 2,
    items: [
      { id: "i1", account: "brickell", jobType: "gateway", title: "Item one", status: "at_risk", group: { rootCause: "r1", members: [] }, display: { primarySender: "NMI", messageCount: 1, latestDate: null }, source: [], proposals: [] },
    ],
  };
  it("renders a collapse header with label, type, and need-you count, plus the cards when expanded", () => {
    const html = renderAccountSection(group, false, 0);
    assert.match(html, /data-collapse="brickell"/);
    assert.match(html, /Brickell Pay/);
    assert.match(html, /business/);
    assert.match(html, /2 need you/);
    assert.match(html, /Item one/);
  });
  it("omits the card body when collapsed", () => {
    const html = renderAccountSection(group, true, 0);
    assert.match(html, /data-collapse="brickell"/);
    assert.doesNotMatch(html, /Item one/);
  });
});
```

- [ ] **Step 2: Run render test to confirm failure**

Run: `node --test daemon/web/render.test.js`
Expected: FAIL — `renderAccountSection` is not a function.

- [ ] **Step 3: Implement `renderAccountSection`**

In `daemon/web/render.js`, add after `renderItemCard`:

```js
export function renderAccountSection(group, collapsed, nowMs = Date.now()) {
  const need = group.atRiskCount || 0;
  const head = `<div class="sechdr" data-collapse="${esc(group.account)}">`
    + `<span class="chev">${collapsed ? "▸" : "▾"}</span>`
    + `<span class="seclabel">${esc(group.label || group.account)}</span>`
    + `<span class="sectype">${esc(group.accountType || "")}</span>`
    + `<span class="secneed">${esc(need)} need you</span></div>`;
  const body = collapsed ? "" : `<div class="list">${group.items.map(i => renderItemCard(i, nowMs)).join("")}</div>`;
  return `<section class="acct">${head}${body}</section>`;
}
```

- [ ] **Step 4: Run render test to confirm pass**

Run: `node --test daemon/web/render.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add daemon/web/render.js daemon/web/render.test.js
git commit -m "feat(panel): inbox-grouped account sections with collapse header"
```

---

## Task 7: `renderDetailPanel(item, nowMs)`

**Files:**
- Modify: `daemon/web/render.js`
- Test: `daemon/web/render.test.js`

- [ ] **Step 1: Write the failing test**

In `daemon/web/render.test.js`, add a describe block:

```js
describe("renderDetailPanel", () => {
  const item = {
    id: "brickell:gateway:nmi:1260651", account: "brickell", jobType: "gateway",
    title: "NMI #1260651 · Tokenization Error", status: "at_risk",
    display: { accountLabel: "Brickell Pay", accountType: "business" },
    group: { rootCause: "nmi:1260651", merchant: "Path Peptides", members: [
      { subject: "First message", from: "support@nmi.com", fromName: "NMI Support", emailId: "a", receivedAt: "2026-06-17T00:00:00Z" },
      { subject: "Second message", from: "support@nmi.com", fromName: "NMI Support", emailId: "b", receivedAt: "2026-06-18T00:00:00Z" },
    ] },
    source: [{ kind: "url", url: "https://support.nmi.com/hc/requests/1260651" }, { kind: "thread", emailId: "a" }],
  };
  it("renders inbox label, root cause, status, job-specific fields, messages, and a safe link-out", () => {
    const html = renderDetailPanel(item, Date.parse("2026-06-18T12:00:00Z"));
    assert.match(html, /Brickell Pay/);
    assert.match(html, /nmi:1260651/);
    assert.match(html, /at risk/);
    assert.match(html, /Path Peptides/);
    assert.match(html, /First message/);
    assert.match(html, /Second message/);
    assert.match(html, /NMI Support/);
    assert.match(html, /href="https:\/\/support\.nmi\.com\/hc\/requests\/1260651"/);
    assert.match(html, /data-detail-close/);
  });
  it("rejects a non-http link-out and escapes message subjects", () => {
    const evil = { ...item, source: [{ kind: "url", url: "javascript:alert(1)" }],
      group: { ...item.group, members: [{ subject: "<img src=x onerror=alert(1)>", from: "a@b.com", emailId: "a", receivedAt: "2026-06-18T00:00:00Z" }] } };
    const html = renderDetailPanel(evil, 0);
    assert.doesNotMatch(html, /javascript:alert/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img/);
  });
  it("returns empty string for a null item", () => {
    assert.equal(renderDetailPanel(null, 0), "");
  });
});
```

- [ ] **Step 2: Run render test to confirm failure**

Run: `node --test daemon/web/render.test.js`
Expected: FAIL — `renderDetailPanel` is not a function.

- [ ] **Step 3: Implement `renderDetailPanel`**

In `daemon/web/render.js`, add after `renderAccountSection`:

```js
export function renderDetailPanel(item, nowMs = Date.now()) {
  if (!item) return "";
  const d = item.display || {};
  const g = item.group || {};
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
  const msgs = members.map(m => {
    const who = m.fromName || m.from || m.vendor || "";
    const when = relativeTime(m.receivedAt, nowMs);
    return `<div class="msg"><div class="msgsub">${esc(m.subject || "(no subject)")}</div>`
      + `<div class="msgmeta">${esc(who)}${who && when ? " · " : ""}${esc(when)}</div></div>`;
  }).join("");

  const links = (item.source || [])
    .filter(s => s.kind === "url" && safeUrl(s.url))
    .map(s => `<a class="route" target="_blank" rel="noopener" href="${esc(s.url)}">↗ Open in system of record</a>`)
    .join("");

  return `<div class="backdrop" data-detail-close></div>`
    + `<aside class="detail" role="dialog" aria-label="Item detail">`
    + `<button class="detail-close" data-detail-close aria-label="Close">✕</button>`
    + `<div class="dtitle">${esc(item.title)}</div>`
    + `<div class="dmeta">${meta}</div>`
    + `<div class="dmsgs-h">Messages</div><div class="dmsgs">${msgs}</div>`
    + `${links ? `<div class="dlinks">${links}</div>` : ""}`
    + `</aside>`;
}
```

- [ ] **Step 4: Run render test to confirm pass**

Run: `node --test daemon/web/render.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add daemon/web/render.js daemon/web/render.test.js
git commit -m "feat(panel): slide-in detail panel renderer (metadata, messages, link-outs)"
```

---

## Task 8: Wire app.js (sections, collapse, detail open/close, Esc, backdrop) + contract test

**Files:**
- Modify: `daemon/web/app.js`
- Test: `daemon/web/contract.test.js`

- [ ] **Step 1: Extend the render↔handler contract test (failing)**

In `daemon/web/contract.test.js`, update the first test's attr list (line 13) to include the new interactive attributes:

```js
    for (const attr of ["data-approve", "data-dismiss", "data-ack", "data-select", "data-bulk-approve", "data-detail", "data-detail-close", "data-collapse"]) {
```

Update the render-emits test's attr list (line 18):

```js
    for (const attr of ["data-approve", "data-dismiss", "data-ack", "data-route", "data-detail", "data-collapse", "data-detail-close"]) {
```

- [ ] **Step 2: Run the contract test to confirm failure**

Run: `node --test daemon/web/contract.test.js`
Expected: FAIL — app.js does not yet select `[data-detail]`/`[data-collapse]`/`[data-detail-close]`.

- [ ] **Step 3: Rewrite `daemon/web/app.js`**

Replace the entire contents of `daemon/web/app.js` with:

```js
/**
 * app.js — thin DOM glue. Fetches /model, renders inbox-grouped sections via
 * render.js, live-reloads on SSE /events, posts approve/dismiss/ack, and drives
 * the collapse + slide-in detail UI. No business logic lives here.
 */
import { toPanelView, filterItems, filterGroups, findItem } from "./view-model.js";
import { renderHeader, renderAccountSection, renderDetailPanel, renderSelectControls, esc } from "./render.js";
import { toggle, pendingApprovalsFor } from "./selection.js";

const appEl = document.getElementById("app");
let lastModel = null;
const ui = { account: "", query: "", collapsed: new Set(), detailItemId: null };
let selected = new Set();

async function load() {
  const model = await (await fetch("/model")).json();
  lastModel = model;
  draw();
}

function draw() {
  if (!lastModel) return;
  const now = Date.now();
  const view = toPanelView(lastModel);

  // auto-close the detail panel if its item vanished (resolved/acked away)
  if (ui.detailItemId && !findItem(view, ui.detailItemId)) ui.detailItemId = null;

  const groups = filterGroups(view, ui);
  const sections = groups.map(g => renderAccountSection(g, ui.collapsed.has(g.account), now)).join("");
  const detail = ui.detailItemId ? renderDetailPanel(findItem(view, ui.detailItemId), now) : "";

  appEl.innerHTML =
    renderHeader(view)
    + `<div class="filters"><input id="q" placeholder="filter…" value="${esc(ui.query)}"></div>`
    + renderSelectControls(selected.size)
    + (sections || '<div class="empty">All clear.</div>')
    + detail;

  for (const id of selected) {
    const cb = appEl.querySelector(`[data-select="${CSS.escape(id)}"]`);
    if (cb) cb.checked = true;
  }
}

async function post(url) {
  await fetch(url, { method: "POST" });
  await load();
}

appEl.addEventListener("click", (e) => {
  const a = e.target.closest("[data-approve]");
  if (a) return void post(`/proposals/${encodeURIComponent(a.dataset.approve)}/approve`);
  const d = e.target.closest("[data-dismiss]");
  if (d) return void post(`/proposals/${encodeURIComponent(d.dataset.dismiss)}/dismiss`);
  const ack = e.target.closest("[data-ack]");
  if (ack) return void post(`/items/${encodeURIComponent(ack.dataset.ack)}/acknowledge?fp=${encodeURIComponent(ack.dataset.fp || "")}`);
  const close = e.target.closest("[data-detail-close]");
  if (close) { ui.detailItemId = null; draw(); return; }
  const det = e.target.closest("[data-detail]");
  if (det) { ui.detailItemId = det.dataset.detail; draw(); return; }
  const col = e.target.closest("[data-collapse]");
  if (col) { ui.collapsed = toggle(ui.collapsed, col.dataset.collapse); draw(); return; }
  const s = e.target.closest("[data-select]");
  if (s) { selected = toggle(selected, s.dataset.select); draw(); return; }
  const bulk = e.target.closest("[data-bulk-approve]");
  if (bulk) {
    const view = toPanelView(lastModel);
    const ids = pendingApprovalsFor(filterItems(view, ui), selected);
    selected = new Set();
    return void (async () => { for (const id of ids) await fetch(`/proposals/${encodeURIComponent(id)}/approve`, { method: "POST" }); await load(); })();
  }
});

appEl.addEventListener("input", (e) => {
  if (e.target.id === "q") { ui.query = e.target.value; draw(); }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.detailItemId) { ui.detailItemId = null; draw(); }
});

const es = new EventSource("/events");
es.onmessage = () => load();
es.onerror = () => {};

load();
```

Note: the `[data-detail-close]` check is placed **before** `[data-detail]` so closing the panel is never swallowed by the open handler (the close button has only `data-detail-close`, but ordering keeps intent explicit).

- [ ] **Step 4: Run the contract test (and the full web suite) to confirm pass**

Run: `node --test daemon/web/contract.test.js daemon/web/render.test.js daemon/web/view-model.test.js daemon/web/selection.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add daemon/web/app.js daemon/web/contract.test.js
git commit -m "feat(panel): wire inbox sections, collapse, and slide-in detail panel"
```

---

## Task 9: Panel styling (sections, chip/subline, off-canvas detail panel)

**Files:**
- Modify: `daemon/web/styles.css`

- [ ] **Step 1: Append the new styles**

Append to `daemon/web/styles.css` (after line 26):

```css
.cardhdr { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
.chip { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:#8a94a6; border:1px solid var(--line); border-radius:6px; padding:1px 6px; }
.when { color:#8a94a6; font-size:12px; }
.acct { margin:10px 0; }
.sechdr { display:flex; align-items:center; gap:8px; cursor:pointer; padding:6px 4px; border-bottom:1px solid var(--line); user-select:none; }
.sechdr .chev { color:#8a94a6; width:1em; }
.sechdr .seclabel { font-weight:600; }
.sechdr .sectype { color:#8a94a6; font-size:12px; }
.sechdr .secneed { margin-left:auto; color:var(--risk); font-size:12px; }
.acct .list { margin-top:10px; }
.detail-btn, .detail { background:transparent; color:#8a94a6; }
.backdrop { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:10; }
.detail { position:fixed; top:0; right:0; height:100vh; width:min(440px,90vw); background:var(--card); border-left:1px solid var(--line); box-shadow:-8px 0 24px rgba(0,0,0,.35); z-index:11; padding:18px; overflow-y:auto; }
.detail-close { position:absolute; top:12px; right:12px; background:transparent; color:#8a94a6; border:none; font-size:16px; cursor:pointer; }
.detail .dtitle { font-weight:700; font-size:16px; margin:0 24px 12px 0; }
.detail .drow { display:flex; gap:10px; padding:3px 0; font-size:13px; }
.detail .dk { color:#8a94a6; min-width:96px; }
.detail .dmsgs-h { margin:14px 0 6px; color:#8a94a6; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
.detail .msg { padding:8px 0; border-top:1px solid var(--line); }
.detail .msgsub { font-size:13px; }
.detail .msgmeta { color:#8a94a6; font-size:12px; margin-top:2px; }
.detail .dlinks { margin-top:16px; }
```

- [ ] **Step 2: Verify the stylesheet still loads (no syntax check needed beyond serving)**

Run: `node --test daemon/web` (the web suite does not parse CSS, but confirms nothing else broke).
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add daemon/web/styles.css
git commit -m "style(panel): section headers, jobType chip, slide-in detail panel"
```

---

## Task 10: Full suite + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites green, count ≥ baseline 479 (this plan adds tests, so the total rises).

- [ ] **Step 2: Manual smoke against the live daemon**

Start the daemon and open the panel:

```bash
node daemon/daemon.js --port 8139
```

Then in a browser open `http://localhost:8139/` and confirm:
- Tiles are grouped under inbox section headers; the most-at-risk inbox is first; each header shows label · type · "N need you".
- Each tile shows the jobType chip, a relative date, and a "sender · N messages" subline.
- Clicking a section header collapses/expands it (chevron flips, cards hide/show).
- Clicking "Details" slides in the right-hand panel with inbox label, root cause, status, any job-specific fields, the per-message list (subject · sender · date), and an "Open in system of record" link.
- Backdrop click, the ✕ button, and the Esc key all close the panel.
- Approve / Open / Acknowledge / dismiss / multi-select + bulk-approve all still work.
- After a tick (or acknowledging an item), an open panel for a vanished item closes itself.

Stop the daemon with Ctrl-C when done.

- [ ] **Step 3: Commit any verification-driven fixes**

If the smoke test surfaces issues, fix them with a focused commit referencing the symptom. If everything passes, no commit is needed for this task.

---

## Self-Review

**Spec coverage:**
- Inbox grouping + section headers + ordering + omit-empty + collapsible → Tasks 3 (grouping/ordering), 6 (section render), 8 (collapse wiring). ✓
- Tile context (sender/date/count, no badge) → Tasks 1 (data), 3 (derive), 5 (render). ✓
- `handled` summaries inside sections → covered by grouping (handled items group by account like any other); Task 3 fixture includes a handled item under `summit`. ✓
- Slide-in detail panel (metadata, job-specific fields, messages, link-outs, close affordances) → Tasks 7 (render) + 8 (open/close/Esc/backdrop) + 9 (off-canvas style). ✓
- Account label/type to panel → Task 2 (scheduler) + Task 3 (surfaced on group + display). ✓
- Sender data gap closed for gateway/audit/exposed, receivedAt+fromName for owed_risk → Task 1. ✓
- Preserve approve/open/ack/dismiss/bulk/SSE → Task 8 keeps all handlers; `filterItems` retained for bulk. ✓
- Edge cases (missing sender/date, empty section, vanished open item, missing label) → `relativeTime("")`/null handling (Task 4), `filterGroups` drops empties (Task 3), auto-close (Task 8), label fallback (Tasks 2/3). ✓
- Rails unchanged: no send/delete/fabricate paths touched. ✓

**Placeholder scan:** none — every code step shows full content.

**Type/name consistency:** `item.display.{primarySender,latestDate,messageCount,accountLabel,accountType}`, group `{account,label,accountType,status,atRiskCount,items}`, and signatures `renderItemCard(item, nowMs)`, `renderAccountSection(group, collapsed, nowMs)`, `renderDetailPanel(item, nowMs)`, `relativeTime(iso, nowMs)`, `findItem(view, id)`, `filterGroups(view, opts)` are used identically across Tasks 3–9. Data-attributes (`data-detail`, `data-detail-close`, `data-collapse`) match between render (Tasks 5–7), app (Task 8), and the contract test (Task 8). ✓
