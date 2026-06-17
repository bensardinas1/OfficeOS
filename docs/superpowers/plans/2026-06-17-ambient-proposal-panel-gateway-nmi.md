# Ambient Proposal Panel — `gateway` job (NMI tickets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `gateway` job-type — operational processing incidents affecting the user's merchants, surfaced from NMI support tickets — as a registry normalizer: one item per NMI ticket #, deduped across the thread, status from the latest message, routing out to the NMI ticket.

**Architecture:** A pure NMI **recognizer** (`recognizeNmiTicket(email, cfg) => {ticket, issueType, merchant, gwId, url} | null`) plus a pure **status** helper, composed by `daemon/normalizers/gateway.js` (group thread emails by ticket → one Item each). Registered in the existing normalizer registry; scheduler/panel/store/api are untouched. Detection and tunables are config-driven (`jobTypes.gateway`), so a second processor later is "another recognizer."

**Tech Stack:** Node.js ESM, `node --test` + `node:assert/strict`. No new dependencies. Builds on Plans 1–3 (registry, canonical Item shape, scheduler). Fixtures derive from the real NMI `.msg` samples (no secrets committed).

---

## Scope

**In this plan:** the `gateway` job for NMI — recognizer, status-from-thread, normalizer, registry wiring, config, docs. Reuses the existing panel rendering (route link comes from `item.source` URL; no panel change needed) and proposals flow (gateway items carry no `draft_chase`, so no proposals are staged).

**Not in this plan:** the shared `acknowledge` capability (its own later plan, before `exposed`); `audit` and `exposed` job-types; a "draft a reply to NMI" action (rails-safe future extension). The "waiting-on-you vs open" sub-status is reduced to `open` (`at_risk`) vs `resolved` (`ok`) for v1.

## Prerequisites / starting state

Plans 1–3 merged. `daemon/normalizers/index.js` exports async `runNormalizers(classified, account, typeConfig, opts)` with an `ADAPTERS` map (`owed_risk`, `handled`). The scheduler classifies each account once and calls `runNormalizers`. Canonical Item: `{id, jobType, account, title, status:"at_risk"|"ok", group:{rootCause, members:[...]}, source:[{kind,...}], proposedActions:[...], lastChanged}`. The panel's `renderItemCard` renders an "Open" link from the first `source` entry of kind `"url"` (via `safeUrl`), and `needsYouCount` counts `status==="at_risk"` items.

NMI sample facts (from the real `.msg` files): subject carries `[NMI Ticket <digits>]` (even on `Re:`/`Fw:` thread replies); ticket URL is `https://support.nmi.com/hc/requests/<ticket>`; issue types include "Settlement Batch Failure" and "Tokenization Error"; bodies mention `GW ID <digits>` and the merchant ("Our customer, Path Peptides (GW ID 1218748)"); resolution reads like "I'll be proceeding with closing this ticket."

---

### Task 1: Config — declare the `gateway` job

**Files:**
- Modify: `config/account-types.example.json` (add `jobTypes.gateway` to `business`)
- Modify: `daemon/config.test.js`

- [ ] **Step 1: Add the failing test** — append inside the existing describe block in `daemon/config.test.js`:

```js
  it("business declares a gateway job with an nmi recognizer", () => {
    const cfg = JSON.parse(readFileSync(join(root, "config/account-types.example.json"), "utf-8"));
    const g = cfg.business.jobTypes?.gateway;
    assert.ok(g, "business.jobTypes.gateway must exist");
    assert.ok(Array.isArray(g.sourceCategories) && g.sourceCategories.length > 0);
    assert.ok(g.recognizers?.nmi?.subjectPattern);
    assert.ok(g.recognizers.nmi.ticketUrlTemplate.includes("{ticket}"));
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/config.test.js`
Expected: FAIL — `business.jobTypes.gateway must exist`.

- [ ] **Step 3: Edit `config/account-types.example.json`**

In `business.jobTypes` (currently `owed_risk` + `handled`), add a `gateway` sibling:

```json
      "handled": {},
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
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/config.test.js`
Expected: PASS. Then `npm test` to confirm no JSON regression.

- [ ] **Step 5: Commit**

```bash
git add config/account-types.example.json daemon/config.test.js
git commit -m "chore(daemon): declare the gateway job + nmi recognizer config"
```

(Operator note: add the same `jobTypes.gateway` block to the live `config/account-types.json`.)

---

### Task 2: NMI recognizer (pure)

**Files:**
- Create: `daemon/normalizers/gateway/nmi.js`
- Create: `daemon/normalizers/gateway/nmi.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/gateway/nmi.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizeNmiTicket } from "./nmi.js";

const cfg = {
  subjectPattern: "\\[NMI Ticket (\\d+)\\]",
  ticketUrlTemplate: "https://support.nmi.com/hc/requests/{ticket}",
  issueKeywords: ["Settlement Batch Failure", "Tokenization Error"],
};

describe("recognizeNmiTicket", () => {
  it("extracts ticket, issue type, and builds the ticket URL from the subject", () => {
    const r = recognizeNmiTicket({ subject: "Re: [NMI Ticket 1258855] Fw: [Merchant Notification]WARNING: Settlement Batch Failure", preview: "" }, cfg);
    assert.equal(r.ticket, "1258855");
    assert.equal(r.issueType, "Settlement Batch Failure");
    assert.equal(r.url, "https://support.nmi.com/hc/requests/1258855");
  });

  it("pulls GW ID and merchant from the body when present", () => {
    const r = recognizeNmiTicket({
      subject: "Re: [NMI Ticket 1260651] Tokenization Error - Collect.js - GW ID 1218748",
      preview: "Our customer, Path Peptides (GW ID 1218748) is seeing tokenization errors",
    }, cfg);
    assert.equal(r.ticket, "1260651");
    assert.equal(r.issueType, "Tokenization Error");
    assert.equal(r.gwId, "1218748");
    assert.equal(r.merchant, "Path Peptides");
  });

  it("returns null for a non-NMI email", () => {
    assert.equal(recognizeNmiTicket({ subject: "Lunch?", preview: "" }, cfg), null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/gateway/nmi.test.js`
Expected: FAIL — cannot find module `./nmi.js`.

- [ ] **Step 3: Implement `daemon/normalizers/gateway/nmi.js`**

```js
/**
 * normalizers/gateway/nmi.js — pure recognizer for NMI support-ticket emails.
 * Detection is by the ticket marker in the subject (present on every thread
 * reply), so it captures NMI replies AND the merchant/Brickell replies in the
 * same thread. Returns null for non-NMI mail. No node: imports beyond none.
 */
export function recognizeNmiTicket(email, cfg) {
  const subject = email.subject || "";
  const m = subject.match(new RegExp(cfg.subjectPattern));
  if (!m) return null;
  const ticket = m[1];
  const text = `${subject} ${email.preview || ""}`;
  const issueType = (cfg.issueKeywords || []).find(k => text.toLowerCase().includes(k.toLowerCase())) || "Gateway issue";
  const gw = text.match(/GW ID\s*(\d+)/i);
  const merch = (email.preview || "").match(/customer,?\s+([A-Za-z0-9][\w .&'-]+?)\s*\(GW ID/i);
  return {
    ticket,
    issueType,
    gwId: gw ? gw[1] : null,
    merchant: merch ? merch[1].trim() : null,
    url: cfg.ticketUrlTemplate.replace("{ticket}", ticket),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/gateway/nmi.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/gateway/nmi.js daemon/normalizers/gateway/nmi.test.js
git commit -m "feat(daemon): NMI ticket recognizer (pure)"
```

---

### Task 3: Gateway status from the thread (pure)

**Files:**
- Create: `daemon/normalizers/gateway/status.js`
- Create: `daemon/normalizers/gateway/status.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/gateway/status.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gatewayStatus } from "./status.js";

const markers = ["closing this ticket", "has been resolved"];

describe("gatewayStatus", () => {
  it("is resolved when any message in the thread signals closure", () => {
    const members = [
      { preview: "How do we proceed?", receivedAt: "2026-06-10T00:00:00Z" },
      { preview: "As the solution has been provided, I'll be proceeding with closing this ticket.", receivedAt: "2026-06-13T00:00:00Z" },
    ];
    assert.equal(gatewayStatus(members, markers), "resolved");
  });

  it("is open when no closure signal is present", () => {
    const members = [{ preview: "Still investigating the batch", receivedAt: "2026-06-11T00:00:00Z" }];
    assert.equal(gatewayStatus(members, markers), "open");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/gateway/status.test.js`
Expected: FAIL — cannot find module `./status.js`.

- [ ] **Step 3: Implement `daemon/normalizers/gateway/status.js`**

```js
/**
 * normalizers/gateway/status.js — pure ticket-status from the thread's messages.
 * v1: "resolved" if any message matches a closure marker, else "open".
 * (A finer "waiting-on-you" sub-status is a later refinement; defaulting to
 * "open" fails toward surfacing, never toward hiding a live issue.)
 */
export function gatewayStatus(members, resolvedMarkers) {
  const hay = members.map(m => `${m.subject || ""} ${m.preview || ""}`.toLowerCase());
  const resolved = (resolvedMarkers || []).some(mk => hay.some(h => h.includes(mk.toLowerCase())));
  return resolved ? "resolved" : "open";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/gateway/status.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/gateway/status.js daemon/normalizers/gateway/status.test.js
git commit -m "feat(daemon): gateway ticket status from thread (pure)"
```

---

### Task 4: `normalizers/gateway` — group thread emails by ticket → items

**Files:**
- Create: `daemon/normalizers/gateway.js`
- Create: `daemon/normalizers/gateway.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/normalizers/gateway.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeGateway } from "./gateway.js";

const account = { id: "brickell" };
const rules = {
  recognizers: { nmi: {
    subjectPattern: "\\[NMI Ticket (\\d+)\\]",
    ticketUrlTemplate: "https://support.nmi.com/hc/requests/{ticket}",
    issueKeywords: ["Settlement Batch Failure", "Tokenization Error"],
    resolvedMarkers: ["closing this ticket"],
  } },
};

const emails = [
  { id: "a", subject: "Re: [NMI Ticket 1258855] Settlement Batch Failure", preview: "How do we proceed?", receivedAt: "2026-06-10T00:00:00Z" },
  { id: "b", subject: "Re: [NMI Ticket 1258855] Settlement Batch Failure", preview: "I'll be proceeding with closing this ticket.", receivedAt: "2026-06-13T00:00:00Z" },
  { id: "c", subject: "Re: [NMI Ticket 1260651] Tokenization Error - GW ID 1218748", preview: "Our customer, Path Peptides (GW ID 1218748) is seeing tokenization errors", receivedAt: "2026-06-11T00:00:00Z" },
  { id: "d", subject: "Team lunch", preview: "tomorrow?", receivedAt: "2026-06-12T00:00:00Z" },
];

describe("normalizeGateway", () => {
  it("groups a thread into one item per ticket and drops non-NMI mail", () => {
    const items = normalizeGateway(emails, account, rules);
    const ids = items.map(i => i.group.rootCause).sort();
    assert.deepEqual(ids, ["nmi:1258855", "nmi:1260651"]);
    const t1 = items.find(i => i.group.rootCause === "nmi:1258855");
    assert.equal(t1.group.members.length, 2);
  });

  it("marks a resolved ticket ok and an open ticket at_risk, with title + url", () => {
    const items = normalizeGateway(emails, account, rules);
    const resolved = items.find(i => i.group.rootCause === "nmi:1258855");
    const open = items.find(i => i.group.rootCause === "nmi:1260651");
    assert.equal(resolved.status, "ok");
    assert.equal(open.status, "at_risk");
    assert.equal(open.id, "brickell:gateway:nmi:1260651");
    assert.match(open.title, /1260651/);
    assert.match(open.title, /Tokenization Error/);
    assert.match(open.title, /Path Peptides|1218748/);
    assert.ok(open.source.some(s => s.kind === "url" && s.url === "https://support.nmi.com/hc/requests/1260651"));
  });

  it("returns [] when no NMI emails are present", () => {
    assert.deepEqual(normalizeGateway([emails[3]], account, rules), []);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/gateway.test.js`
Expected: FAIL — cannot find module `./gateway.js`.

- [ ] **Step 3: Implement `daemon/normalizers/gateway.js`**

```js
/**
 * normalizers/gateway.js — pure transform from classified emails to grouped
 * gateway (processing-incident) items. v1 recognizer: NMI support tickets,
 * grouped by ticket #. Resolved tickets are status "ok"; open ones "at_risk".
 */
import { recognizeNmiTicket } from "./gateway/nmi.js";
import { gatewayStatus } from "./gateway/status.js";

export function normalizeGateway(emails, account, rules) {
  const nmiCfg = rules.recognizers?.nmi;
  if (!nmiCfg) return [];
  const groups = new Map(); // ticket -> { rec, members }
  for (const e of emails) {
    const rec = recognizeNmiTicket(e, nmiCfg);
    if (!rec) continue;
    if (!groups.has(rec.ticket)) groups.set(rec.ticket, { rec, members: [] });
    const g = groups.get(rec.ticket);
    g.members.push(e);
    // keep the richest recognizer result (one that found merchant/gwId)
    if (rec.merchant || rec.gwId) g.rec = rec;
  }

  const items = [];
  for (const [ticket, { rec, members }] of groups) {
    const state = gatewayStatus(members, nmiCfg.resolvedMarkers);
    const who = rec.merchant || (rec.gwId ? `GW ${rec.gwId}` : "");
    items.push({
      id: `${account.id}:gateway:nmi:${ticket}`,
      jobType: "gateway",
      account: account.id,
      title: `NMI #${ticket} · ${rec.issueType}${who ? ` · ${who}` : ""}`,
      status: state === "resolved" ? "ok" : "at_risk",
      group: {
        rootCause: `nmi:${ticket}`,
        state,
        merchant: rec.merchant,
        gwId: rec.gwId,
        members: members.map(m => ({ subject: m.subject, emailId: m.id, receivedAt: m.receivedAt })),
      },
      source: [{ kind: "url", url: rec.url }, ...members.map(m => ({ kind: "thread", emailId: m.id }))],
      proposedActions: [],
      lastChanged: null,
    });
  }
  return items;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/gateway.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/gateway.js daemon/normalizers/gateway.test.js
git commit -m "feat(daemon): gateway normalizer (NMI tickets grouped by #)"
```

---

### Task 5: Register `gateway` in the normalizer registry

**Files:**
- Modify: `daemon/normalizers/index.js`
- Modify: `daemon/normalizers/index.test.js`

- [ ] **Step 1: Add the failing test** — append inside `describe("runNormalizers", ...)` in `daemon/normalizers/index.test.js`:

```js
  it("runs the gateway job when configured", async () => {
    const cfg = {
      triageCategories: [{ id: "action", actionable: true }, { id: "ignore", hidden: true }],
      jobTypes: { gateway: { sourceCategories: ["action"], recognizers: { nmi: {
        subjectPattern: "\\[NMI Ticket (\\d+)\\]",
        ticketUrlTemplate: "https://support.nmi.com/hc/requests/{ticket}",
        issueKeywords: ["Settlement Batch Failure"],
        resolvedMarkers: ["closing this ticket"],
      } } } },
    };
    const classified = { categories: { action: { emails: [
      { id: "x", subject: "Re: [NMI Ticket 1258855] Settlement Batch Failure", preview: "open issue", receivedAt: "2026-06-10T00:00:00Z" },
    ] } } };
    const items = await runNormalizers(classified, { id: "brickell" }, cfg);
    assert.ok(items.some(i => i.jobType === "gateway" && i.group.rootCause === "nmi:1258855"));
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/index.test.js`
Expected: FAIL — no `gateway` adapter, so no gateway item is produced.

- [ ] **Step 3: Add the adapter in `daemon/normalizers/index.js`**

Add the import (with the other normalizer imports):

```js
import { normalizeGateway } from "./gateway.js";
```

Add a `gateway` adapter to the `ADAPTERS` map (alongside `owed_risk` and `handled`). It flattens the job's `sourceCategories` (reuse the existing `flattenSourceEmails` helper) and calls `normalizeGateway`:

```js
  gateway(classified, account, typeConfig) {
    const rules = typeConfig.jobTypes.gateway;
    const emails = flattenSourceEmails(classified, rules.sourceCategories);
    return normalizeGateway(emails, account, rules);
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/normalizers/index.test.js`
Expected: PASS (existing tests + the new gateway test).
Run the full daemon suite (recurse daemon for `*.test.js`) → green.

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/index.js daemon/normalizers/index.test.js
git commit -m "feat(daemon): register gateway job in the normalizer registry"
```

---

### Task 6: Docs + verification

**Files:**
- Modify: `daemon/README.md`

- [ ] **Step 1: Update the README**

(a) In the intro, change "Surfaces the `owed_risk` and `handled` jobs today" to "Surfaces the `owed_risk`, `handled`, and `gateway` jobs today".

(b) In the Config section, add a bullet under the `account-types.json` line:

```markdown
- `config/account-types.json` → `<type>.jobTypes.gateway.recognizers.nmi` (subject pattern,
  ticket URL template, issue keywords, resolved markers).
```

(c) Add a short section after the Config section:

```markdown
## Gateway (processing incidents)

The `gateway` job surfaces processing incidents affecting your merchants. v1 recognizes NMI
support tickets (subject `[NMI Ticket <#>]`), groups the whole thread into one item per ticket,
marks it resolved (ok) once a closure message appears, and links out to the NMI ticket. Adding
another processor is a new recognizer under `jobTypes.gateway.recognizers`.
```

- [ ] **Step 2: Verify the whole job end to end**

Run the full suite: `npm test`
Expected: all daemon + scripts tests green.
Run: `node --check daemon/normalizers/gateway.js && node --check daemon/normalizers/gateway/nmi.js && node --check daemon/normalizers/gateway/status.js`
Expected: exit 0 for each.

- [ ] **Step 3: Commit**

```bash
git add daemon/README.md
git commit -m "docs(daemon): document the gateway (NMI) job"
```

---

## Self-Review (completed during authoring)

**Spec coverage:** §3 NMI recognizer (sender/subject/ticket/url/merchant/gwId) → Task 2; §5 gateway item shape (id `…:gateway:nmi:<ticket>`, rootCause `nmi:<ticket>`, merchant/gwId carried, source = ticket URL + thread refs) → Task 4; §3 status-from-latest (resolved→ok, open→at_risk) → Task 3 (v1 reduces "waiting-on-you" to "open", noted in Scope); registry generality → Task 5; config-driven recognizers → Task 1. Acknowledge + audit + exposed correctly out of scope (later plans), stated in Scope.

**Placeholder scan:** no TBD/TODO; every code step has complete code; every command has expected output.

**Type consistency:** `recognizeNmiTicket(email, cfg)→{ticket,issueType,gwId,merchant,url}` is consumed by `normalizeGateway`; `gatewayStatus(members, resolvedMarkers)→"resolved"|"open"` consumed by `normalizeGateway`. The emitted Item matches the canonical shape used across Plans 1–3 (`gateway` items carry `proposedActions: []`, so `stageProposals` stages nothing and the panel renders the route link from `source[0]` — no panel/proposals change needed). Registry adapter signature matches `(classified, account, typeConfig)` like `handled`.

**Known follow-ups (not gold-plated):** finer `waiting-on-you` status; per-thread "latest sender" heuristics; a "draft reply to NMI" action (rails-safe); these are deferred. Acknowledge (shared) is the next plan and will let resolved-but-still-shown tickets be cleared explicitly.
```
