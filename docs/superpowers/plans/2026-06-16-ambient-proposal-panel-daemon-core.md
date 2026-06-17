# Ambient Proposal Panel — Daemon Core (owed_risk slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a headless always-on local daemon that turns the existing email pipeline into a live world model + staged proposal queue for the `owed_risk` job, served over `localhost` (REST + SSE), with the safety rails (never auto-send, soft-delete only) enforced as a build-failing guard test.

**Architecture:** A new top-level `daemon/` module composed of pure, independently-testable units — `store` (persist model+queue), `grouping` + `normalizers/owed-risk` (raw classified emails → grouped items), `proposals` (lifecycle state machine), `executors/*` (the thin action seam, rails inside), `api` (REST + SSE), and `scheduler` (one tick: fetch → classify → normalize → stage → diff → persist → emit). `daemon.js` wires the real connectors (reusing the existing subprocess fetch/classify/save-draft pattern from `scripts/morning-brief.js`) and starts the server. Claude Code remains the control plane; the daemon does not host any UI in this plan.

**Tech Stack:** Node.js ESM (`"type": "module"`), Node's built-in test runner (`node --test`) with `node:test` + `node:assert/strict`, `node:http` for the server (no web framework), `atomicWrite` from `scripts/fs-utils.js` for OneDrive-safe persistence. No new dependencies.

---

## Scope

**In this plan:** the daemon core and the `owed_risk` job end-to-end, headless. Deliverable is a running service you can drive with `curl`.

**Not in this plan (later plans):** the web panel + drill-in workbench, the Windows toast notifier (Plan 2); the `handled` / `audit` / `exposed` job-types and the reasoner-assisted grouping fallback (Plan 3). The `owed_risk` normalizer in this plan is **deterministic-only**; the reasoner fallback hook is added in Plan 3.

## Conventions (match the existing repo)

- Source files: `daemon/<area>.js`, ESM, `export function`/`export async function`.
- Tests: **co-located** as `daemon/<area>.test.js` (Task 1 updates the `npm test` glob to include them). Use `import { describe, it } from "node:test"` and `import assert from "node:assert/strict"`.
- Every unit is a pure function or takes injected dependencies, so it tests without real connectors (mirrors `scripts/morning-brief.js`).
- Persisted state lives under `data/` (already gitignored).
- CLI entrypoints use the Windows-safe guard `if (process.argv[1] && process.argv[1].endsWith("<file>.js"))`.

## Canonical data shapes (used across all tasks — keep identical)

```js
// Item — one deduped/grouped unit of operational reality
{
  id,                 // stable: `${account}:owed_risk:${groupKey}`
  jobType: "owed_risk",
  account,            // e.g. "brickell"
  title,              // e.g. "3 failed payments — one root cause"
  status,             // "at_risk" | "ok"
  group: {
    rootCause,        // e.g. "card_4821" or "vendor:acme.com"
    members: [ { vendor, from, subject, emailId } ]
  },
  source: [ { kind: "thread", emailId } | { kind: "url", url } ],
  proposedActions: [ "draft_chase", "route:billing_portal" ],
  lastChanged         // ISO string
}

// Proposal — a staged action awaiting approval
{
  id,                 // `${itemId}::${action}`
  itemId,
  action,             // "draft_chase"
  params,             // { account, drafts: [ { to, subject, body, replyToMessageId? } ] }
  preview,            // { summary, drafts }
  state               // "pending" | "approved" | "executed" | "failed" | "dismissed" | "snoozed"
}

// Executor return
{ kind: "route", url } | { kind: "execute", result }

// World-model file (data/world-model.json)
{ generatedAt, accounts: { [id]: { status: "ok" | "stale", lastTickAt } }, items: [ Item ] }

// Queue file (data/proposal-queue.json)
{ proposals: [ Proposal ] }
```

---

### Task 1: Project wiring — test glob + config schema

**Files:**
- Modify: `package.json:10` (the `test` script)
- Modify: `config/account-types.example.json` (add `jobTypes.owed_risk` to the `business` type)
- Create: `daemon/config.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/config.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("account-types.example owed_risk schema", () => {
  it("business type declares an owed_risk job with detection + grouping rules", () => {
    const cfg = JSON.parse(readFileSync(join(root, "config/account-types.example.json"), "utf-8"));
    const job = cfg.business.jobTypes?.owed_risk;
    assert.ok(job, "business.jobTypes.owed_risk must exist");
    assert.ok(Array.isArray(job.sourceCategories) && job.sourceCategories.length > 0);
    assert.ok(Array.isArray(job.failureSignals) && job.failureSignals.length > 0);
    assert.ok(job.grouping && Array.isArray(job.grouping.order));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test daemon/config.test.js`
Expected: FAIL — `business.jobTypes.owed_risk must exist`.

- [ ] **Step 3: Update the test glob and add the config schema**

In `package.json`, change the `test` script (line 10) from:

```json
    "test": "node --test scripts/test/**/*.test.js"
```

to:

```json
    "test": "node --test \"scripts/test/**/*.test.js\" \"daemon/**/*.test.js\""
```

In `config/account-types.example.json`, add a `jobTypes` key to the `business` object (e.g. after `"taskCapture": "auto"`, before the closing brace of `business`):

```json
    "taskCapture": "auto",
    "jobTypes": {
      "owed_risk": {
        "sourceCategories": ["action"],
        "failureSignals": [
          "payment failed", "payment was declined", "card was declined",
          "unable to process", "past due", "payment unsuccessful",
          "could not be processed", "your card on file"
        ],
        "grouping": {
          "order": ["card", "vendorDomain"]
        },
        "threshold": { "atRiskMembers": 1 }
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test daemon/config.test.js`
Expected: PASS.

Note for the operator: the live `config/account-types.json` (gitignored) must get the same `jobTypes.owed_risk` block, and each account in `config/companies.json` that should surface this job needs `"links": { "billing_portal": "<url>" }`. These are config edits, done by hand in the control plane — not code.

- [ ] **Step 5: Commit**

```bash
git add package.json config/account-types.example.json daemon/config.test.js
git commit -m "chore(daemon): wire test glob + owed_risk config schema"
```

---

### Task 2: `store` — persist the world model + proposal queue

**Files:**
- Create: `daemon/store.js`
- Create: `daemon/store.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/store.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";

function tmp() { return mkdtempSync(join(tmpdir(), "officeos-store-")); }

describe("createStore", () => {
  it("returns empty model + queue when no files exist", () => {
    const dir = tmp();
    try {
      const store = createStore(dir);
      assert.deepEqual(store.getModel().items, []);
      assert.deepEqual(store.getQueue().proposals, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("persists and reloads the model and queue", () => {
    const dir = tmp();
    try {
      const a = createStore(dir);
      a.saveModel({ generatedAt: "t", accounts: { brickell: { status: "ok", lastTickAt: "t" } }, items: [{ id: "x" }] });
      a.saveQueue({ proposals: [{ id: "p1", state: "pending" }] });
      const b = createStore(dir); // fresh instance reads from disk
      assert.equal(b.getModel().items[0].id, "x");
      assert.equal(b.getQueue().proposals[0].id, "p1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("survives a corrupt file by returning empty", () => {
    const dir = tmp();
    try {
      const store = createStore(dir);
      store.saveModelRaw("{ not json");
      assert.deepEqual(store.getModel().items, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test daemon/store.test.js`
Expected: FAIL — cannot find module `./store.js`.

- [ ] **Step 3: Write minimal implementation**

Create `daemon/store.js`:

```js
/**
 * store.js — persistence for the daemon's world model + proposal queue.
 * Files live under <dataDir>/. Corrupt files degrade to empty (never throw),
 * so a bad write never bricks the daemon. Uses atomicWrite for OneDrive safety.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../scripts/fs-utils.js";

const EMPTY_MODEL = { generatedAt: null, accounts: {}, items: [] };
const EMPTY_QUEUE = { proposals: [] };

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return structuredClone(fallback); }
}

export function createStore(dataDir) {
  const modelPath = join(dataDir, "world-model.json");
  const queuePath = join(dataDir, "proposal-queue.json");
  return {
    getModel: () => readJson(modelPath, EMPTY_MODEL),
    getQueue: () => readJson(queuePath, EMPTY_QUEUE),
    saveModel: (model) => atomicWrite(modelPath, JSON.stringify(model, null, 2)),
    saveQueue: (queue) => atomicWrite(queuePath, JSON.stringify(queue, null, 2)),
    // test/seam helper: write raw bytes to the model file
    saveModelRaw: (raw) => writeFileSync(modelPath, raw, "utf-8"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test daemon/store.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/store.js daemon/store.test.js
git commit -m "feat(daemon): add store for world model + proposal queue"
```

---

### Task 3: `grouping` — deterministic root-cause keys

**Files:**
- Create: `daemon/grouping.js`
- Create: `daemon/grouping.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/grouping.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCardToken, vendorDomain, groupKey } from "./grouping.js";

describe("extractCardToken", () => {
  it("pulls the last four from 'card ending in 4821'", () => {
    assert.equal(extractCardToken("Your card ending in 4821 was declined"), "card_4821");
  });
  it("pulls the last four from masked forms like ****4821 and x-4821", () => {
    assert.equal(extractCardToken("Card ****4821 expired"), "card_4821");
    assert.equal(extractCardToken("card xxxx4821 on file"), "card_4821");
  });
  it("returns null when there is no card reference", () => {
    assert.equal(extractCardToken("Invoice overdue, please remit"), null);
  });
});

describe("vendorDomain", () => {
  it("returns the domain portion of an address", () => {
    assert.equal(vendorDomain("billing@acme.com"), "acme.com");
  });
  it("returns null for a malformed address", () => {
    assert.equal(vendorDomain("not-an-email"), null);
  });
});

describe("groupKey", () => {
  it("prefers the card token when grouping order is [card, vendorDomain]", () => {
    const email = { from: "billing@acme.com", subject: "card ending in 4821 declined", preview: "" };
    assert.equal(groupKey(email, ["card", "vendorDomain"]), "card_4821");
  });
  it("falls back to vendor domain when no card token is present", () => {
    const email = { from: "billing@acme.com", subject: "payment past due", preview: "" };
    assert.equal(groupKey(email, ["card", "vendorDomain"]), "vendor:acme.com");
  });
  it("returns a stable fallback when nothing matches", () => {
    const email = { from: "bad", subject: "", preview: "" };
    assert.equal(groupKey(email, ["card", "vendorDomain"]), "ungrouped");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test daemon/grouping.test.js`
Expected: FAIL — cannot find module `./grouping.js`.

- [ ] **Step 3: Write minimal implementation**

Create `daemon/grouping.js`:

```js
/**
 * grouping.js — deterministic root-cause grouping keys for owed_risk items.
 * Deterministic-first per the design; the reasoner fallback for stragglers
 * is added in a later plan and only runs on emails that return "ungrouped".
 */

const CARD_RX = /(?:card|ending|acct|account)\D{0,12}(\d{4})\b/i;

export function extractCardToken(text) {
  if (!text) return null;
  const m = String(text).match(CARD_RX);
  return m ? `card_${m[1]}` : null;
}

export function vendorDomain(from) {
  if (!from || typeof from !== "string") return null;
  const at = from.lastIndexOf("@");
  if (at < 0) return null;
  const domain = from.slice(at + 1).trim().toLowerCase();
  return domain.includes(".") ? domain : null;
}

/**
 * Resolve the first grouping rule that produces a key, in config order.
 * @param {object} email  { from, subject, preview }
 * @param {string[]} order  e.g. ["card", "vendorDomain"]
 */
export function groupKey(email, order) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  for (const rule of order) {
    if (rule === "card") {
      const t = extractCardToken(text);
      if (t) return t;
    } else if (rule === "vendorDomain") {
      const d = vendorDomain(email.from);
      if (d) return `vendor:${d}`;
    }
  }
  return "ungrouped";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test daemon/grouping.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/grouping.js daemon/grouping.test.js
git commit -m "feat(daemon): deterministic root-cause grouping keys"
```

---

### Task 4: `normalizers/owed-risk` — classified emails → grouped items

**Files:**
- Create: `daemon/normalizers/owed-risk.js`
- Create: `daemon/normalizers/owed-risk.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/owed-risk.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeOwedRisk } from "./owed-risk.js";

const rules = {
  failureSignals: ["payment failed", "was declined", "past due"],
  grouping: { order: ["card", "vendorDomain"] },
  threshold: { atRiskMembers: 1 },
};
const account = { id: "brickell", links: { billing_portal: "https://pay.example/portal" } };

const emails = [
  { id: "e1", from: "billing@acme.com", fromName: "Acme", subject: "Payment failed — card ending in 4821", preview: "" },
  { id: "e2", from: "ar@globex.com", fromName: "Globex", subject: "Your card ending in 4821 was declined", preview: "" },
  { id: "e3", from: "ar@initech.com", fromName: "Initech", subject: "Invoice past due", preview: "" },
  { id: "e4", from: "newsletter@acme.com", fromName: "Acme", subject: "Spring sale!", preview: "deals inside" },
];

describe("normalizeOwedRisk", () => {
  it("keeps only payment-failure emails (drops the newsletter)", () => {
    const items = normalizeOwedRisk(emails, account, rules);
    const ids = items.flatMap(i => i.group.members.map(m => m.emailId));
    assert.ok(!ids.includes("e4"));
  });

  it("groups the two card-4821 failures into one item with a root cause", () => {
    const items = normalizeOwedRisk(emails, account, rules);
    const card = items.find(i => i.group.rootCause === "card_4821");
    assert.ok(card, "expected a card_4821 group");
    assert.equal(card.group.members.length, 2);
    assert.match(card.title, /2 failed payments/);
    assert.equal(card.status, "at_risk");
  });

  it("emits stable ids and the configured proposed actions + portal source", () => {
    const items = normalizeOwedRisk(emails, account, rules);
    const card = items.find(i => i.group.rootCause === "card_4821");
    assert.equal(card.id, "brickell:owed_risk:card_4821");
    assert.deepEqual(card.proposedActions, ["draft_chase", "route:billing_portal"]);
    assert.ok(card.source.some(s => s.kind === "url" && s.url === "https://pay.example/portal"));
    assert.ok(card.source.some(s => s.kind === "thread" && s.emailId === "e1"));
  });

  it("returns [] when no emails match", () => {
    assert.deepEqual(normalizeOwedRisk([emails[3]], account, rules), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test daemon/normalizers/owed-risk.test.js`
Expected: FAIL — cannot find module `./owed-risk.js`.

- [ ] **Step 3: Write minimal implementation**

Create `daemon/normalizers/owed-risk.js`:

```js
/**
 * normalizers/owed-risk.js — pure transform from classified emails to
 * grouped owed_risk items. Deterministic-only in this plan.
 */
import { groupKey } from "../grouping.js";

function isPaymentFailure(email, failureSignals) {
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();
  return failureSignals.some(sig => text.includes(sig.toLowerCase()));
}

/**
 * @param {object[]} emails  flat list of classified emails for one account
 * @param {object} account   { id, links }
 * @param {object} rules     account-type jobTypes.owed_risk config
 * @returns {object[]} items
 */
export function normalizeOwedRisk(emails, account, rules) {
  const failures = emails.filter(e => isPaymentFailure(e, rules.failureSignals));
  const order = rules.grouping?.order || ["card", "vendorDomain"];
  const groups = new Map();
  for (const e of failures) {
    const key = groupKey(e, order);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const portal = account.links?.billing_portal || null;
  const atRiskMin = rules.threshold?.atRiskMembers ?? 1;
  const items = [];
  for (const [rootCause, members] of groups) {
    const n = members.length;
    const source = members.map(m => ({ kind: "thread", emailId: m.id }));
    if (portal) source.push({ kind: "url", url: portal });
    items.push({
      id: `${account.id}:owed_risk:${rootCause}`,
      jobType: "owed_risk",
      account: account.id,
      title: `${n} failed payment${n === 1 ? "" : "s"}${n > 1 ? " — one root cause" : ""}`,
      status: n >= atRiskMin ? "at_risk" : "ok",
      group: {
        rootCause,
        members: members.map(m => ({ vendor: m.fromName || m.from, from: m.from, subject: m.subject, emailId: m.id })),
      },
      source,
      proposedActions: portal ? ["draft_chase", "route:billing_portal"] : ["draft_chase"],
      lastChanged: null, // stamped by the scheduler on a real diff
    });
  }
  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test daemon/normalizers/owed-risk.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/owed-risk.js daemon/normalizers/owed-risk.test.js
git commit -m "feat(daemon): owed_risk normalizer with deterministic grouping"
```

---

### Task 5: `proposals` — staging + lifecycle state machine

**Files:**
- Create: `daemon/proposals.js`
- Create: `daemon/proposals.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/proposals.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChaseDrafts, stageProposals, transition } from "./proposals.js";

const account = { id: "brickell" };
const item = {
  id: "brickell:owed_risk:card_4821",
  account: "brickell",
  proposedActions: ["draft_chase", "route:billing_portal"],
  group: { rootCause: "card_4821", members: [
    { vendor: "Acme", from: "billing@acme.com", subject: "Payment failed", emailId: "e1" },
    { vendor: "Globex", from: "ar@globex.com", subject: "Declined", emailId: "e2" },
  ] },
};

describe("buildChaseDrafts", () => {
  it("creates one draft per member, addressed to the vendor, never marked sent", () => {
    const drafts = buildChaseDrafts(item, account);
    assert.equal(drafts.length, 2);
    assert.deepEqual(drafts[0].to, ["billing@acme.com"]);
    assert.equal(drafts[0].replyToMessageId, "e1");
    assert.match(drafts[0].body, /card_4821|card ending/i);
  });
});

describe("stageProposals", () => {
  it("creates a pending draft_chase proposal for a new item", () => {
    const { proposals } = stageProposals([item], { proposals: [] }, account);
    const p = proposals.find(x => x.action === "draft_chase");
    assert.ok(p);
    assert.equal(p.id, "brickell:owed_risk:card_4821::draft_chase");
    assert.equal(p.state, "pending");
    assert.equal(p.preview.drafts.length, 2);
  });
  it("is idempotent — does not duplicate or reset an existing proposal", () => {
    const first = stageProposals([item], { proposals: [] }, account);
    first.proposals[0].state = "executed";
    const second = stageProposals([item], first, account);
    const draftProps = second.proposals.filter(p => p.action === "draft_chase");
    assert.equal(draftProps.length, 1);
    assert.equal(draftProps[0].state, "executed"); // preserved
  });
});

describe("transition", () => {
  it("pending -> approved -> executed", () => {
    const p = { state: "pending" };
    assert.equal(transition(p, "approve").state, "approved");
    assert.equal(transition({ state: "approved" }, "executed").state, "executed");
  });
  it("pending -> dismissed and pending -> snoozed", () => {
    assert.equal(transition({ state: "pending" }, "dismiss").state, "dismissed");
    assert.equal(transition({ state: "pending" }, "snooze").state, "snoozed");
  });
  it("rejects an invalid transition", () => {
    assert.throws(() => transition({ state: "executed" }, "approve"), /invalid transition/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test daemon/proposals.test.js`
Expected: FAIL — cannot find module `./proposals.js`.

- [ ] **Step 3: Write minimal implementation**

Create `daemon/proposals.js`:

```js
/**
 * proposals.js — stage proposals from items and own their lifecycle.
 * Rails note: draft_chase proposals only ever describe DRAFTS. Nothing here
 * sends mail; execution is delegated to executors, which enforce the rails.
 */

const TRANSITIONS = {
  pending: { approve: "approved", dismiss: "dismissed", snooze: "snoozed" },
  approved: { executed: "executed", failed: "failed" },
  snoozed: { approve: "approved", dismiss: "dismissed" },
};

export function transition(proposal, event) {
  const next = TRANSITIONS[proposal.state]?.[event];
  if (!next) throw new Error(`invalid transition: ${proposal.state} --${event}-->`);
  return { ...proposal, state: next };
}

export function buildChaseDrafts(item, account) {
  const cause = item.group.rootCause;
  return item.group.members.map(m => ({
    to: [m.from],
    subject: `Re: ${m.subject || "Payment on file"}`,
    body:
      `Hi ${m.vendor || "team"},\n\n` +
      `We saw the recent payment issue on our account (${cause}). ` +
      `We're correcting the payment method on file and will re-run the charge. ` +
      `Please hold any service interruption while we resolve this.\n\n` +
      `Thank you,\n${account.id}`,
    replyToMessageId: m.emailId,
  }));
}

/**
 * Add a pending draft_chase proposal for any item that has the action and no
 * existing proposal. Existing proposals (any state) are preserved untouched.
 */
export function stageProposals(items, queue, account) {
  const existing = new Map((queue.proposals || []).map(p => [p.id, p]));
  for (const item of items) {
    if (!item.proposedActions?.includes("draft_chase")) continue;
    const id = `${item.id}::draft_chase`;
    if (existing.has(id)) continue;
    const drafts = buildChaseDrafts(item, account);
    existing.set(id, {
      id,
      itemId: item.id,
      action: "draft_chase",
      params: { account: account.id, drafts },
      preview: { summary: item.title, drafts },
      state: "pending",
    });
  }
  return { proposals: [...existing.values()] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test daemon/proposals.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/proposals.js daemon/proposals.test.js
git commit -m "feat(daemon): proposal staging + lifecycle state machine"
```

---

### Task 6: `executors` — the thin action seam (route + draft_chase)

**Files:**
- Create: `daemon/executors/route.js`
- Create: `daemon/executors/draft-chase.js`
- Create: `daemon/executors/index.js`
- Create: `daemon/executors/executors.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/executors/executors.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveExecutor } from "./index.js";

const account = { id: "brickell", links: { billing_portal: "https://pay.example/portal" } };

describe("route executor", () => {
  it("resolves route:billing_portal to the account's portal URL", async () => {
    const exec = resolveExecutor("route:billing_portal");
    const out = await exec({ itemId: "x", action: "route:billing_portal" }, { account });
    assert.deepEqual(out, { kind: "route", url: "https://pay.example/portal" });
  });
  it("throws a clear error when the link is not configured", async () => {
    const exec = resolveExecutor("route:billing_portal");
    await assert.rejects(() => exec({ action: "route:billing_portal" }, { account: { id: "x", links: {} } }), /not configured/i);
  });
});

describe("draft_chase executor", () => {
  it("creates one draft via the injected saveDraftFn and returns ids", async () => {
    const saved = [];
    const saveDraftFn = async (acct, draft) => { saved.push([acct, draft]); return { draftId: `d${saved.length}` }; };
    const exec = resolveExecutor("draft_chase");
    const proposal = { params: { account: "brickell", drafts: [
      { to: ["a@x.com"], subject: "s", body: "b", replyToMessageId: "e1" },
    ] } };
    const out = await exec(proposal, { account, saveDraftFn });
    assert.equal(out.kind, "execute");
    assert.deepEqual(out.result.draftIds, ["d1"]);
    assert.equal(saved[0][0], "brickell");
  });
});

describe("resolveExecutor", () => {
  it("throws on an unknown action", () => {
    assert.throws(() => resolveExecutor("nope"), /unknown action/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test daemon/executors/executors.test.js`
Expected: FAIL — cannot find module `./index.js`.

- [ ] **Step 3: Write minimal implementation**

Create `daemon/executors/route.js`:

```js
/**
 * route.js — "route:<linkName>" executor. Returns a URL to the system of
 * record. The cheapest handler; escalating to a real API call later means
 * swapping this for an execute-kind executor without touching the surface.
 */
export function routeExecutor(linkName) {
  return async (proposal, ctx) => {
    const url = ctx.account?.links?.[linkName];
    if (!url) throw new Error(`route target not configured: links.${linkName} for ${ctx.account?.id}`);
    return { kind: "route", url };
  };
}
```

Create `daemon/executors/draft-chase.js`:

```js
/**
 * draft-chase.js — creates DRAFT emails only. RAILS: this executor must never
 * send mail and never delete mail. It delegates to an injected saveDraftFn
 * (wired to scripts/save-draft.js in daemon.js), which writes to a Drafts
 * folder. Sending remains the user's manual action in their mail client.
 */
export async function draftChaseExecutor(proposal, ctx) {
  const { account, saveDraftFn } = ctx;
  const drafts = proposal.params?.drafts || [];
  const draftIds = [];
  for (const draft of drafts) {
    const { draftId } = await saveDraftFn(account.id, draft);
    draftIds.push(draftId);
  }
  return { kind: "execute", result: { draftIds } };
}
```

Create `daemon/executors/index.js`:

```js
/**
 * index.js — executor registry. Maps an action name to an executor function.
 * Action names are either exact ("draft_chase") or "route:<linkName>".
 */
import { routeExecutor } from "./route.js";
import { draftChaseExecutor } from "./draft-chase.js";

export function resolveExecutor(action) {
  if (action === "draft_chase") return draftChaseExecutor;
  if (action.startsWith("route:")) return routeExecutor(action.slice("route:".length));
  throw new Error(`unknown action: ${action}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test daemon/executors/executors.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/executors/route.js daemon/executors/draft-chase.js daemon/executors/index.js daemon/executors/executors.test.js
git commit -m "feat(daemon): executor registry (route + draft_chase)"
```

---

### Task 7: Executor rails guard — make the safety invariant build-failing

**Files:**
- Create: `daemon/executors/rails-guard.test.js`

- [ ] **Step 1: Write the failing test**

This test scans every executor source file for forbidden API tokens (send / permanent-delete). It will FAIL first because we deliberately seed a violation, proving the guard has teeth, then PASS once removed.

Create `daemon/executors/rails-guard.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Forbidden by the non-negotiable rails: never auto-send, soft-delete only.
const FORBIDDEN = [
  /\bsendMail\b/i,            // Graph send
  /\/sendMail\b/i,
  /messages\.send\b/i,        // Gmail send
  /\.send\s*\(/,             // generic send(
  /messages\.delete\b/i,      // Gmail permanent delete
  /messages\.batchDelete\b/i,
  /\bbatchDelete\b/i,
];

function executorFiles() {
  return readdirSync(here)
    .filter(f => f.endsWith(".js") && !f.endsWith(".test.js"));
}

describe("executor rails guard", () => {
  it("no executor references a send or permanent-delete API", () => {
    const violations = [];
    for (const f of executorFiles()) {
      const src = readFileSync(join(here, f), "utf-8");
      for (const rx of FORBIDDEN) {
        if (rx.test(src)) violations.push(`${f} matches ${rx}`);
      }
    }
    assert.deepEqual(violations, [], `rails violations:\n${violations.join("\n")}`);
  });
});
```

- [ ] **Step 2: Seed a violation and run to verify the guard fails**

Temporarily add this line to the top of `daemon/executors/route.js` (a fake violation):

```js
// TEMP rails-guard check: sendMail
```

Run: `node --test daemon/executors/rails-guard.test.js`
Expected: FAIL — `route.js matches /\bsendMail\b/i`.

- [ ] **Step 3: Remove the seeded violation**

Delete the `// TEMP rails-guard check: sendMail` line from `daemon/executors/route.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test daemon/executors/rails-guard.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add daemon/executors/rails-guard.test.js
git commit -m "test(daemon): build-failing rails guard over executors"
```

---

### Task 8: `api` — REST + SSE over localhost

**Files:**
- Create: `daemon/api.js`
- Create: `daemon/api.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/api.test.js` (uses port 0 so the OS assigns a free port — avoids Windows reserved-range failures):

```js
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { createApiServer } from "./api.js";

let server, base, dir, store;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "officeos-api-"));
  store = createStore(dir);
  store.saveModel({ generatedAt: "t", accounts: { brickell: { status: "ok", lastTickAt: "t" } }, items: [{ id: "i1", jobType: "owed_risk" }] });
  store.saveQueue({ proposals: [
    { id: "p1", itemId: "i1", action: "route:billing_portal", params: {}, state: "pending" },
    { id: "p2", itemId: "i1", action: "draft_chase", params: {}, state: "pending" },
  ] });
  const accountsById = { brickell: { id: "brickell", links: { billing_portal: "https://pay.example/portal" } } };
  const ctxFor = (proposal) => ({ account: accountsById[proposal.params?.account || "brickell"], saveDraftFn: async () => ({ draftId: "dX" }) });
  server = createApiServer({ store, ctxFor, getLastTickAt: () => "t" });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

describe("GET /health", () => {
  it("returns ok and last tick", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
  });
});

describe("GET /model", () => {
  it("returns merged model + proposals", async () => {
    const body = await (await fetch(`${base}/model`)).json();
    assert.equal(body.items[0].id, "i1");
    assert.equal(body.proposals.length, 2);
  });
});

describe("POST /proposals/:id/approve", () => {
  it("runs the route executor and marks the proposal executed", async () => {
    const res = await fetch(`${base}/proposals/p1/approve`, { method: "POST" });
    const body = await res.json();
    assert.equal(body.result.kind, "route");
    assert.equal(body.result.url, "https://pay.example/portal");
    assert.equal(body.proposal.state, "executed");
    // persisted
    assert.equal(createStore(dir).getQueue().proposals.find(p => p.id === "p1").state, "executed");
  });
});

describe("POST /proposals/:id/dismiss", () => {
  it("marks the proposal dismissed", async () => {
    const body = await (await fetch(`${base}/proposals/p2/dismiss`, { method: "POST" })).json();
    assert.equal(body.proposal.state, "dismissed");
  });
});

describe("unknown route", () => {
  it("404s", async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test daemon/api.test.js`
Expected: FAIL — cannot find module `./api.js`.

- [ ] **Step 3: Write minimal implementation**

Create `daemon/api.js`:

```js
/**
 * api.js — localhost REST + SSE for the daemon. Binds 127.0.0.1 only.
 *
 * Routes:
 *   GET  /health                     -> { ok, lastTickAt }
 *   GET  /model                      -> { ...model, proposals }
 *   GET  /events                     -> SSE stream; emits "update" on tick diffs
 *   POST /proposals/:id/approve      -> transition->approved, run executor, ->executed/failed
 *   POST /proposals/:id/dismiss      -> transition->dismissed
 *
 * Dependencies are injected:
 *   store        createStore(dataDir)
 *   ctxFor(p)    -> executor context { account, saveDraftFn } for a proposal
 *   getLastTickAt() -> ISO string | null
 */
import { createServer } from "node:http";
import { resolveExecutor } from "./executors/index.js";
import { transition } from "./proposals.js";

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function createApiServer(deps) {
  const { store, ctxFor, getLastTickAt } = deps;
  const sseClients = new Set();

  async function approve(id, res) {
    const queue = store.getQueue();
    const proposal = queue.proposals.find(p => p.id === id);
    if (!proposal) return send(res, 404, { error: "proposal not found" });
    let updated;
    try {
      const approved = transition(proposal, "approve");
      const exec = resolveExecutor(approved.action);
      const result = await exec(approved, ctxFor(approved));
      updated = transition(approved, "executed");
      persist(queue, id, updated);
      return send(res, 200, { proposal: updated, result });
    } catch (err) {
      updated = { ...proposal, state: "failed", error: err.message };
      persist(queue, id, updated);
      return send(res, 200, { proposal: updated, error: err.message });
    }
  }

  function dismiss(id, res) {
    const queue = store.getQueue();
    const proposal = queue.proposals.find(p => p.id === id);
    if (!proposal) return send(res, 404, { error: "proposal not found" });
    const updated = transition(proposal, "dismiss");
    persist(queue, id, updated);
    return send(res, 200, { proposal: updated });
  }

  function persist(queue, id, updated) {
    queue.proposals = queue.proposals.map(p => (p.id === id ? updated : p));
    store.saveQueue(queue);
  }

  function broadcast(event) {
    for (const res of sseClients) res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      return send(res, 200, { ok: true, lastTickAt: getLastTickAt?.() ?? null });
    }
    if (req.method === "GET" && path === "/model") {
      const model = store.getModel();
      return send(res, 200, { ...model, proposals: store.getQueue().proposals });
    }
    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    const approveMatch = path.match(/^\/proposals\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) return approve(decodeURIComponent(approveMatch[1]), res);
    const dismissMatch = path.match(/^\/proposals\/([^/]+)\/dismiss$/);
    if (req.method === "POST" && dismissMatch) return dismiss(decodeURIComponent(dismissMatch[1]), res);

    return send(res, 404, { error: "not found" });
  });

  server.broadcastUpdate = (event) => broadcast(event ?? { type: "update" });
  return server;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test daemon/api.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/api.js daemon/api.test.js
git commit -m "feat(daemon): localhost REST + SSE api"
```

---

### Task 9: `scheduler` — one tick (fetch → classify → normalize → stage → diff → persist → emit)

**Files:**
- Create: `daemon/scheduler.js`
- Create: `daemon/scheduler.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/scheduler.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { runTick } from "./scheduler.js";

function tmp() { return mkdtempSync(join(tmpdir(), "officeos-sched-")); }

const account = { id: "brickell", accountType: "business", links: { billing_portal: "https://pay.example/portal" } };
const typeConfigs = { business: { jobTypes: { owed_risk: {
  sourceCategories: ["action"],
  failureSignals: ["payment failed", "was declined"],
  grouping: { order: ["card", "vendorDomain"] },
  threshold: { atRiskMembers: 1 },
} } } };

// classifyFn returns category buckets like the existing classify() does.
const classified = { categories: {
  action: { emails: [
    { id: "e1", from: "billing@acme.com", fromName: "Acme", subject: "Payment failed — card ending in 4821", preview: "" },
    { id: "e2", from: "ar@globex.com", fromName: "Globex", subject: "card ending in 4821 was declined", preview: "" },
  ] },
  fyi: { emails: [{ id: "e9", from: "n@x.com", subject: "hi", preview: "" }] },
} };

function deps(dir, over = {}) {
  return {
    accounts: [account],
    typeConfigs,
    store: createStore(dir),
    fetchFn: async () => [{ id: "e1" }], // raw emails; classifyFn ignores and returns fixture
    classifyFn: () => classified,
    clock: { now: "2026-06-16T12:00:00Z" },
    emit: () => {},
    ...over,
  };
}

describe("runTick", () => {
  it("produces a grouped owed_risk item and a pending proposal, persisted", async () => {
    const dir = tmp();
    try {
      const d = deps(dir);
      await runTick(d);
      const model = d.store.getModel();
      const item = model.items.find(i => i.group.rootCause === "card_4821");
      assert.ok(item);
      assert.equal(item.group.members.length, 2);
      assert.equal(model.accounts.brickell.status, "ok");
      const queue = d.store.getQueue();
      assert.ok(queue.proposals.some(p => p.id === "brickell:owed_risk:card_4821::draft_chase" && p.state === "pending"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("marks an account stale and keeps last-good items when fetch throws", async () => {
    const dir = tmp();
    try {
      await runTick(deps(dir)); // seed a good model
      const d = deps(dir, { fetchFn: async () => { throw new Error("boom"); } });
      const summary = await runTick(d);
      const model = d.store.getModel();
      assert.equal(model.accounts.brickell.status, "stale");
      assert.ok(model.items.length > 0, "last-good items retained");
      assert.ok(summary.warnings.some(w => /boom/.test(w)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("emits an update event only when the model changed", async () => {
    const dir = tmp();
    try {
      const events = [];
      const d = deps(dir, { emit: (e) => events.push(e) });
      await runTick(d);            // first tick: change (empty -> items)
      await runTick(deps(dir, { store: d.store, emit: (e) => events.push(e) })); // identical -> no change
      assert.equal(events.length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test daemon/scheduler.test.js`
Expected: FAIL — cannot find module `./scheduler.js`.

- [ ] **Step 3: Write minimal implementation**

Create `daemon/scheduler.js`:

```js
/**
 * scheduler.js — one daemon tick. Pure orchestration over injected deps so it
 * tests without real connectors (mirrors scripts/morning-brief.js).
 *
 * deps: { accounts, typeConfigs, store, fetchFn(accountId), classifyFn(emails, account),
 *         clock:{now}, emit(event) }
 */
import { normalizeOwedRisk } from "./normalizers/owed-risk.js";
import { stageProposals } from "./proposals.js";

function flattenSourceEmails(classified, sourceCategories) {
  const out = [];
  for (const cat of sourceCategories) {
    const bucket = classified.categories?.[cat];
    if (bucket?.emails) out.push(...bucket.emails);
  }
  return out;
}

export async function runTick(deps) {
  const { accounts, typeConfigs, store, fetchFn, classifyFn, clock, emit } = deps;
  const prev = store.getModel();
  const prevItemsById = new Map(prev.items.map(i => [i.id, i]));
  const accountsState = { ...prev.accounts };
  const warnings = [];
  let nextItems = [];

  for (const account of accounts) {
    const jobRules = typeConfigs[account.accountType]?.jobTypes?.owed_risk;
    if (!jobRules) continue;
    let emails;
    try {
      emails = await fetchFn(account.id);
    } catch (err) {
      warnings.push(`[${account.id}] fetch failed: ${err.message}`);
      accountsState[account.id] = { status: "stale", lastTickAt: clock.now };
      // retain last-good items for this account
      nextItems.push(...prev.items.filter(i => i.account === account.id));
      continue;
    }
    const classified = classifyFn(emails, account);
    const sourceEmails = flattenSourceEmails(classified, jobRules.sourceCategories);
    const items = normalizeOwedRisk(sourceEmails, account, jobRules);
    // stamp lastChanged: keep prior timestamp if the item is unchanged
    for (const item of items) {
      const before = prevItemsById.get(item.id);
      const sameShape = before && JSON.stringify({ ...before, lastChanged: null }) === JSON.stringify({ ...item, lastChanged: null });
      item.lastChanged = sameShape ? before.lastChanged : clock.now;
    }
    nextItems.push(...items);
    accountsState[account.id] = { status: "ok", lastTickAt: clock.now };
  }

  const nextModel = { generatedAt: clock.now, accounts: accountsState, items: nextItems };

  // stage proposals for all items (per their account)
  let queue = store.getQueue();
  for (const account of accounts) {
    const accountItems = nextItems.filter(i => i.account === account.id);
    queue = stageProposals(accountItems, queue, account);
  }

  // diff: compare item sets ignoring lastChanged timestamps
  const norm = (m) => JSON.stringify(m.items.map(i => ({ ...i, lastChanged: null })));
  const changed = norm(prev) !== norm(nextModel);

  store.saveModel(nextModel);
  store.saveQueue(queue);
  if (changed) emit({ type: "update", at: clock.now });

  return { changed, warnings, itemCount: nextItems.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test daemon/scheduler.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/scheduler.js daemon/scheduler.test.js
git commit -m "feat(daemon): scheduler tick with diff-gated emit + stale handling"
```

---

### Task 10: `daemon.js` — wire real connectors and start the service

**Files:**
- Create: `daemon/daemon.js`
- Create: `daemon/wiring.js`
- Create: `daemon/wiring.test.js`

The testable wiring helpers live in `wiring.js`; `daemon.js` is the thin CLI entrypoint that calls them. This keeps the process-spawning glue separate from the startup logic we can assert on.

- [ ] **Step 1: Write the failing test**

Create `daemon/wiring.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCtxFor, resolvePollMs } from "./wiring.js";

const companies = { companies: [
  { id: "brickell", provider: "outlook", links: { billing_portal: "https://pay.example/portal" }, pollMinutes: 10 },
  { id: "personal", provider: "gmail" },
] };

describe("resolvePollMs", () => {
  it("uses per-account pollMinutes when present", () => {
    assert.equal(resolvePollMs(companies.companies[0], 15), 10 * 60 * 1000);
  });
  it("falls back to the default when absent", () => {
    assert.equal(resolvePollMs(companies.companies[1], 15), 15 * 60 * 1000);
  });
});

describe("buildCtxFor", () => {
  it("returns the account and a saveDraftFn for a proposal's account", () => {
    const saveDraftFn = async () => ({ draftId: "d1" });
    const ctxFor = buildCtxFor(companies.companies, () => saveDraftFn);
    const ctx = ctxFor({ params: { account: "brickell" } });
    assert.equal(ctx.account.id, "brickell");
    assert.equal(typeof ctx.saveDraftFn, "function");
  });
  it("throws for an unknown account", () => {
    const ctxFor = buildCtxFor(companies.companies, () => async () => ({}));
    assert.throws(() => ctxFor({ params: { account: "ghost" } }), /unknown account/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test daemon/wiring.test.js`
Expected: FAIL — cannot find module `./wiring.js`.

- [ ] **Step 3: Write minimal implementation**

Create `daemon/wiring.js`:

```js
/**
 * wiring.js — pure helpers that translate on-disk config into the injected
 * dependencies the daemon needs. Kept separate from daemon.js so they test
 * without spawning subprocesses.
 */
export function resolvePollMs(account, defaultMinutes) {
  const mins = Number.isFinite(account.pollMinutes) ? account.pollMinutes : defaultMinutes;
  return mins * 60 * 1000;
}

/**
 * @param {object[]} accounts            companies[].
 * @param {(account)=>Function} makeSaveDraftFn  factory returning a saveDraftFn(accountId, draft) for an account
 */
export function buildCtxFor(accounts, makeSaveDraftFn) {
  const byId = new Map(accounts.map(a => [a.id, a]));
  return (proposal) => {
    const id = proposal.params?.account;
    const account = byId.get(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    return { account, saveDraftFn: makeSaveDraftFn(account) };
  };
}
```

Create `daemon/daemon.js` (CLI entrypoint — not unit-tested; verified by the smoke run in Step 4):

```js
/**
 * daemon.js — OfficeOS daemon entrypoint. Wires real connectors (subprocess
 * fetch/classify/save-draft, same pattern as scripts/morning-brief.js),
 * starts the localhost API, and schedules ticks. Binds 127.0.0.1 only.
 *
 * Usage: node daemon/daemon.js [--port 8138] [--once]
 *   --once   run a single tick, print summary, and exit (no server)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createStore } from "./store.js";
import { createApiServer } from "./api.js";
import { runTick } from "./scheduler.js";
import { buildCtxFor, resolvePollMs } from "./wiring.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 8138;
const DEFAULT_POLL_MINUTES = 15;

function loadConfig() {
  const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
  const accountTypes = JSON.parse(readFileSync(join(root, "config/account-types.json"), "utf-8"));
  return { companies, accountTypes };
}

function fetchSubprocess(accountId) {
  const { companies } = loadConfig();
  const account = companies.companies.find(c => c.id === accountId);
  const script = account.provider === "gmail" ? "fetch-gmail.js" : "fetch-emails.js";
  // owed_risk scans a wide window; 168h (7d) is a reasonable default for failed-payment recency.
  const child = spawnSync("node", [join(root, "scripts", script), accountId, "168", "inbox"], {
    encoding: "utf-8", maxBuffer: 50 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr || `fetch failed for ${accountId}`);
  return JSON.parse(child.stdout);
}

function makeSaveDraftFn(account) {
  // Gmail vs Outlook draft scripts mirror the morning-brief delete dispatch.
  const script = account.provider === "gmail" ? "save-gmail-draft.js" : "save-draft.js";
  return async (accountId, draft) => {
    const child = spawnSync("node", [join(root, "scripts", script), accountId], {
      input: JSON.stringify(draft), encoding: "utf-8",
    });
    if (child.status !== 0) throw new Error(child.stderr || `save-draft failed for ${accountId}`);
    return JSON.parse(child.stdout);
  };
}

async function main() {
  const args = process.argv.slice(2);
  const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : DEFAULT_PORT;
  const once = args.includes("--once");

  const { companies, accountTypes } = loadConfig();
  const store = createStore(join(root, "data"));
  let lastTickAt = null;

  const { classify } = await import("../scripts/classify-emails.js");
  const deps = (emit) => ({
    accounts: companies.companies,
    typeConfigs: accountTypes,
    store,
    fetchFn: async (accountId) => fetchSubprocess(accountId),
    classifyFn: (emails, account) => classify(emails, account.id),
    clock: { now: new Date().toISOString() },
    emit,
  });

  if (once) {
    const summary = await runTick(deps(() => {}));
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

  const ctxFor = buildCtxFor(companies.companies, makeSaveDraftFn);
  const server = createApiServer({ store, ctxFor, getLastTickAt: () => lastTickAt });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(JSON.stringify({ type: "daemon-started", url: `http://localhost:${port}` }) + "\n");
  });

  async function tick() {
    try {
      await runTick(deps((e) => server.broadcastUpdate(e)));
      lastTickAt = new Date().toISOString();
    } catch (err) {
      process.stderr.write(`tick error: ${err.message}\n`);
    }
  }
  await tick(); // immediate first tick
  // Per-account intervals collapse to the smallest configured interval for the shared loop.
  const minMs = Math.min(...companies.companies.map(a => resolvePollMs(a, DEFAULT_POLL_MINUTES)));
  setInterval(tick, minMs);
}

if (process.argv[1] && process.argv[1].endsWith("daemon.js")) {
  main().catch(err => { process.stderr.write(String(err.stack || err) + "\n"); process.exit(1); });
}
```

- [ ] **Step 4: Run the wiring test and a daemon smoke check**

Run: `node --test daemon/wiring.test.js`
Expected: PASS (4 tests).

Run the full suite to confirm nothing regressed:
Run: `npm test`
Expected: all daemon + existing script tests PASS.

Smoke-check the entrypoint parses and the `--once` path is reachable (it will exit non-zero only if `config/companies.json` is absent in this worktree, which is expected for the gitignored config — confirm the error is the missing-config error, not a syntax error):
Run: `node daemon/daemon.js --once`
Expected: either a JSON tick summary (if live config is present) OR a clean `ENOENT ... config/companies.json` error — NOT a SyntaxError/ReferenceError.

- [ ] **Step 5: Commit**

```bash
git add daemon/daemon.js daemon/wiring.js daemon/wiring.test.js
git commit -m "feat(daemon): wire connectors + start server/scheduler"
```

---

### Task 11: Docs — how to run the daemon

**Files:**
- Create: `daemon/README.md`

- [ ] **Step 1: Write the README**

Create `daemon/README.md`:

```markdown
# OfficeOS daemon (Ambient Proposal Panel — core)

Always-on local service that turns the email pipeline into a live world model +
staged proposal queue, served over `localhost`. Headless in this milestone
(REST/SSE only; the web panel and toasts come in later plans).

## Run

```bash
node daemon/daemon.js            # start server on http://localhost:8138 + schedule ticks
node daemon/daemon.js --port 9000
node daemon/daemon.js --once     # run one tick, print summary, exit
```

## API (binds 127.0.0.1 only)

- `GET  /health` — `{ ok, lastTickAt }`
- `GET  /model` — world model + proposals
- `GET  /events` — SSE; emits `{type:"update"}` when a tick changes the model
- `POST /proposals/:id/approve` — approve + execute (route → URL, draft_chase → drafts)
- `POST /proposals/:id/dismiss` — dismiss

## Config

- `config/account-types.json` → `<type>.jobTypes.owed_risk` (detection signals, grouping order, threshold)
- `config/companies.json` → per account: `links.billing_portal`, optional `pollMinutes`

## Safety rails (enforced by `daemon/executors/rails-guard.test.js`)

Executors never send mail and never permanently delete. Drafts only; soft-delete only.
The guard test fails the build if any executor references a send or permanent-delete API.

## Test

```bash
npm test
```
```

- [ ] **Step 2: Commit**

```bash
git add daemon/README.md
git commit -m "docs(daemon): how to run the core daemon"
```

---

## Self-Review (completed during authoring)

**Spec coverage:** §4 architecture → Tasks 2–10. §5 components: `store` (T2), `normalizer`+`grouping` (T3–T4), `proposals` (T5), `executors/*` (T6), `api` (T8), `scheduler` (T9), `notifier` → **deferred to Plan 2** (stated in Scope). `web/` → **Plan 2**. §6 data model → "Canonical data shapes" + T2/T4/T5. §7 data flow → T9. §8 deterministic-first grouping → T3–T4; reasoner fallback → **Plan 3** (stated). §9 liveness (poll interval, persist, diff-gated emit) → T9 + T10. §10 error handling (stale account, executor failure→`failed`) → T9 + T8. §11 rails → T6 + T7. §12 testing → every task is TDD; executor guard → T7. §13 repo impact → T1 (config), all tasks (daemon/), README T11.

**Placeholder scan:** no TBD/TODO/"handle appropriately"; every code step contains complete code; every command has expected output.

**Type consistency:** `Item`/`Proposal`/executor-return/world-model/queue shapes are defined once in "Canonical data shapes" and used identically in T2, T4, T5, T6, T8, T9. `resolveExecutor`, `transition`, `stageProposals`, `buildChaseDrafts`, `normalizeOwedRisk`, `createStore`, `createApiServer`, `runTick`, `buildCtxFor`, `resolvePollMs` names match across definition and call sites.

**Out-of-scope confirmed deferred:** notifier/toasts + web (Plan 2); other job-types + reasoner fallback (Plan 3).
```
