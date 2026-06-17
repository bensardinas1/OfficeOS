# Ambient Proposal Panel — `audit` job (Secureframe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `audit` job-type — compliance fieldwork driven by Secureframe — as a registry normalizer: one item per test, surfacing auditor "Action required" / "new comment (upload)" requests, routing out to Secureframe.

**Architecture:** A pure Secureframe **recognizer** (`recognizeSecureframe(email, cfg) => {testName, subType, url} | null`) composed by `daemon/normalizers/audit.js` (group auditor emails by test → one Item each). Registered in the existing normalizer registry; scheduler/panel/store/api unchanged. Detection is config-driven (`jobTypes.audit`), so it's self-windowing — Secureframe only emails during fieldwork, so outside the window there's simply nothing to surface.

**Tech Stack:** Node.js ESM, `node --test` + `node:assert/strict`. No new dependencies. Builds on Plans 1–4 (registry, canonical Item, scheduler, gateway pattern). Fixtures derive from the real Secureframe `.msg` samples (no secrets committed).

---

## Scope

**In this plan:** the `audit` job for Secureframe — recognizer, normalizer, registry wiring, config, docs. Reuses existing panel rendering (route link from `item.source` URL) and proposals flow (no `draft_chase`, so nothing staged).

**Not in this plan:** the shared `acknowledge` capability (its own next plan); the `exposed` job (after acknowledge). Deep-linking to the exact Secureframe test URL when the link isn't in the email body preview — falls back to the Secureframe app base URL (the user lands in Secureframe; link-out to the system of record, never fabricated).

## Prerequisites / starting state

Plans 1–4 merged. The registry (`daemon/normalizers/index.js`) has an `ADAPTERS` map (`owed_risk`, `handled`, `gateway`) + `flattenSourceEmails` + async `runNormalizers`. Canonical Item shape as in prior plans. The panel renders an "Open" link from the first `source` entry of kind `"url"`. Email objects carry `{id, from, fromName, subject, preview, receivedAt}` (preview is a body snippet).

Secureframe sample facts (real `.msg` files): from `hello@secureframe.com` (envelope `*.secureframe.com`); subjects "Your auditor marked a test as Action required" and "New comment from your auditor"; bodies: "Your auditor manually updated the test Load balancers for cloud infrastructure traffic (Azure) to Action required." and "Your auditor added a new comment on the test Load balancers for cloud infrastructure traffic (Azure). Please upload screenshots / configs…"; each has a "View test in Secureframe" link.

---

### Task 1: Config — declare the `audit` job

**Files:**
- Modify: `config/account-types.example.json` (add `jobTypes.audit` to `business`)
- Modify: `daemon/config.test.js`

- [ ] **Step 1: Add the failing test** — append inside the existing describe block in `daemon/config.test.js`:

```js
  it("business declares an audit job with a secureframe recognizer", () => {
    const cfg = JSON.parse(readFileSync(join(root, "config/account-types.example.json"), "utf-8"));
    const a = cfg.business.jobTypes?.audit;
    assert.ok(a, "business.jobTypes.audit must exist");
    assert.ok(Array.isArray(a.sourceCategories) && a.sourceCategories.length > 0);
    assert.ok(a.recognizers?.secureframe?.senderDomains?.includes("secureframe.com"));
    assert.ok(a.recognizers.secureframe.baseUrl);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/config.test.js`
Expected: FAIL — `business.jobTypes.audit must exist`.

- [ ] **Step 3: Edit `config/account-types.example.json`** — add an `audit` sibling in `business.jobTypes` (after `gateway`, add a comma):

```json
      "gateway": {
        "sourceCategories": ["action"],
        "recognizers": {
          "nmi": {
            "subjectPattern": "\\[NMI Ticket (\\d+)\\]",
            "ticketUrlTemplate": "https://support.nmi.com/hc/requests/{ticket}",
            "issueKeywords": ["Settlement Batch Failure", "Tokenization Error", "Chargeback", "Decline", "Refund"],
            "resolvedMarkers": ["closing this ticket", "ticket has been closed", "has been resolved", "marking this resolved"]
          }
        }
      },
      "audit": {
        "sourceCategories": ["action"],
        "recognizers": {
          "secureframe": {
            "senderDomains": ["secureframe.com"],
            "baseUrl": "https://app.secureframe.com",
            "actionRequiredMarkers": ["action required"],
            "commentMarkers": ["new comment", "added a comment", "added a new comment"],
            "resolvedMarkers": ["ready for review", "marked as passed", "test passed", "no action needed"]
          }
        }
      }
```

(`gateway` block shown for placement context — do not duplicate it; only add the `audit` sibling.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/config.test.js`
Expected: PASS. Then `npm test` → no JSON regression.

- [ ] **Step 5: Commit**

```bash
git add config/account-types.example.json daemon/config.test.js
git commit -m "chore(daemon): declare the audit job + secureframe recognizer config"
```

(Operator note: add the same `jobTypes.audit` block to the live `config/account-types.json`.)

---

### Task 2: Secureframe recognizer (pure)

**Files:**
- Create: `daemon/normalizers/audit/secureframe.js`
- Create: `daemon/normalizers/audit/secureframe.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/audit/secureframe.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizeSecureframe } from "./secureframe.js";

const cfg = {
  senderDomains: ["secureframe.com"],
  baseUrl: "https://app.secureframe.com",
  actionRequiredMarkers: ["action required"],
  commentMarkers: ["new comment", "added a new comment"],
  resolvedMarkers: ["ready for review", "test passed"],
};

describe("recognizeSecureframe", () => {
  it("recognizes an action-required email and extracts the test name", () => {
    const r = recognizeSecureframe({
      from: "hello@secureframe.com",
      subject: "Your auditor marked a test as Action required",
      preview: "Your auditor manually updated the test Load balancers for cloud infrastructure traffic (Azure) to Action required. Please review.",
    }, cfg);
    assert.equal(r.subType, "action_required");
    assert.equal(r.testName, "Load balancers for cloud infrastructure traffic (Azure)");
    assert.equal(r.url, "https://app.secureframe.com");
  });

  it("recognizes a comment/upload request", () => {
    const r = recognizeSecureframe({
      from: "hello@secureframe.com",
      subject: "New comment from your auditor",
      preview: "Your auditor added a new comment on the test Load balancers for cloud infrastructure traffic (Azure). Please upload screenshots / configs.",
    }, cfg);
    assert.equal(r.subType, "comment");
    assert.equal(r.testName, "Load balancers for cloud infrastructure traffic (Azure)");
  });

  it("prefers a secureframe URL from the body when present", () => {
    const r = recognizeSecureframe({
      from: "hello@secureframe.com",
      subject: "Your auditor marked a test as Action required",
      preview: "updated the test Foo to Action required. View test: https://app.secureframe.com/tests/abc123",
    }, cfg);
    assert.equal(r.url, "https://app.secureframe.com/tests/abc123");
  });

  it("returns null for a non-Secureframe email", () => {
    assert.equal(recognizeSecureframe({ from: "ar@globex.com", subject: "hi", preview: "" }, cfg), null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/audit/secureframe.test.js`
Expected: FAIL — cannot find module `./secureframe.js`.

- [ ] **Step 3: Implement `daemon/normalizers/audit/secureframe.js`**

```js
/**
 * normalizers/audit/secureframe.js — pure recognizer for Secureframe auditor
 * emails. Detection is by sender domain; the test name comes from the body
 * preview ("...the test <name> to Action required." / "on the test <name>.").
 * Returns null for non-Secureframe mail.
 */
function senderMatches(from, domains) {
  const f = (from || "").toLowerCase();
  return (domains || []).some(d => f.endsWith("@" + d.toLowerCase()) || f.endsWith("." + d.toLowerCase()));
}

function anyMarker(text, markers) {
  const t = text.toLowerCase();
  return (markers || []).some(m => t.includes(m.toLowerCase()));
}

export function recognizeSecureframe(email, cfg) {
  if (!senderMatches(email.from, cfg.senderDomains)) return null;
  const text = `${email.subject || ""} ${email.preview || ""}`;
  const nameMatch = (email.preview || "").match(/\bthe test\s+(.+?)(?:\s+to\s+Action required\b|\s*\.|\s*$)/i);
  const testName = nameMatch ? nameMatch[1].trim() : "Secureframe test";
  let subType = "update";
  if (anyMarker(text, cfg.actionRequiredMarkers)) subType = "action_required";
  else if (anyMarker(text, cfg.commentMarkers)) subType = "comment";
  else if (anyMarker(text, cfg.resolvedMarkers)) subType = "resolved";
  const urlMatch = (email.preview || "").match(/https?:\/\/\S*secureframe\.com\S*/i);
  const url = urlMatch ? urlMatch[0].replace(/[).,]+$/, "") : cfg.baseUrl;
  return { testName, subType, url };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/audit/secureframe.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/audit/secureframe.js daemon/normalizers/audit/secureframe.test.js
git commit -m "feat(daemon): Secureframe auditor recognizer (pure)"
```

---

### Task 3: `normalizers/audit` — group auditor emails by test → items

**Files:**
- Create: `daemon/normalizers/audit.js`
- Create: `daemon/normalizers/audit.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/audit.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAudit } from "./audit.js";

const account = { id: "brickell" };
const rules = { recognizers: { secureframe: {
  senderDomains: ["secureframe.com"], baseUrl: "https://app.secureframe.com",
  actionRequiredMarkers: ["action required"], commentMarkers: ["new comment", "added a new comment"],
  resolvedMarkers: ["ready for review"],
} } };

const emails = [
  { id: "a", from: "hello@secureframe.com", subject: "Your auditor marked a test as Action required",
    preview: "Your auditor manually updated the test Load balancers for cloud infrastructure traffic (Azure) to Action required.", receivedAt: "2026-06-15T00:00:00Z" },
  { id: "b", from: "hello@secureframe.com", subject: "New comment from your auditor",
    preview: "Your auditor added a new comment on the test Load balancers for cloud infrastructure traffic (Azure). Please upload screenshots.", receivedAt: "2026-06-16T00:00:00Z" },
  { id: "c", from: "ar@globex.com", subject: "unrelated", preview: "nothing", receivedAt: "2026-06-16T00:00:00Z" },
];

describe("normalizeAudit", () => {
  it("groups both auditor emails for one test into a single at_risk item", () => {
    const items = normalizeAudit(emails, account, rules);
    assert.equal(items.length, 1);
    const it0 = items[0];
    assert.equal(it0.jobType, "audit");
    assert.equal(it0.status, "at_risk");
    assert.match(it0.id, /^brickell:audit:/);
    assert.match(it0.title, /Load balancers/);
    assert.equal(it0.group.members.length, 2);
    assert.ok(it0.source.some(s => s.kind === "url" && /secureframe\.com/.test(s.url)));
  });

  it("returns [] when there are no Secureframe emails", () => {
    assert.deepEqual(normalizeAudit([emails[2]], account, rules), []);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/audit.test.js`
Expected: FAIL — cannot find module `./audit.js`.

- [ ] **Step 3: Implement `daemon/normalizers/audit.js`**

```js
/**
 * normalizers/audit.js — pure transform from classified emails to grouped audit
 * items (compliance fieldwork). v1 recognizer: Secureframe, grouped by test.
 * An item is at_risk when any of its emails requests action/comment; resolved
 * markers (and only resolved markers) make it ok.
 */
import { recognizeSecureframe } from "./audit/secureframe.js";

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "test";
}

export function normalizeAudit(emails, account, rules) {
  const sfCfg = rules.recognizers?.secureframe;
  if (!sfCfg) return [];
  const groups = new Map(); // testName -> { recs:[], members:[] }
  for (const e of emails) {
    const rec = recognizeSecureframe(e, sfCfg);
    if (!rec) continue;
    if (!groups.has(rec.testName)) groups.set(rec.testName, { recs: [], members: [] });
    const g = groups.get(rec.testName);
    g.recs.push(rec);
    g.members.push(e);
  }

  const items = [];
  for (const [testName, { recs, members }] of groups) {
    const needsAction = recs.some(r => r.subType === "action_required" || r.subType === "comment");
    const allResolved = recs.every(r => r.subType === "resolved");
    const status = needsAction || !allResolved ? "at_risk" : "ok";
    const what = recs.some(r => r.subType === "comment") ? "comment: upload requested"
      : recs.some(r => r.subType === "action_required") ? "action required" : "update";
    const url = recs.map(r => r.url).find(u => /\/tests?\//.test(u)) || recs[0].url;
    items.push({
      id: `${account.id}:audit:${slug(testName)}`,
      jobType: "audit",
      account: account.id,
      title: `${testName} — ${what}`,
      status,
      group: {
        rootCause: testName,
        members: members.map(m => ({ subject: m.subject, emailId: m.id, receivedAt: m.receivedAt })),
      },
      source: [{ kind: "url", url }, ...members.map(m => ({ kind: "thread", emailId: m.id }))],
      proposedActions: [],
      lastChanged: null,
    });
  }
  return items;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/audit.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/audit.js daemon/normalizers/audit.test.js
git commit -m "feat(daemon): audit normalizer (Secureframe tests grouped)"
```

---

### Task 4: Register `audit` in the registry

**Files:**
- Modify: `daemon/normalizers/index.js`
- Modify: `daemon/normalizers/index.test.js`

- [ ] **Step 1: Add the failing test** — append inside `describe("runNormalizers", ...)` in `daemon/normalizers/index.test.js`:

```js
  it("runs the audit job when configured", async () => {
    const cfg = {
      triageCategories: [{ id: "action", actionable: true }, { id: "ignore", hidden: true }],
      jobTypes: { audit: { sourceCategories: ["action"], recognizers: { secureframe: {
        senderDomains: ["secureframe.com"], baseUrl: "https://app.secureframe.com",
        actionRequiredMarkers: ["action required"], commentMarkers: ["new comment"], resolvedMarkers: [],
      } } } },
    };
    const classified = { categories: { action: { emails: [
      { id: "x", from: "hello@secureframe.com", subject: "Your auditor marked a test as Action required",
        preview: "updated the test Backups to Action required.", receivedAt: "2026-06-15T00:00:00Z" },
    ] } } };
    const items = await runNormalizers(classified, { id: "brickell" }, cfg);
    assert.ok(items.some(i => i.jobType === "audit" && /Backups/.test(i.title)));
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/index.test.js`
Expected: FAIL — no `audit` adapter.

- [ ] **Step 3: Add the adapter in `daemon/normalizers/index.js`**

Add the import (with the others):

```js
import { normalizeAudit } from "./audit.js";
```

Add an `audit` adapter to `ADAPTERS` (alongside the rest), using `flattenSourceEmails`:

```js
  audit(classified, account, typeConfig) {
    const rules = typeConfig.jobTypes.audit;
    const emails = flattenSourceEmails(classified, rules.sourceCategories);
    return normalizeAudit(emails, account, rules);
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/index.test.js`
Expected: PASS (existing + new). Then full daemon suite → green.

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/index.js daemon/normalizers/index.test.js
git commit -m "feat(daemon): register audit job in the normalizer registry"
```

---

### Task 5: Docs + verification

**Files:**
- Modify: `daemon/README.md`

- [ ] **Step 1: Update the README**

(a) Intro: change "the `owed_risk`, `handled`, and `gateway` jobs today" → "the `owed_risk`, `handled`, `gateway`, and `audit` jobs today".

(b) Config section: add a bullet:

```markdown
- `config/account-types.json` → `<type>.jobTypes.audit.recognizers.secureframe` (sender domains,
  Secureframe base URL, action/comment/resolved markers).
```

(c) Add a section after the Gateway section:

```markdown
## Audit (compliance fieldwork)

The `audit` job surfaces Secureframe auditor requests during fieldwork: "Action required" and
"new comment / upload" events, one item per test, linking out to Secureframe. It's self-windowing —
Secureframe only emails during the ~3-month fieldwork window, so outside it nothing surfaces.
```

- [ ] **Step 2: Verify**

Run: `npm test` → all green.
Run: `node --check daemon/normalizers/audit.js && node --check daemon/normalizers/audit/secureframe.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add daemon/README.md
git commit -m "docs(daemon): document the audit (Secureframe) job"
```

---

## Self-Review (completed during authoring)

**Spec coverage:** §3 Secureframe recognizer (sender domain, test name, sub-types, URL) → Task 2; §5 audit item shape (id `…:audit:<slug>`, rootCause = testName, members, source = Secureframe URL + thread refs) → Task 3; registry generality → Task 4; config-driven → Task 1. acknowledge + exposed deferred (later plans), stated in Scope.

**Placeholder scan:** no TBD/TODO; complete code in every step; expected output on every command.

**Type consistency:** `recognizeSecureframe(email, cfg)→{testName, subType, url}` consumed by `normalizeAudit`; emitted Item matches the canonical shape (audit items carry `proposedActions: []`, so `stageProposals` stages nothing and the panel renders the route link from `source[0]`). Registry adapter signature matches `(classified, account, typeConfig)` like `gateway`/`handled`.

**Known follow-ups (not gold-plated):** deep-link to the exact Secureframe test (needs the link in the body — preview may truncate it; falls back to the app base URL); a "resolved" marker set to clear closed tests; acknowledge (next plan) to let the user clear items the panel still shows.
```
