# Ambient Proposal Panel — `handled` job + normalizer registry + reasoner fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `handled` job-type ("Is my world handled?" — a per-account roll-up of the existing pipeline), generalize the scheduler to run any number of configured job-type normalizers, and add a deterministic-first **reasoner fallback** that shells to the `claude` CLI to group the `owed_risk` stragglers plain rules leave as `"ungrouped"`.

**Architecture:** A normalizer **registry** (`daemon/normalizers/index.js`) maps a jobType to an adapter `(classified, account, typeConfig) => items[]`. The scheduler classifies each account's mail once per tick, then runs every normalizer the account's type config enables — so adding a job stays "a normalizer + config," exactly as designed. `handled` derives its summary purely from the existing triage-category buckets (no new email signals). The reasoner fallback (`daemon/reasoner.js`) is pure prompt-build + response-parse with an injected `runClaude` function; the daemon wires the real one by shelling `claude -p`. It activates only when injected and only on genuine `"ungrouped"` residue — deterministic grouping stays the default.

**Tech Stack:** Node.js ESM, `node --test` + `node:assert/strict`, `node:child_process` (`spawnSync` to `claude`). No new npm dependencies. Builds on Plan 1 + Plan 2 (`daemon/`), reuses the canonical Item shape and the existing `normalizeOwedRisk`/`grouping`/`scheduler` modules without breaking them.

---

## Scope

**In this plan:** the `handled` job-type + its normalizer; a normalizer registry; scheduler generalization to run all configured job-types (owed_risk behavior preserved); the `claude`-CLI reasoner fallback for owed_risk grouping stragglers; daemon wiring + docs.

**Not in this plan:** the `audit` and `exposed` job-types — they need real (redacted) example emails from the user to define detection signals without guessing; they are queued for a follow-up plan once those samples exist. Native tray and mobile remain deferred.

## Prerequisites / starting state

Plans 1 & 2 merged. `daemon/normalizers/owed-risk.js` exports `normalizeOwedRisk(emails, account, rules)` where `emails` is a flat array (the scheduler currently flattens `jobRules.sourceCategories` before calling it). `daemon/grouping.js` exports `groupKey(email, order)` which returns `"ungrouped"` when no rule matches. `daemon/scheduler.js` `runTick(deps)` calls `normalizeOwedRisk` inline (scheduler.js:41-43 flattens, :43 normalizes). The Item shape: `{id, jobType, account, title, status:"at_risk"|"ok", group:{rootCause, members:[...]}, source:[...], proposedActions:[...], lastChanged}`. The view-model's `needsYouCount` = count of items with `status === "at_risk"`.

**Design decision — `handled` does not inflate "needs you":** `handled` items are per-account *summaries*, always `status:"ok"` (the count lives in the title). Only real action items (`owed_risk`, future `audit`/`exposed`) are `at_risk`. This keeps the header's "N need you" honest and needs no view-model change.

## Conventions

Source under `daemon/`, tests co-located `daemon/**/*.test.js` (already in the glob). Pure logic unit-tested; subprocess glue thin and injected for tests. The reasoner module must not import `node:child_process` at the pure layer it tests — the shell-out lives in the daemon wiring with an injected function.

---

### Task 1: Config — add the `handled` job to both account types

**Files:**
- Modify: `config/account-types.example.json` (add `jobTypes.handled` to `business` and add a `jobTypes` block to `personal`)
- Modify: `daemon/config.test.js`

- [ ] **Step 1: Add the failing assertion**

In `daemon/config.test.js`, add a new test inside the existing describe block:

```js
  it("both account types declare a handled job", () => {
    const cfg = JSON.parse(readFileSync(join(root, "config/account-types.example.json"), "utf-8"));
    assert.ok(cfg.business.jobTypes?.handled, "business.jobTypes.handled must exist");
    assert.ok(cfg.personal.jobTypes?.handled, "personal.jobTypes.handled must exist");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/config.test.js`
Expected: FAIL — `personal.jobTypes.handled must exist` (and business has only `owed_risk` today).

- [ ] **Step 3: Edit the config**

In `config/account-types.example.json`, in the `business` object's `jobTypes` (which currently has `owed_risk`), add a sibling `handled` key:

```json
      "owed_risk": {
        "sourceCategories": ["action"],
        "failureSignals": [
          "payment failed", "payment was declined", "card was declined",
          "unable to process", "past due", "payment unsuccessful",
          "could not be processed", "your card on file"
        ],
        "grouping": { "order": ["card", "vendorDomain"] },
        "threshold": { "atRiskMembers": 1 }
      },
      "handled": {}
```

In the `personal` object, add a `jobTypes` key (personal has none today). Place it after `"taskCapture": "manual"`:

```json
    "taskCapture": "manual",
    "jobTypes": {
      "handled": {}
    }
```

(`handled` needs no rules — it reads the `actionable` flags already on `triageCategories`.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/config.test.js`
Expected: PASS (both the original owed_risk test and the new handled test).

- [ ] **Step 5: Commit**

```bash
git add config/account-types.example.json daemon/config.test.js
git commit -m "chore(daemon): declare the handled job in both account types"
```

(Operator note: the live gitignored `config/account-types.json` needs the same `jobTypes.handled: {}` added to each type.)

---

### Task 2: `normalizers/handled` — per-account summary item

**Files:**
- Create: `daemon/normalizers/handled.js`
- Create: `daemon/normalizers/handled.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/handled.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeHandled } from "./handled.js";

const account = { id: "brickell" };
const typeConfig = { triageCategories: [
  { id: "action", actionable: true },
  { id: "fyi" },
  { id: "news" },
  { id: "ignore", hidden: true },
] };

function classifiedWith(counts) {
  const categories = {};
  for (const [id, n] of Object.entries(counts)) {
    categories[id] = { emails: Array.from({ length: n }, (_, i) => ({ id: `${id}${i}` })) };
  }
  return { categories };
}

describe("normalizeHandled", () => {
  it("emits one summary item per account with needs-you and waiting counts", () => {
    const items = normalizeHandled(classifiedWith({ action: 2, fyi: 3, news: 1, ignore: 5 }), account, typeConfig);
    assert.equal(items.length, 1);
    const it0 = items[0];
    assert.equal(it0.id, "brickell:handled");
    assert.equal(it0.jobType, "handled");
    assert.equal(it0.status, "ok");                 // summaries never inflate "need you"
    assert.match(it0.title, /2 need you/);
    assert.match(it0.title, /4 waiting/);           // fyi(3) + news(1); ignore excluded
  });

  it("says inbox clear when nothing is actionable or waiting", () => {
    const items = normalizeHandled(classifiedWith({ ignore: 4 }), account, typeConfig);
    assert.match(items[0].title, /clear/i);
    assert.equal(items[0].group.members.length, 0);
  });

  it("carries the counts in group for the UI", () => {
    const items = normalizeHandled(classifiedWith({ action: 1, fyi: 2 }), account, typeConfig);
    assert.equal(items[0].group.rootCause, "handled");
    assert.deepEqual(items[0].group.counts, { needsYou: 1, waiting: 2 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/handled.test.js`
Expected: FAIL — cannot find module `./handled.js`.

- [ ] **Step 3: Implement `daemon/normalizers/handled.js`**

```js
/**
 * normalizers/handled.js — pure transform producing ONE per-account summary
 * item answering "is my world handled?". Derived entirely from the existing
 * triage-category buckets; needs no email-content signals.
 *
 * Summary items are always status "ok" so they never inflate the panel's
 * "N need you" count — the counts live in the title and group.counts.
 */
function actionableIds(typeConfig) {
  const flagged = (typeConfig.triageCategories || []).filter(c => c.actionable).map(c => c.id);
  if (flagged.length) return new Set(flagged);
  // back-compat fallback (mirrors morning-brief): treat action/respond as actionable
  return new Set((typeConfig.triageCategories || []).map(c => c.id).filter(id => id === "action" || id === "respond"));
}

export function normalizeHandled(classified, account, typeConfig) {
  const actionable = actionableIds(typeConfig);
  let needsYou = 0;
  let waiting = 0;
  for (const [id, bucket] of Object.entries(classified.categories || {})) {
    if (id === "ignore") continue;
    const n = bucket.emails?.length || 0;
    if (actionable.has(id)) needsYou += n;
    else waiting += n;
  }
  const title = needsYou > 0
    ? `${needsYou} need you · ${waiting} waiting`
    : (waiting > 0 ? `${waiting} waiting · inbox clear` : "Inbox clear");
  return [{
    id: `${account.id}:handled`,
    jobType: "handled",
    account: account.id,
    title,
    status: "ok",
    group: { rootCause: "handled", members: [], counts: { needsYou, waiting } },
    source: [],
    proposedActions: [],
    lastChanged: null,
  }];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/handled.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/handled.js daemon/normalizers/handled.test.js
git commit -m "feat(daemon): handled job-type per-account summary normalizer"
```

---

### Task 3: Normalizer registry + scheduler generalization

**Files:**
- Create: `daemon/normalizers/index.js`
- Create: `daemon/normalizers/index.test.js`
- Modify: `daemon/scheduler.js`
- Modify: `daemon/scheduler.test.js`

The registry adapts each jobType to a uniform call. `owed_risk`'s existing `(emails, account, rules)` signature is preserved — the adapter does the `sourceCategories` flatten that the scheduler does today, so `owed-risk.js` and its tests are untouched.

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/index.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runNormalizers } from "./index.js";

const account = { id: "brickell", links: { billing_portal: "https://pay.example/portal" } };
const typeConfig = {
  triageCategories: [{ id: "action", actionable: true }, { id: "fyi" }, { id: "ignore", hidden: true }],
  jobTypes: {
    owed_risk: { sourceCategories: ["action"], failureSignals: ["payment failed", "was declined"], grouping: { order: ["card", "vendorDomain"] }, threshold: { atRiskMembers: 1 } },
    handled: {},
  },
};
const classified = { categories: {
  action: { emails: [
    { id: "e1", from: "billing@acme.com", fromName: "Acme", subject: "Payment failed — card ending in 4821", preview: "" },
    { id: "e2", from: "ar@acme.com", fromName: "Acme", subject: "Your card ending in 4821 was declined", preview: "" },
  ] },
  fyi: { emails: [{ id: "f1" }, { id: "f2" }] },
} };

describe("runNormalizers", () => {
  it("runs every configured job-type and returns the union of items", () => {
    const items = runNormalizers(classified, account, typeConfig);
    assert.ok(items.some(i => i.jobType === "owed_risk" && i.group.rootCause === "card_4821"));
    assert.ok(items.some(i => i.jobType === "handled" && i.id === "brickell:handled"));
  });

  it("skips unknown job-types without throwing", () => {
    const cfg = { ...typeConfig, jobTypes: { ...typeConfig.jobTypes, mystery: {} } };
    const items = runNormalizers(classified, account, cfg);
    assert.ok(items.length >= 2);
  });

  it("passes an injected reasoner only to owed_risk (handled ignores it)", () => {
    let called = false;
    const reasonerFn = () => { called = true; return []; };
    // No ungrouped stragglers here, so reasoner need not be called; just assert no throw + items present.
    const items = runNormalizers(classified, account, typeConfig, { reasonerFn });
    assert.ok(items.length >= 2);
    assert.equal(called, false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/index.test.js`
Expected: FAIL — cannot find module `./index.js`.

- [ ] **Step 3: Implement `daemon/normalizers/index.js`**

```js
/**
 * normalizers/index.js — registry mapping a jobType to an adapter with the
 * uniform signature (classified, account, typeConfig, opts) => Item[].
 * Adapters localize each job's input prep so adding a job stays additive.
 */
import { normalizeOwedRisk } from "./owed-risk.js";
import { normalizeHandled } from "./handled.js";

function flattenSourceEmails(classified, sourceCategories) {
  const out = [];
  for (const cat of sourceCategories || []) {
    const bucket = classified.categories?.[cat];
    if (bucket?.emails) out.push(...bucket.emails);
  }
  return out;
}

const ADAPTERS = {
  owed_risk(classified, account, typeConfig, opts) {
    const rules = typeConfig.jobTypes.owed_risk;
    const emails = flattenSourceEmails(classified, rules.sourceCategories);
    const items = normalizeOwedRisk(emails, account, rules);
    // Optional reasoner fallback for ungrouped stragglers (added in Task 5).
    if (opts?.reasonerFn) return opts.reasonerFn(items, emails, account, rules);
    return items;
  },
  handled(classified, account, typeConfig) {
    return normalizeHandled(classified, account, typeConfig);
  },
};

/**
 * Run every job-type the account's typeConfig enables. Unknown jobTypes are skipped.
 * @param opts { reasonerFn? } passed through to adapters that use it.
 */
export function runNormalizers(classified, account, typeConfig, opts = {}) {
  const items = [];
  for (const jobType of Object.keys(typeConfig.jobTypes || {})) {
    const adapter = ADAPTERS[jobType];
    if (!adapter) continue;
    items.push(...adapter(classified, account, typeConfig, opts));
  }
  return items;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/index.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the registry into the scheduler**

In `daemon/scheduler.js`, replace the per-account normalization. Change the import block (currently imports `normalizeOwedRisk` + `stageProposals`):

```js
import { runNormalizers } from "./normalizers/index.js";
import { stageProposals } from "./proposals.js";
```

(Remove the now-unused `normalizeOwedRisk` import and the `flattenSourceEmails` helper at the top of scheduler.js — it now lives in the registry.)

Replace the per-account body that currently does the owed_risk-specific work (the lines computing `jobRules`, `sourceEmails`, and `items` via `normalizeOwedRisk`) with a registry call. The loop body becomes:

```js
  for (const account of accounts) {
    const typeConfig = typeConfigs[account.accountType];
    if (!typeConfig?.jobTypes) continue;
    let emails;
    try {
      emails = await fetchFn(account.id);
    } catch (err) {
      warnings.push(`[${account.id}] fetch failed: ${err.message}`);
      const wasStale = prev.accounts?.[account.id]?.status === "stale";
      if (!wasStale) staleFlips.push(account.id);
      accountsState[account.id] = { status: "stale", lastTickAt: clock.now };
      nextItems.push(...prev.items.filter(i => i.account === account.id));
      continue;
    }
    const classified = classifyFn(emails, account);
    const items = runNormalizers(classified, account, typeConfig, { reasonerFn: deps.reasonerFn });
    for (const item of items) {
      const before = prevItemsById.get(item.id);
      const sameShape = before && JSON.stringify({ ...before, lastChanged: null }) === JSON.stringify({ ...item, lastChanged: null });
      item.lastChanged = sameShape ? before.lastChanged : clock.now;
    }
    nextItems.push(...items);
    accountsState[account.id] = { status: "ok", lastTickAt: clock.now };
  }
```

(The `deps.reasonerFn` is undefined until Task 6 wires it — `runNormalizers` already tolerates that. `stageProposals` is unchanged and naturally produces no proposals for `handled` items since they have no `draft_chase` action.)

- [ ] **Step 6: Update scheduler tests**

In `daemon/scheduler.test.js`, the existing `typeConfigs` fixture has only `owed_risk`. Add `handled: {}` to its `jobTypes` and add `triageCategories` so `handled` can compute. Find the `typeConfigs` const and change the `business` block to:

```js
const typeConfigs = { business: {
  triageCategories: [{ id: "action", actionable: true }, { id: "fyi" }, { id: "ignore", hidden: true }],
  jobTypes: {
    owed_risk: { sourceCategories: ["action"], failureSignals: ["payment failed", "was declined"], grouping: { order: ["card", "vendorDomain"] }, threshold: { atRiskMembers: 1 } },
    handled: {},
  },
} };
```

Add one test inside `describe("runTick", ...)`:

```js
  it("produces a handled summary item alongside owed_risk", async () => {
    const dir = tmp();
    try {
      const d = deps(dir);
      await runTick(d);
      const model = d.store.getModel();
      assert.ok(model.items.some(i => i.jobType === "handled" && i.id === "brickell:handled"));
      assert.ok(model.items.some(i => i.jobType === "owed_risk"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
```

The existing 5 scheduler tests must still pass (owed_risk grouping, stale handling, diff-gated emit, newAtRisk, staleFlips). Note the diff-gated test now also has a `handled` item, but two identical ticks still produce identical models → still exactly 1 emit.

- [ ] **Step 7: Run to verify**

Run: `node --test daemon/scheduler.test.js`
Expected: PASS (6 tests: original 5 + new handled test).
Run: `node --test daemon/normalizers/owed-risk.test.js`
Expected: PASS (unchanged — owed-risk.js was not modified).
Run the full daemon suite (recurse daemon for *.test.js) → green.

- [ ] **Step 8: Commit**

```bash
git add daemon/normalizers/index.js daemon/normalizers/index.test.js daemon/scheduler.js daemon/scheduler.test.js
git commit -m "feat(daemon): normalizer registry + scheduler runs all job-types"
```

---

### Task 4: `reasoner` — pure prompt build + response parse

**Files:**
- Create: `daemon/reasoner.js`
- Create: `daemon/reasoner.test.js`

Pure functions only; the actual `claude` shell-out is injected (Task 6 supplies it). The reasoner proposes a grouping key for each straggler email; deterministic confirmation happens in Task 5.

- [ ] **Step 1: Write the failing test**

Create `daemon/reasoner.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGroupingPrompt, parseGroupingResponse } from "./reasoner.js";

const stragglers = [
  { id: "e1", from: "billing@acme.com", subject: "Overdue balance on your account" },
  { id: "e2", from: "ar@acme.com", subject: "Reminder: amount outstanding" },
  { id: "e3", from: "dunning@globex.io", subject: "Final notice" },
];

describe("buildGroupingPrompt", () => {
  it("includes each straggler's id, sender, and subject and asks for JSON", () => {
    const p = buildGroupingPrompt(stragglers);
    assert.match(p, /e1/); assert.match(p, /acme\.com/); assert.match(p, /Overdue/);
    assert.match(p, /JSON/i);
  });
});

describe("parseGroupingResponse", () => {
  it("parses a fenced or bare JSON map of emailId -> groupKey", () => {
    const fenced = "```json\n{\"e1\":\"acct:acme\",\"e2\":\"acct:acme\",\"e3\":\"acct:globex\"}\n```";
    assert.deepEqual(parseGroupingResponse(fenced), { e1: "acct:acme", e2: "acct:acme", e3: "acct:globex" });
  });
  it("returns {} on unparseable output (never throws)", () => {
    assert.deepEqual(parseGroupingResponse("the model rambled with no json"), {});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/reasoner.test.js`
Expected: FAIL — cannot find module `./reasoner.js`.

- [ ] **Step 3: Implement `daemon/reasoner.js`**

```js
/**
 * reasoner.js — deterministic-first grouping fallback. Pure prompt-build +
 * response-parse; the model call is injected (the daemon shells `claude`).
 * RAILS: reasoning only — proposes grouping keys, never sends or deletes mail.
 */
export function buildGroupingPrompt(stragglers) {
  const lines = stragglers.map(e => `- id=${e.id} | from=${e.from || ""} | subject=${(e.subject || "").replace(/\n/g, " ")}`);
  return [
    "You are grouping failed-payment emails by their underlying root cause",
    "(e.g. the same vendor/account behind multiple notices).",
    "Return ONLY a JSON object mapping each email id to a short stable group key",
    'like "acct:<vendor>" — no prose. Emails:',
    ...lines,
  ].join("\n");
}

export function parseGroupingResponse(text) {
  if (!text) return {};
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const obj = candidate.match(/\{[\s\S]*\}/);
  if (!obj) return {};
  try {
    const parsed = JSON.parse(obj[0]);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/reasoner.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/reasoner.js daemon/reasoner.test.js
git commit -m "feat(daemon): reasoner prompt build + response parse (pure)"
```

---

### Task 5: Apply the reasoner fallback to owed_risk stragglers

**Files:**
- Create: `daemon/normalizers/regroup.js`
- Create: `daemon/normalizers/regroup.test.js`
- Modify: `daemon/normalizers/index.js` (wire `reasonerFn` into the owed_risk adapter)

`regroup` takes the owed_risk items, finds the one whose `rootCause === "ungrouped"`, asks the injected reasoner to subdivide its members, and rebuilds items for the new groups (deterministic confirmation: only split when the reasoner returns ≥2 distinct keys covering the stragglers).

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/regroup.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { regroupStragglers } from "./regroup.js";

const account = { id: "brickell", links: { billing_portal: "https://pay.example/portal" } };
const rules = { threshold: { atRiskMembers: 1 } };

const items = [
  { id: "brickell:owed_risk:card_4821", jobType: "owed_risk", account: "brickell", title: "1 failed payment", status: "at_risk",
    group: { rootCause: "card_4821", members: [{ vendor: "X", from: "x@x.com", subject: "s", emailId: "k1" }] },
    source: [], proposedActions: ["draft_chase"], lastChanged: null },
  { id: "brickell:owed_risk:ungrouped", jobType: "owed_risk", account: "brickell", title: "2 failed payments — one root cause", status: "at_risk",
    group: { rootCause: "ungrouped", members: [
      { vendor: "Acme", from: "billing@acme.com", subject: "Overdue", emailId: "e1" },
      { vendor: "Globex", from: "dun@globex.io", subject: "Final", emailId: "e2" },
    ] },
    source: [], proposedActions: ["draft_chase"], lastChanged: null },
];

describe("regroupStragglers", () => {
  it("splits the ungrouped item per the reasoner's keys, leaving grouped items intact", async () => {
    const reasoner = async () => ({ e1: "acct:acme", e2: "acct:globex" });
    const out = await regroupStragglers(items, account, rules, reasoner);
    assert.ok(out.some(i => i.id === "brickell:owed_risk:card_4821"));     // untouched
    assert.ok(!out.some(i => i.group.rootCause === "ungrouped"));          // ungrouped replaced
    assert.ok(out.some(i => i.group.rootCause === "acct:acme"));
    assert.ok(out.some(i => i.group.rootCause === "acct:globex"));
  });

  it("returns items unchanged when there is no ungrouped item", async () => {
    const only = [items[0]];
    const out = await regroupStragglers(only, account, rules, async () => ({}));
    assert.deepEqual(out, only);
  });

  it("keeps the ungrouped item as-is when the reasoner yields <2 distinct keys (no confident split)", async () => {
    const out = await regroupStragglers(items, account, rules, async () => ({ e1: "x", e2: "x" }));
    assert.ok(out.some(i => i.group.rootCause === "ungrouped"));
  });

  it("never throws if the reasoner rejects", async () => {
    const out = await regroupStragglers(items, account, rules, async () => { throw new Error("claude down"); });
    assert.ok(out.some(i => i.group.rootCause === "ungrouped")); // falls back to deterministic result
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/regroup.test.js`
Expected: FAIL — cannot find module `./regroup.js`.

- [ ] **Step 3: Implement `daemon/normalizers/regroup.js`**

```js
/**
 * regroup.js — apply the reasoner fallback to the single "ungrouped" owed_risk
 * item. Deterministic confirmation: only split when the reasoner returns >=2
 * distinct keys covering the stragglers. Never throws; on any failure the
 * original deterministic items are returned.
 */
function buildItem(account, rules, rootCause, members) {
  const portal = account.links?.billing_portal || null;
  const n = members.length;
  const source = members.map(m => ({ kind: "thread", emailId: m.emailId }));
  if (portal) source.push({ kind: "url", url: portal });
  return {
    id: `${account.id}:owed_risk:${rootCause}`,
    jobType: "owed_risk",
    account: account.id,
    title: `${n} failed payment${n === 1 ? "" : "s"}${n > 1 ? " — one root cause" : ""}`,
    status: n >= (rules.threshold?.atRiskMembers ?? 1) ? "at_risk" : "ok",
    group: { rootCause, members },
    source,
    proposedActions: portal ? ["draft_chase", "route:billing_portal"] : ["draft_chase"],
    lastChanged: null,
  };
}

export async function regroupStragglers(items, account, rules, reasonerFn) {
  const ungrouped = items.find(i => i.group?.rootCause === "ungrouped");
  if (!ungrouped) return items;
  let mapping = {};
  try {
    mapping = await reasonerFn(ungrouped.group.members) || {};
  } catch {
    return items; // reasoner failed → keep deterministic result
  }
  const members = ungrouped.group.members;
  const byKey = new Map();
  for (const m of members) {
    const key = mapping[m.emailId];
    if (!key) return items;            // incomplete mapping → no confident split
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }
  if (byKey.size < 2) return items;    // not a confident subdivision
  const rest = items.filter(i => i !== ungrouped);
  for (const [rootCause, groupMembers] of byKey) rest.push(buildItem(account, rules, rootCause, groupMembers));
  return rest;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/regroup.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into the owed_risk adapter**

In `daemon/normalizers/index.js`, import regroup and use it when a reasoner is provided. Change the import block:

```js
import { normalizeOwedRisk } from "./owed-risk.js";
import { normalizeHandled } from "./handled.js";
import { regroupStragglers } from "./regroup.js";
```

Change the `owed_risk` adapter. Because `runNormalizers` is currently synchronous and `regroupStragglers` is async, make the adapter and `runNormalizers` async:

```js
const ADAPTERS = {
  async owed_risk(classified, account, typeConfig, opts) {
    const rules = typeConfig.jobTypes.owed_risk;
    const emails = flattenSourceEmails(classified, rules.sourceCategories);
    const items = normalizeOwedRisk(emails, account, rules);
    if (opts?.reasonerFn) return regroupStragglers(items, account, rules, opts.reasonerFn);
    return items;
  },
  handled(classified, account, typeConfig) {
    return normalizeHandled(classified, account, typeConfig);
  },
};

export async function runNormalizers(classified, account, typeConfig, opts = {}) {
  const items = [];
  for (const jobType of Object.keys(typeConfig.jobTypes || {})) {
    const adapter = ADAPTERS[jobType];
    if (!adapter) continue;
    items.push(...await adapter(classified, account, typeConfig, opts));
  }
  return items;
}
```

Update `daemon/normalizers/index.test.js` to `await runNormalizers(...)` in its three tests (they currently call it synchronously). Also update the third test's `reasonerFn` to accept the new call shape: the adapter passes `opts.reasonerFn` straight to `regroupStragglers`, which calls it with `(members)`. Since that fixture has no ungrouped item, the reasoner is never called — keep `assert.equal(called, false)`.

In `daemon/scheduler.js`, the loop already does `const items = runNormalizers(...)`. Change it to `const items = await runNormalizers(...)` (the call sits inside the already-`async` `runTick`, so just add `await`).

- [ ] **Step 6: Run to verify**

Run: `node --test daemon/normalizers/index.test.js daemon/normalizers/regroup.test.js daemon/scheduler.test.js`
Expected: PASS (index 3 + regroup 4 + scheduler 6).
Run the full daemon suite → green.

- [ ] **Step 7: Commit**

```bash
git add daemon/normalizers/regroup.js daemon/normalizers/regroup.test.js daemon/normalizers/index.js daemon/normalizers/index.test.js daemon/scheduler.js
git commit -m "feat(daemon): apply reasoner fallback to owed_risk stragglers"
```

---

### Task 6: Daemon wiring — the real `claude` reasoner

**Files:**
- Modify: `daemon/daemon.js`
- Create: `daemon/claude-reasoner.js`
- Create: `daemon/claude-reasoner.test.js`

The pure part (turning a `runClaude` text function into a `reasonerFn` that returns a grouping map) is tested; the actual `spawnSync("claude", ...)` is thin glue.

- [ ] **Step 1: Write the failing test**

Create `daemon/claude-reasoner.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeReasonerFn } from "./claude-reasoner.js";

describe("makeReasonerFn", () => {
  it("builds a prompt, runs claude, and returns the parsed grouping map", async () => {
    const seen = {};
    const runClaude = (prompt) => { seen.prompt = prompt; return '{"e1":"acct:acme","e2":"acct:globex"}'; };
    const reasonerFn = makeReasonerFn(runClaude);
    const map = await reasonerFn([
      { emailId: "e1", from: "billing@acme.com", subject: "Overdue" },
      { emailId: "e2", from: "dun@globex.io", subject: "Final" },
    ]);
    assert.match(seen.prompt, /e1/);
    assert.deepEqual(map, { e1: "acct:acme", e2: "acct:globex" });
  });

  it("returns {} when claude output is unparseable (never throws)", async () => {
    const reasonerFn = makeReasonerFn(() => "no json here");
    assert.deepEqual(await reasonerFn([{ emailId: "e1" }]), {});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/claude-reasoner.test.js`
Expected: FAIL — cannot find module `./claude-reasoner.js`.

- [ ] **Step 3: Implement `daemon/claude-reasoner.js`**

Note: `buildGroupingPrompt`/`parseGroupingResponse` expect a straggler shape with `id`/`from`/`subject`. The owed_risk members use `emailId` (not `id`). Map them before prompting.

```js
/**
 * claude-reasoner.js — turns a text-returning `runClaude(prompt)` into the
 * reasonerFn the normalizer registry expects: (members) => { emailId: key }.
 * RAILS: reasoning only.
 */
import { buildGroupingPrompt, parseGroupingResponse } from "./reasoner.js";

export function makeReasonerFn(runClaude) {
  return async (members) => {
    const stragglers = members.map(m => ({ id: m.emailId, from: m.from, subject: m.subject }));
    try {
      const out = await runClaude(buildGroupingPrompt(stragglers));
      return parseGroupingResponse(out);
    } catch {
      return {};
    }
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/claude-reasoner.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into `daemon/daemon.js`**

Add imports near the others:

```js
import { makeReasonerFn } from "./claude-reasoner.js";
```

Add a `runClaude` shell-out helper (near `fetchSubprocess`), guarded so a missing `claude` binary degrades to no grouping:

```js
function runClaude(prompt) {
  const child = spawnSync("claude", ["-p", prompt], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  if (child.error || child.status !== 0) throw new Error(child.stderr || "claude invocation failed");
  return child.stdout;
}
```

In `main()`, build the reasonerFn and pass it into the scheduler deps. Change the `deps` factory (currently returns the object with accounts/typeConfigs/store/fetchFn/classifyFn/clock/emit) to also include:

```js
    reasonerFn: makeReasonerFn(runClaude),
```

(`runNormalizers` only invokes it for owed_risk items left `"ungrouped"`, and `regroupStragglers` swallows any `claude` failure — so a machine without `claude` simply keeps the deterministic grouping.)

- [ ] **Step 6: Verify**

Run: `node --test daemon/claude-reasoner.test.js` → PASS (2).
Run: `npm test` → full suite green.
Run: `node --check daemon/daemon.js` → exit 0.
Run: `node daemon/daemon.js --once` → clean missing-config ENOENT (worktree has no gitignored config) or a tick summary — NOT a SyntaxError/ReferenceError from the new imports. Report exact output.

- [ ] **Step 7: Commit**

```bash
git add daemon/claude-reasoner.js daemon/claude-reasoner.test.js daemon/daemon.js
git commit -m "feat(daemon): wire the claude-CLI reasoner fallback"
```

---

### Task 7: Docs

**Files:**
- Modify: `daemon/README.md`

- [ ] **Step 1: Update the README**

(a) In the intro, change "live world model + staged proposal queue" wording to mention multiple jobs. Replace the first paragraph's last sentence so it reads:

```markdown
Always-on local service that turns the email pipeline into a live world model +
staged proposal queue, served over `localhost`. Surfaces the `owed_risk` and
`handled` jobs today (more are config + a normalizer away). Includes a glanceable
web panel (grouped "needs you" list, approve/dismiss, drill-in workbench) and
daemon-fired Windows toasts on threshold-crossing changes.
```

(b) Update the Config section to list job-types and the reasoner:

```markdown
## Config

- `config/account-types.json` → `<type>.jobTypes`: `owed_risk` (detection signals,
  grouping order, threshold) and `handled` (`{}` — derives from triage categories).
- `config/companies.json` → per account: `links.billing_portal`, optional `pollMinutes`.

## Grouping reasoner (optional)

`owed_risk` groups deterministically (card token, then vendor domain). Emails the
rules can't group are passed to the `claude` CLI to propose a grouping; the split
is only applied when the model returns ≥2 confident keys. If `claude` isn't
installed, grouping silently stays deterministic.
```

- [ ] **Step 2: Commit**

```bash
git add daemon/README.md
git commit -m "docs(daemon): document handled job + grouping reasoner"
```

---

## Self-Review (completed during authoring)

**Spec coverage:** `handled` job → Tasks 1–2; scheduler generalization to run all configured jobs → Task 3 (registry); reasoner fallback (shell to `claude`, deterministic-first) → Tasks 4–6; docs → Task 7. `audit`/`exposed` explicitly deferred (need real signal samples) — stated in Scope, not silently dropped.

**Placeholder scan:** no TBD/TODO; every code step has complete code; every command has expected output.

**Type consistency:** the Item shape emitted by `normalizeHandled` and `regroup.buildItem` matches the canonical shape used across Plans 1–2 (`id/jobType/account/title/status/group/source/proposedActions/lastChanged`). `runNormalizers` is async after Task 5; the scheduler awaits it (Task 5 Step 5) and `daemon.js` already runs inside async `runTick`. `reasonerFn` contract: `(members) => Promise<{emailId: key}>` — produced by `makeReasonerFn` (Task 6), consumed by `regroupStragglers` (Task 5). `buildGroupingPrompt` consumes `{id, from, subject}`; `makeReasonerFn` maps members' `emailId`→`id` before calling it (Task 6 Step 3 note).

**Rails:** `handled`, `reasoner`, `regroup`, `claude-reasoner` contain no send/delete; the reasoner only proposes grouping keys. The executor rails-guard is unaffected (no new files under `daemon/executors/`).

**Known follow-ups (not gold-plated):** `handled` counts live in the title + `group.counts`; a future panel tweak could render the summary distinctly (e.g. a header chip per account) rather than as a card. The reasoner is invoked per-tick only when stragglers exist; if it ever proves chatty, add a cache keyed by straggler-id set.
```
