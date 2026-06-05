# Issue Tracker Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two High findings (silent bridge mis-keying, cold-start provisional contradiction) and the contract/helper gaps from the IT-10 smoke test, under the principle "cost is a proxy for design effectiveness" — deterministic reduction-at-source + a funnel that measures it, no processing caps.

**Architecture:** A new orchestrator `build-bundle.js` codifies the fetch→classify→bundle bridge (paginated, msgid-keyed `emailsById` carrying `account`, a funnel report) so no session hand-scripts it. A pure `collapse.js` groups reasoning units (exact-dup, alert-batch ≥4) without dropping data. The applier gains a bootstrap `forceProvisional` path, stderr validation, and a compact report. Small store helpers (`findIssue`, drafts-index) close the footguns. New noise classes surface as proposals through the existing approve loop.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict` (run `npm test`, glob `scripts/test/**/*.test.js`). Reuses `fs-utils.atomicWrite`, `graph-client`/`gmail-client`, `pattern-discovery` proposal helpers (`proposalId`, `isPendingProposal`), and the morning-brief injected-deps test pattern.

**Spec:** `docs/superpowers/specs/2026-06-05-issue-tracker-remediation-design.md`
**Branch:** `feature/issue-tracker-remediation` (already created off master `91554b1`; the spec is committed on it).

---

## Pre-flight (do once before Task 1)

- [ ] **Confirm branch + clean tree + baseline tests**

Run (from the main repo — `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS"`; the shell may reset to a worktree path, always cd back):
```bash
git -C "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS" branch --show-current
npm test 2>&1 | tail -6
```
Expected: branch `feature/issue-tracker-remediation`; **237 tests pass**. If the parallel session's `docs/it10-smoke-test-aar` has merged to origin/master since, `git fetch && git rebase origin/master` first.

---

## File structure

**Create:**
- `scripts/collapse.js` — pure reasoning-unit grouping. `groupForReasoning(items) → { groups, byMsgid }`.
- `scripts/build-bundle.js` — orchestrator: `buildBundle({ since, accounts, deps }) → { generatedAt, window, bundle, emailsById, funnel }` + CLI. Pagination via a testable `collectPages` helper.
- `scripts/test/collapse.test.js`, `scripts/test/build-bundle.test.js`

**Modify:**
- `scripts/issue-apply.js` — `forceProvisional` option + `--force-provisional` flag; stderr validation; compact default report + `--verbose`.
- `scripts/issue-store.js` — `findIssue`, `loadDraftsIndex`, `saveDraftsIndex`.
- `scripts/test/issue-apply.test.js`, `scripts/test/issue-store.test.js`
- `.claude/commands/issues/_reasoner-pass.md` — collapsed-group handling.
- `.claude/commands/issues/issues.md` — bootstrap `--force-provisional`, `build-bundle.js`, doc reconcile.

---

## Task R-1: collapse.js — pure reasoning-unit grouping

**Files:**
- Create: `scripts/collapse.js`
- Test: `scripts/test/collapse.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/collapse.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupForReasoning, subjectSkeleton, normalizePreview } from "../collapse.js";

const E = (over) => ({ msgid: "m" + Math.random().toString(36).slice(2), from: "a@x.com", fromName: "A", subject: "s", preview: "p", account: "acc", tag: "survivor", ...over });

describe("subjectSkeleton", () => {
  it("strips trailing ids/numbers/dates to a stable skeleton", () => {
    assert.equal(subjectSkeleton("Potential attack path #12345"), subjectSkeleton("Potential attack path #99999"));
    assert.equal(subjectSkeleton("Invoice 2026-05-01"), subjectSkeleton("Invoice 2026-06-30"));
  });
  it("keeps distinct subjects distinct", () => {
    assert.notEqual(subjectSkeleton("Quarterly review"), subjectSkeleton("Annual review"));
  });
});

describe("groupForReasoning — exact-dup", () => {
  it("groups identical (from,subject) with near-identical preview across accounts", () => {
    const items = [
      E({ msgid: "a", from: "nejm@x.com", subject: "This Week at NEJM", preview: "Lead article ...", account: "brickellpay" }),
      E({ msgid: "b", from: "nejm@x.com", subject: "This Week at NEJM", preview: "Lead article ...", account: "personal" }),
    ];
    const { groups, byMsgid } = groupForReasoning(items);
    const g = groups.find(g => g.kind === "exact-dup");
    assert.ok(g, "exact-dup group formed");
    assert.equal(g.memberMsgids.length, 2);
    assert.equal(byMsgid["a"].isRepresentative !== byMsgid["b"].isRepresentative, true, "exactly one representative");
  });
  it("does NOT merge same sender with different subjects", () => {
    const items = [
      E({ msgid: "a", from: "x@x.com", subject: "Topic one" }),
      E({ msgid: "b", from: "x@x.com", subject: "Topic two" }),
    ];
    const { groups } = groupForReasoning(items);
    assert.equal(groups.filter(g => g.memberMsgids.length > 1).length, 0);
  });
});

describe("groupForReasoning — alert-batch", () => {
  it("groups >=4 same-sender template emails", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      E({ msgid: "d" + i, from: "defender@microsoft.com", subject: `Potential attack path #${1000 + i}` }));
    const { groups } = groupForReasoning(items);
    const g = groups.find(g => g.kind === "alert-batch");
    assert.ok(g, "alert-batch formed");
    assert.equal(g.memberMsgids.length, 5);
  });
  it("does NOT group only 3 (below threshold)", () => {
    const items = Array.from({ length: 3 }, (_, i) =>
      E({ msgid: "d" + i, from: "defender@microsoft.com", subject: `Potential attack path #${1000 + i}` }));
    const { groups } = groupForReasoning(items);
    assert.equal(groups.filter(g => g.kind === "alert-batch").length, 0);
  });
  it("does NOT group same template across DIFFERENT senders", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      E({ msgid: "d" + i, from: `sender${i}@x.com`, subject: `Booth #${i} at SEAA` }));
    const { groups } = groupForReasoning(items);
    assert.equal(groups.filter(g => g.kind === "alert-batch").length, 0);
  });
  it("every input msgid appears in byMsgid with a group id (singletons too)", () => {
    const items = [E({ msgid: "solo", from: "u@x.com", subject: "Unique" })];
    const { byMsgid } = groupForReasoning(items);
    assert.ok(byMsgid["solo"]);
    assert.equal(byMsgid["solo"].isRepresentative, true, "a singleton is its own representative");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test scripts/test/collapse.test.js 2>&1 | tail -10`
Expected: cannot find module `../collapse.js`.

- [ ] **Step 3: Implement `scripts/collapse.js`**

```js
/**
 * collapse.js
 *
 * Pure, deterministic reasoning-unit grouping. NO I/O.
 *
 * Collapses the *reasoning unit*, never the *data*: identical/near-identical
 * emails (exact-dup) and same-sender template batches (alert-batch) are grouped
 * so the reasoner judges a representative once; every member msgid is retained.
 *
 * groupForReasoning(items) → { groups, byMsgid }
 *   items: [{ msgid, from, fromName, subject, preview, account, tag }]
 *   groups: [{ id, kind: "exact-dup"|"alert-batch"|"single", representativeMsgid, memberMsgids[] }]
 *   byMsgid: { <msgid>: { groupId, isRepresentative } }
 */

const ALERT_BATCH_THRESHOLD = 4;

export function normalizePreview(preview) {
  return (preview || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")       // drop URLs (tracking params vary)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function subjectSkeleton(subject) {
  return (subject || "")
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "#")   // ISO dates
    .replace(/#?\d+/g, "#")                    // ids / numbers (with or without #)
    .replace(/\s+/g, " ")
    .trim();
}

function fromAddr(item) {
  return (item.from || "").toLowerCase().trim();
}

export function groupForReasoning(items) {
  const groups = [];
  const byMsgid = {};
  let gid = 0;
  const claimed = new Set();

  // 1. exact-dup: identical (from, subject) AND near-identical preview.
  const exactKey = (it) => `${fromAddr(it)} ${(it.subject || "").trim().toLowerCase()} ${normalizePreview(it.preview)}`;
  const exactBuckets = new Map();
  for (const it of items) {
    const k = exactKey(it);
    if (!exactBuckets.has(k)) exactBuckets.set(k, []);
    exactBuckets.get(k).push(it);
  }
  for (const bucket of exactBuckets.values()) {
    if (bucket.length < 2) continue;
    const id = `g${gid++}`;
    const memberMsgids = bucket.map(b => b.msgid);
    groups.push({ id, kind: "exact-dup", representativeMsgid: memberMsgids[0], memberMsgids });
    bucket.forEach((b, i) => { claimed.add(b.msgid); byMsgid[b.msgid] = { groupId: id, isRepresentative: i === 0 }; });
  }

  // 2. alert-batch: >=THRESHOLD same-sender, same subject-skeleton (not already claimed).
  const batchKey = (it) => `${fromAddr(it)} ${subjectSkeleton(it.subject)}`;
  const batchBuckets = new Map();
  for (const it of items) {
    if (claimed.has(it.msgid)) continue;
    const k = batchKey(it);
    if (!batchBuckets.has(k)) batchBuckets.set(k, []);
    batchBuckets.get(k).push(it);
  }
  for (const bucket of batchBuckets.values()) {
    if (bucket.length < ALERT_BATCH_THRESHOLD) continue;
    const id = `g${gid++}`;
    const memberMsgids = bucket.map(b => b.msgid);
    groups.push({ id, kind: "alert-batch", representativeMsgid: memberMsgids[0], memberMsgids });
    bucket.forEach((b, i) => { claimed.add(b.msgid); byMsgid[b.msgid] = { groupId: id, isRepresentative: i === 0 }; });
  }

  // 3. singletons: everything unclaimed is its own representative.
  for (const it of items) {
    if (claimed.has(it.msgid)) continue;
    const id = `g${gid++}`;
    groups.push({ id, kind: "single", representativeMsgid: it.msgid, memberMsgids: [it.msgid] });
    byMsgid[it.msgid] = { groupId: id, isRepresentative: true };
  }

  return { groups, byMsgid };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test scripts/test/collapse.test.js 2>&1 | tail -15`
Expected: all collapse tests pass.

- [ ] **Step 5: Full suite**

Run: `npm test 2>&1 | tail -6`
Expected: 237 + new collapse tests, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add scripts/collapse.js scripts/test/collapse.test.js
git commit -m "feat(collapse): pure reasoning-unit grouping (exact-dup + alert-batch)

Groups identical/near-identical emails and same-sender template batches (>=4)
so the reasoner judges a representative once. Every member msgid is retained
(collapse the unit, not the data). Conservative: exact subject for dups,
same-sender-only for batches, no grouping when in doubt.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task R-2: build-bundle.js — orchestrator + pagination + funnel

**Files:**
- Create: `scripts/build-bundle.js`
- Test: `scripts/test/build-bundle.test.js`

**Context:** `buildBundle` takes injected deps so the bridge logic is unit-testable without network. `deps.fetchAllFn(accountId, sinceIso)` returns the FULL paginated email list for an account (pagination correctness is tested separately via `collectPages`). `deps.classifyFn(emails, accountId)` returns the classify result shape `{ categories, deletionCandidates, explicitDeletions, heuristicDeletions }`. The CLI entrypoint wires the real paginated Graph/Gmail fetch + real `classify`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test/build-bundle.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBundle, collectPages } from "../build-bundle.js";

describe("collectPages — paginates until past the window", () => {
  it("collects across pages and stops when items predate `since`", async () => {
    // Simulated pages, newest-first; each page has 2 items.
    const pages = [
      [{ id: "1", receivedAt: "2026-06-05T10:00:00Z" }, { id: "2", receivedAt: "2026-06-05T09:00:00Z" }],
      [{ id: "3", receivedAt: "2026-06-04T10:00:00Z" }, { id: "4", receivedAt: "2026-05-01T00:00:00Z" }], // 4 is past window
    ];
    let p = 0;
    const fetchPage = async () => ({ items: pages[p], nextToken: p + 1 < pages.length ? String(++p) : null });
    const out = await collectPages(fetchPage, { sinceMs: new Date("2026-06-01T00:00:00Z").getTime(), dateOf: e => e.receivedAt });
    assert.deepEqual(out.map(e => e.id), ["1", "2", "3"]); // "4" dropped (past window)
  });
});

describe("buildBundle — assembly + funnel", () => {
  function deps() {
    return {
      accounts: [
        { id: "biz", accountType: "business" },
        { id: "personal", accountType: "personal" },
      ],
      fetchAllFn: async (accountId) => {
        if (accountId === "biz") return [
          { id: "k1", from: "real@x.com", fromName: "Real", subject: "Re: contract", preview: "hi", receivedAt: "2026-06-05T10:00:00Z", hasListUnsubscribe: false },
          { id: "d1", from: "spam@x.com", fromName: "Spam", subject: "buy", preview: "", receivedAt: "2026-06-05T09:00:00Z", hasListUnsubscribe: true },
          ...Array.from({ length: 4 }, (_, i) => ({ id: "al" + i, from: "defender@microsoft.com", fromName: "Defender", subject: `Attack path #${i}`, preview: "alert", receivedAt: "2026-06-05T08:00:00Z", hasListUnsubscribe: false })),
        ];
        return [{ id: "p1", from: "n@y.com", fromName: "N", subject: "news", preview: "digest", receivedAt: "2026-06-05T07:00:00Z", hasListUnsubscribe: true }];
      },
      classifyFn: (emails) => {
        const r = { categories: {}, deletionCandidates: [], explicitDeletions: [], heuristicDeletions: [] };
        for (const e of emails) {
          if (e.id === "d1") { r.deletionCandidates.push(e); r.explicitDeletions.push(e); }       // explicit drop
          else if (e.id.startsWith("al")) { r.deletionCandidates.push(e); r.heuristicDeletions.push(e); } // heuristic candidate
          else if (e.id === "p1") { r.deletionCandidates.push(e); r.heuristicDeletions.push(e); }
          // k1 → survivor (in no deletion list)
        }
        return r;
      },
      now: "2026-06-05T12:00:00Z",
    };
  }

  it("produces bundle, emailsById (with account), and a reconciling funnel", async () => {
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: deps() });
    // emailsById carries account
    assert.equal(out.emailsById["k1"].account, "biz");
    assert.equal(out.emailsById["al0"].account, "biz");
    // funnel reconciles: fetched = explicitDropped + survivors + heuristicCandidates
    const f = out.funnel;
    assert.equal(f.fetched, f.explicitDropped + f.survivors + f.heuristicCandidates);
    assert.equal(f.explicitDropped, 1);          // d1
    assert.equal(f.survivors, 1);                // k1
    assert.equal(f.heuristicCandidates, 5);      // 4 defender + p1
    // collapse: the 4 defender alerts → 1 reasoning unit; k1 + p1 singletons
    assert.ok(f.collapsed.savedJudgments >= 3, "the 4-alert batch saved >=3 judgments");
    assert.ok(f.reasoningUnits < f.survivors + f.heuristicCandidates, "collapse reduced reasoning units");
  });

  it("tags bundle items survivor vs heuristic-delete-candidate and marks representatives", async () => {
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: deps() });
    const k1 = out.bundle.find(b => b.msgid === "k1");
    assert.equal(k1.tag, "survivor");
    const al = out.bundle.filter(b => b.msgid.startsWith("al"));
    assert.ok(al.every(b => b.tag === "heuristic-delete-candidate"));
    assert.equal(al.filter(b => b.group.isRepresentative).length, 1, "exactly one representative in the alert batch");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test scripts/test/build-bundle.test.js 2>&1 | tail -10`
Expected: cannot find module `../build-bundle.js`.

- [ ] **Step 3: Implement `scripts/build-bundle.js`**

```js
/**
 * build-bundle.js
 *
 * Codifies the fetch -> classify -> bundle bridge so no session hand-scripts it.
 * Emits { generatedAt, window, bundle, emailsById, funnel }. The reasoner consumes
 * `bundle` (msgid-keyed, tagged, collapsed groups marked); the applier consumes
 * `emailsById` (carries `account`). The funnel attributes cost at every tier.
 *
 * Injected deps make the bridge testable without network:
 *   deps.accounts: [{ id, accountType }]
 *   deps.fetchAllFn(accountId, sinceIso) -> full paginated email list
 *   deps.classifyFn(emails, accountId)  -> { explicitDeletions, heuristicDeletions, ... }
 *   deps.now: ISO timestamp
 *
 * CLI: node scripts/build-bundle.js --since <ISO|Nd|Nh> [--accounts a,b] [--out <path>]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./fs-utils.js";
import { groupForReasoning } from "./collapse.js";

/**
 * Generic page collector. fetchPage({ token }) -> { items, nextToken }.
 * Stops when a fetched item's date is older than sinceMs, or tokens run out.
 * Returns only items within the window.
 */
export async function collectPages(fetchPage, { sinceMs, dateOf }) {
  const out = [];
  let token = null;
  for (;;) {
    const { items, nextToken } = await fetchPage({ token });
    let sawOld = false;
    for (const it of items || []) {
      if (new Date(dateOf(it)).getTime() < sinceMs) { sawOld = true; continue; }
      out.push(it);
    }
    if (sawOld || !nextToken) break;
    token = nextToken;
  }
  return out;
}

function compactEmail(e, accountId) {
  return {
    id: e.id, account: accountId,
    from: e.from, fromName: e.fromName,
    subject: e.subject, receivedAt: e.receivedAt || e.received,
  };
}

export async function buildBundle({ since, deps }) {
  const { accounts, fetchAllFn, classifyFn, now } = deps;
  const sinceIso = since;

  const bundle = [];
  const emailsById = {};
  const perAccount = {};
  let fetched = 0, explicitDropped = 0, survivors = 0, heuristicCandidates = 0;

  // Fetch + classify per account (concurrently).
  const results = await Promise.all(accounts.map(async (acct) => {
    const emails = await fetchAllFn(acct.id, sinceIso);
    const r = classifyFn(emails, acct.id);
    return { acct, emails, r };
  }));

  // Assemble survivors + heuristic candidates, tagged, with account.
  const toCollapse = [];
  for (const { acct, emails, r } of results) {
    const explicitIds = new Set((r.explicitDeletions || []).map(e => e.id));
    const heuristicIds = new Set((r.heuristicDeletions || []).map(e => e.id));
    let aFetched = emails.length, aExplicit = 0, aSurv = 0, aHeur = 0;
    for (const e of emails) {
      if (explicitIds.has(e.id)) { aExplicit++; continue; }       // dropped deterministically; not in bundle
      const tag = heuristicIds.has(e.id) ? "heuristic-delete-candidate" : "survivor";
      if (tag === "survivor") aSurv++; else aHeur++;
      emailsById[e.id] = compactEmail(e, acct.id);
      toCollapse.push({
        msgid: e.id, account: acct.id, tag,
        from: e.from, fromName: e.fromName, subject: e.subject,
        preview: (e.preview || "").slice(0, 200),
        receivedAt: e.receivedAt || e.received, hasListUnsubscribe: !!e.hasListUnsubscribe,
      });
    }
    fetched += aFetched; explicitDropped += aExplicit; survivors += aSurv; heuristicCandidates += aHeur;
    perAccount[acct.id] = { fetched: aFetched, explicitDropped: aExplicit, survivors: aSurv, heuristicCandidates: aHeur };
  }

  // Collapse reasoning units across BOTH survivors and candidates.
  const { groups, byMsgid } = groupForReasoning(toCollapse);
  for (const item of toCollapse) {
    const g = byMsgid[item.msgid];
    const group = groups.find(x => x.id === g.groupId);
    item.group = { id: g.groupId, kind: group.kind, isRepresentative: g.isRepresentative, size: group.memberMsgids.length };
    bundle.push(item);
  }

  const fromMembers = toCollapse.length;
  const reasoningUnits = groups.length;
  const funnel = {
    fetched, explicitDropped, survivors, heuristicCandidates,
    collapsed: { groups: reasoningUnits, fromMembers, savedJudgments: fromMembers - reasoningUnits },
    reasoningUnits, perAccount,
  };

  return { generatedAt: now, window: { since: sinceIso }, bundle, emailsById, funnel };
}

function funnelLine(f) {
  return `fetched ${f.fetched} → explicit-dropped ${f.explicitDropped} → ${f.survivors} survivors + ${f.heuristicCandidates} candidates → collapse ${f.collapsed.fromMembers}→${f.reasoningUnits} units → reasoned ${f.reasoningUnits}`;
}

// --- window parsing ---
export function resolveSince(arg, nowIso) {
  if (/^\d+d$/i.test(arg)) return new Date(new Date(nowIso).getTime() - parseInt(arg) * 86400000).toISOString();
  if (/^\d+h$/i.test(arg)) return new Date(new Date(nowIso).getTime() - parseInt(arg) * 3600000).toISOString();
  const d = new Date(arg);
  if (isNaN(d.getTime())) throw new Error(`--since must be ISO, Nd, or Nh; got "${arg}"`);
  return d.toISOString();
}

// CLI entrypoint — Windows-safe guard.
if (process.argv[1] && process.argv[1].endsWith("build-bundle.js")) {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since") flags.since = args[++i];
    else if (args[i] === "--accounts") flags.accounts = args[++i];
    else if (args[i] === "--out") flags.out = args[++i];
  }
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = join(__dirname, "..");
  const nowIso = new Date().toISOString();
  const since = resolveSince(flags.since || "30d", nowIso);
  const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
  const wanted = flags.accounts ? new Set(flags.accounts.split(",")) : null;
  const accounts = companies.companies
    .filter(c => !wanted || wanted.has(c.id))
    .map(c => ({ id: c.id, accountType: c.accountType, provider: c.provider }));

  const { spawnSync } = await import("node:child_process");
  const { buildGraphClient } = await import("./graph-client.js");
  const { buildGmailClient } = await import("./gmail-client.js");
  const { classify } = await import("./classify-emails.js");

  const sinceMs = new Date(since).getTime();

  async function fetchAllOutlook(accountId) {
    const client = await buildGraphClient(accountId);
    return collectPages(async ({ token }) => {
      const req = token
        ? client.api(token)
        : client.api("/me/mailFolders/inbox/messages").top(100)
            .select("id,subject,from,receivedDateTime,bodyPreview")
            .orderby("receivedDateTime desc");
      const res = await req.get();
      const items = (res.value || []).map(m => ({
        id: m.id, subject: m.subject,
        from: m.from?.emailAddress?.address, fromName: m.from?.emailAddress?.name,
        receivedAt: m.receivedDateTime, preview: m.bodyPreview,
      }));
      return { items, nextToken: res["@odata.nextLink"] || null };
    }, { sinceMs, dateOf: e => e.receivedAt });
  }

  async function fetchAllGmail(accountId) {
    const gmail = await buildGmailClient();
    const afterSec = Math.floor(sinceMs / 1000);
    const ids = await collectPages(async ({ token }) => {
      const res = await gmail.users.messages.list({ userId: "me", q: `in:inbox after:${afterSec}`, maxResults: 100, pageToken: token || undefined });
      return { items: (res.data.messages || []).map(m => ({ id: m.id, receivedAt: new Date().toISOString() })), nextToken: res.data.nextPageToken || null };
    }, { sinceMs: 0, dateOf: () => new Date().toISOString() }); // Gmail `after:` already windows server-side; collect all pages
    // Hydrate each id (subject/from/date/preview)
    const out = [];
    for (const { id } of ids) {
      const m = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
      const h = Object.fromEntries((m.data.payload?.headers || []).map(x => [x.name, x.value]));
      out.push({ id, subject: h.Subject, from: (h.From || "").replace(/.*<(.+)>.*/, "$1"), fromName: (h.From || "").replace(/<.*>/, "").trim(), receivedAt: new Date(Number(m.data.internalDate)).toISOString(), preview: m.data.snippet });
    }
    return out;
  }

  const deps = {
    accounts,
    now: nowIso,
    fetchAllFn: async (accountId) => {
      const acct = accounts.find(a => a.id === accountId);
      return acct.provider === "gmail" ? fetchAllGmail(accountId) : fetchAllOutlook(accountId);
    },
    classifyFn: (emails, accountId) => classify(emails, accountId),
  };

  const result = await buildBundle({ since, deps });
  const outPath = flags.out || join(root, "data/.last-run-bundle.json");
  atomicWrite(outPath, JSON.stringify(result, null, 2));
  process.stderr.write(funnelLine(result.funnel) + "\n");
  process.stdout.write(JSON.stringify({ funnel: result.funnel, out: outPath }, null, 2));
}
```

NOTE: `classify(emails, accountId)` is the existing export in `classify-emails.js`. Confirm its signature with `grep -n "export function classify" scripts/classify-emails.js` before wiring; if it differs, adapt the CLI `classifyFn`. The unit tests do not exercise the CLI block (they inject `classifyFn`), so a CLI signature mismatch will not fail tests — verify it by hand in the load test (R-7).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test scripts/test/build-bundle.test.js 2>&1 | tail -20`
Expected: `collectPages` + both `buildBundle` tests pass.

- [ ] **Step 5: Full suite**

Run: `npm test 2>&1 | tail -6`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-bundle.js scripts/test/build-bundle.test.js
git commit -m "feat(build-bundle): paginated fetch→classify→bundle bridge + funnel

Codifies the bridge the /issues runner hand-scripted (the F-2 mis-keying
source): msgid-keyed emailsById carrying account, survivor/candidate tagging,
collapse groups marked, and a cost-attribution funnel. collectPages paginates
the full window (resolves F-6 silent truncation). Injected deps keep the
bridge unit-tested without network; CLI wires real Graph/Gmail pagination.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task R-3: issue-apply.js — forceProvisional + validation + compact report

**Files:**
- Modify: `scripts/issue-apply.js`
- Test: `scripts/test/issue-apply.test.js`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/issue-apply.test.js`:

```js
describe("applyReasonerOutput — forceProvisional (F-1 bootstrap)", () => {
  it("forces a 2-email actioned NEW group to provisional when forceProvisional is set", () => {
    const records = [
      { msgid: "m-neal", verdict: "keep", issue: "NEW:SEAA Partner Meetings", reason: "x", next_action_update: "reply", waiting_on_update: "you" },
      { msgid: "m-brad", verdict: "keep", issue: "NEW:SEAA Partner Meetings", reason: "y", next_action_update: "reply", waiting_on_update: "you" },
    ];
    const out = applyReasonerOutput(records, sampleEmailsById, { issuesDir, now: "2026-06-05", forceProvisional: true });
    assert.equal(loadIssues(issuesDir).find(i => i.id === "seaa-partner-meetings"), undefined, "not real");
    assert.ok(loadProvisional(issuesDir).find(i => i.id === "seaa-partner-meetings"), "forced provisional");
    assert.ok(out.quarantined.includes("seaa-partner-meetings"));
  });

  it("without forceProvisional, the same group lands real (unchanged default)", () => {
    const records = [
      { msgid: "m-neal", verdict: "keep", issue: "NEW:SEAA Partner Meetings", reason: "x", next_action_update: "reply", waiting_on_update: "you" },
      { msgid: "m-brad", verdict: "keep", issue: "NEW:SEAA Partner Meetings", reason: "y", next_action_update: "reply", waiting_on_update: "you" },
    ];
    const out = applyReasonerOutput(records, sampleEmailsById, { issuesDir, now: "2026-06-05" });
    assert.ok(loadIssues(issuesDir).find(i => i.id === "seaa-partner-meetings"), "real by default");
    assert.ok(out.created.includes("seaa-partner-meetings"));
  });
});

describe("applyReasonerOutput — stderr validation", () => {
  it("warns when a record msgid is absent from emailsById", () => {
    const warnings = [];
    const orig = console.warn;
    console.warn = (m) => warnings.push(m);
    try {
      applyReasonerOutput(
        [{ msgid: "ghost", verdict: "keep", issue: "NEW:Ghost Topic", reason: "x", next_action_update: "", waiting_on_update: "you" }],
        {}, { issuesDir, now: "2026-06-05" }
      );
    } finally { console.warn = orig; }
    assert.ok(warnings.some(w => /ghost/.test(w) && /emailsById/i.test(w)), "warned about missing email");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test scripts/test/issue-apply.test.js 2>&1 | grep -A3 "forceProvisional\|stderr validation"`
Expected: failures — `forceProvisional` ignored; no warning emitted.

- [ ] **Step 3: Implement in `scripts/issue-apply.js`**

READ the file first. Change the signature:

```js
export function applyReasonerOutput(records, emailsById, { issuesDir, now, heuristicMsgids = [], forceProvisional = false }) {
```

In the second loop (the per-record loop), add a missing-email warning. Find where it pulls the email:
```js
    const email = emailsById[rec.msgid];
```
Add immediately after:
```js
    if (rec.verdict !== "trash" && !email) {
      console.warn(`issue-apply: record msgid ${rec.msgid} not found in emailsById — association skipped`);
    }
```

In the NEW-group creation path, find:
```js
    const provisional = group.recs.length < 2 && !firstWithAction;
```
Change to:
```js
    const provisional = forceProvisional || (group.recs.length < 2 && !firstWithAction);
```

Add a NEW-title/real-slug collision warning. In the NEW-group loop, after `const existing = byId.get(slug);` is checked and we're in the creation branch (existing is falsy), before `createIssue`, add:
```js
    // (existing is falsy here — see the `if (existing) { ...; continue; }` short-circuit above)
```
(No extra code needed for collision beyond the existing `if (existing)` append path — that already prevents overwriting; the warning is only useful when a real slug exists, which the `if (existing)` path already handles by appending. Skip adding a redundant warning.)

- [ ] **Step 4: Add the compact report + `--verbose` to the CLI block**

READ the CLI entrypoint at the bottom of `issue-apply.js`. It currently does `process.stdout.write(JSON.stringify(report, null, 2))`. Replace that line with a compact-by-default report:

```js
  const verbose = process.argv.includes("--verbose");
  const compact = {
    created: report.created, updated: report.updated, quarantined: report.quarantined,
    rescued: report.rescued.length, toTrash: report.toTrash.length, noIssue: report.noIssue.length,
  };
  process.stdout.write(JSON.stringify(verbose ? report : compact, null, 2));
```

Also parse `--force-provisional` in the CLI block and pass it through. Find where the CLI builds the `applyReasonerOutput` call options and add `forceProvisional: process.argv.includes("--force-provisional")`. (The CLI reads `{ records, emailsById, heuristicMsgids, now }` from stdin per the existing entrypoint — add the flag from argv, not stdin.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test scripts/test/issue-apply.test.js 2>&1 | tail -15`
Expected: new forceProvisional + stderr tests pass; existing applier tests unaffected.

- [ ] **Step 6: Full suite**

Run: `npm test 2>&1 | tail -6`
Expected: no regressions.

- [ ] **Step 7: Commit**

```bash
git add scripts/issue-apply.js scripts/test/issue-apply.test.js
git commit -m "feat(issue-apply): forceProvisional bootstrap path + stderr validation + compact report

- forceProvisional option (+ --force-provisional CLI flag): all NEW issues land
  provisional regardless of size/action, matching the documented cold-start
  contract (F-1). Default false → steady-state heuristic unchanged.
- console.warn when a record msgid is absent from emailsById (surfaces the
  hand-bridging mis-key loudly instead of silently mis-associating, F-2).
- CLI prints a compact report by default (array lengths); full arrays behind
  --verbose (kills the verbose-report token waste).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task R-4: issue-store.js — findIssue + drafts-index helpers

**Files:**
- Modify: `scripts/issue-store.js`
- Test: `scripts/test/issue-store.test.js`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/issue-store.test.js`:

```js
import { findIssue, loadDraftsIndex, saveDraftsIndex } from "../issue-store.js";

describe("findIssue — unions real + provisional", () => {
  it("resolves a provisional alias that loadIssues alone would miss", () => {
    createIssue(issuesDir, { title: "CXN Collective", aliases: ["cxn"] }, { provisional: true, now: "2026-06-05" });
    const found = findIssue(issuesDir, "cxn");
    assert.ok(found, "provisional alias resolved");
    assert.equal(found.id, "cxn-collective");
    assert.equal(found._provisional, true);
  });
  it("prefers a real issue over a provisional on alias collision", () => {
    createIssue(issuesDir, { title: "Dup Topic", aliases: ["dup"] }, { now: "2026-06-05" });           // real
    createIssue(issuesDir, { title: "Dup Topic Two", aliases: ["dup"] }, { provisional: true, now: "2026-06-05" }); // provisional, same alias
    const found = findIssue(issuesDir, "dup");
    assert.equal(found._provisional, false, "real wins on collision");
  });
  it("returns null when nothing matches", () => {
    assert.equal(findIssue(issuesDir, "nope"), null);
  });
});

describe("drafts-index helpers", () => {
  it("round-trips and returns {} when missing", () => {
    const p = join(tmpDir, "drafts-index.json");
    assert.deepEqual(loadDraftsIndex(p), {});
    saveDraftsIndex(p, { "brickellpay:m1": { draftId: "d1", issue: "nmi", preview: "Hi", savedAt: "2026-06-05" } });
    assert.equal(loadDraftsIndex(p)["brickellpay:m1"].draftId, "d1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test scripts/test/issue-store.test.js 2>&1 | grep -A3 "findIssue\|drafts-index"`
Expected: failures — exports not found.

- [ ] **Step 3: Implement in `scripts/issue-store.js`**

Append:

```js
/**
 * Resolve an alias against BOTH real and provisional issues. Real wins on
 * collision. Returns the issue object (with _provisional) or null.
 */
export function findIssue(issuesDir, alias) {
  const real = loadIssues(issuesDir);
  const realHit = findByAlias(real, alias);
  if (realHit) return realHit;
  return findByAlias(loadProvisional(issuesDir), alias);
}

/**
 * drafts-index: map "<accountId>:<sourceMsgid>" -> { draftId, issue, preview, savedAt }.
 * Prevents re-drafting the same source email on overlapping windows.
 */
export function loadDraftsIndex(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

export function saveDraftsIndex(path, index) {
  atomicWrite(path, JSON.stringify(index, null, 2));
}
```

Confirm `existsSync` and `readFileSync` are already imported at the top of `issue-store.js` (they are, from the read-side task). If not, add them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test scripts/test/issue-store.test.js 2>&1 | tail -12`
Expected: findIssue + drafts-index tests pass.

- [ ] **Step 5: Full suite**

Run: `npm test 2>&1 | tail -6`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add scripts/issue-store.js scripts/test/issue-store.test.js
git commit -m "feat(issue-store): findIssue (real+provisional union) + drafts-index helpers

findIssue resolves an alias across both real and provisional issues (real wins
on collision) — fixes the F-11 provisional-alias lookup miss. loadDraftsIndex/
saveDraftsIndex define the F-8 schema (keyed by accountId:sourceMsgid) for
re-draft idempotency.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task R-5: noise-class proposals from build-bundle

**Files:**
- Modify: `scripts/build-bundle.js`
- Test: `scripts/test/build-bundle.test.js`

**Context:** When `collapse` produces an `alert-batch`, `build-bundle` surfaces a *proposed* `alwaysDelete` rule (sender-based) via the existing `data/proposed-rules.json` + `pattern-discovery` helpers — never auto-dropping. Reuses `proposalId` and `isPendingProposal` from `pattern-discovery.js`. `buildBundle` returns proposals in its result; the CLI merges them into `proposed-rules.json` (idempotent).

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/build-bundle.test.js`:

```js
describe("buildBundle — alert-batch surfaces a noise-class proposal", () => {
  function depsBatch() {
    return {
      accounts: [{ id: "biz", accountType: "business" }],
      now: "2026-06-05T12:00:00Z",
      fetchAllFn: async () => Array.from({ length: 5 }, (_, i) => ({
        id: "al" + i, from: "defender@microsoft.com", fromName: "Defender",
        subject: `Attack path #${i}`, preview: "alert", receivedAt: "2026-06-05T08:00:00Z", hasListUnsubscribe: false,
      })),
      classifyFn: (emails) => {
        const r = { categories: {}, deletionCandidates: [], explicitDeletions: [], heuristicDeletions: [] };
        for (const e of emails) { r.deletionCandidates.push(e); r.heuristicDeletions.push(e); }
        return r;
      },
    };
  }
  it("proposes an alwaysDelete for the batch sender, with no pre-existing pending proposal", async () => {
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: depsBatch(), pendingProposals: [] });
    assert.ok(Array.isArray(out.proposals));
    const p = out.proposals.find(p => p.payload && p.payload.value === "defender@microsoft.com");
    assert.ok(p, "proposed alwaysDelete for the batch sender");
    assert.equal(p.target, "companies.biz.alwaysDelete");
    assert.equal(p.status, "pending");
  });
  it("does not re-propose when a pending proposal already covers the sender", async () => {
    const pending = [{ id: "p-1", target: "companies.biz.alwaysDelete", payload: { type: "email", value: "defender@microsoft.com" }, status: "pending" }];
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: depsBatch(), pendingProposals: pending });
    assert.equal((out.proposals || []).length, 0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test scripts/test/build-bundle.test.js 2>&1 | grep -A3 "noise-class proposal"`
Expected: failures — `out.proposals` undefined.

- [ ] **Step 3: Implement in `scripts/build-bundle.js`**

Add the import near the top:
```js
import { proposalId, isPendingProposal } from "./pattern-discovery.js";
```

Change the `buildBundle` signature to accept `pendingProposals`:
```js
export async function buildBundle({ since, deps, pendingProposals = [] }) {
```

After the collapse block (after `bundle.push(item)` loop, before building `funnel`), add proposal generation:
```js
  // Surface noise-class proposals for alert-batches (never auto-drop).
  const proposals = [];
  const datePart = (now || "").slice(0, 10);
  let counter = pendingProposals.length + 1;
  for (const group of groups) {
    if (group.kind !== "alert-batch") continue;
    const rep = bundle.find(b => b.msgid === group.representativeMsgid);
    if (!rep) continue;
    const sender = (rep.from || "").toLowerCase();
    const target = `companies.${rep.account}.alwaysDelete`;
    if (!sender || isPendingProposal(pendingProposals, target, sender)) continue;
    proposals.push({
      id: proposalId(now, counter++),
      target,
      payload: { type: "email", value: sender, label: `${sender} (alert batch ×${group.memberMsgids.length})` },
      reason: `${group.memberMsgids.length} same-template alerts from ${sender} in window`,
      proposedAt: now, status: "pending",
    });
  }
```

Add `proposals` to the returned object:
```js
  return { generatedAt: now, window: { since: sinceIso }, bundle, emailsById, funnel, proposals };
```

In the CLI block, after computing `result`, merge new proposals into `data/proposed-rules.json` (load existing, append, atomicWrite). Add before the `atomicWrite(outPath, ...)`:
```js
  if (result.proposals && result.proposals.length) {
    const prPath = join(root, "data/proposed-rules.json");
    let pr = { proposals: [] };
    try { pr = JSON.parse(readFileSync(prPath, "utf-8")); } catch { /* fresh */ }
    pr.proposals.push(...result.proposals);
    atomicWrite(prPath, JSON.stringify(pr, null, 2));
  }
```
And pass existing pending proposals INTO `buildBundle` in the CLI so dedup works:
```js
  let existingPending = [];
  try { existingPending = (JSON.parse(readFileSync(join(root, "data/proposed-rules.json"), "utf-8")).proposals || []); } catch { /* none */ }
  const result = await buildBundle({ since, deps, pendingProposals: existingPending });
```
(Place the `existingPending` load + `buildBundle` call where `const result = await buildBundle(...)` currently is — replace that single line with these two reads.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test scripts/test/build-bundle.test.js 2>&1 | tail -15`
Expected: noise-class proposal tests pass; earlier build-bundle tests still pass (they pass `pendingProposals: []` implicitly via default).

- [ ] **Step 5: Full suite**

Run: `npm test 2>&1 | tail -6`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-bundle.js scripts/test/build-bundle.test.js
git commit -m "feat(build-bundle): surface alert-batch noise-class proposals (no auto-drop)

When collapse forms an alert-batch, build-bundle proposes an alwaysDelete for
the batch sender via the existing proposed-rules.json + apply-proposals loop —
one-click approve, never auto-dropped. Reuses pattern-discovery's proposalId/
isPendingProposal for idempotency.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task R-6: skill + doc updates

**Files:**
- Modify: `.claude/commands/issues/_reasoner-pass.md`
- Modify: `.claude/commands/issues/issues.md`

- [ ] **Step 1: Update `_reasoner-pass.md` for collapsed groups**

READ `.claude/commands/issues/_reasoner-pass.md`. In the "## What to decide, per email" section, add a paragraph after the intro:

```markdown
**Collapsed groups.** Some bundle items carry a `group` field
(`{ id, kind, isRepresentative, size }`). When `kind` is `exact-dup` or
`alert-batch`, judge ONLY the representative (`isRepresentative: true`) once,
then emit the SAME verdict/issue/next_action for every member msgid in that
group. You do not need to re-read non-representative members — they are
identical or near-identical by construction. This is how cost stays low without
dropping data: one judgment, applied to all members; every member is preserved.
```

- [ ] **Step 2: Update `issues.md` bootstrap + build-bundle + reconcile**

READ `.claude/commands/issues/issues.md`. In the "## Cold-start (bootstrap)" section, replace steps 1-4 with:

```markdown
1. Build the bundle for a wide window: `node scripts/build-bundle.js --since 30d --out data/.last-run-bundle.json`.
   This fetches (paginated, full window), classifies, collapses reasoning units,
   and prints the funnel. **It trashes nothing.**
2. Read `data/.last-run-bundle.json` → reason over the bundle per
   `_reasoner-pass.md` (judge representatives once; emit per-member records).
3. Apply with the bootstrap flag so **everything new lands provisional**:
   `echo '<{records,emailsById,heuristicMsgids,now}>' | node scripts/issue-apply.js data/issues --force-provisional`.
4. Show the provisional list (from `loadProvisional`) and tell the user to
   `graduate` / `merge` / `ignore`.
```

Then find the cold-start line that claims "everything new lands provisional" (in the prior wording) and ensure the normal-run section documents the steady-state heuristic explicitly. In the "## Normal run (assignment)" section, add a note:

```markdown
> Steady-state promotion: outside bootstrap, `issue-apply.js` (without
> `--force-provisional`) promotes a NEW topic to a **real** issue when it has
> >=2 linked emails or a next_action. Bootstrap forces everything provisional
> for the one-time sweep; normal runs trust the heuristic.
```

Also update the normal-run path to use `build-bundle.js`: replace any hand-fetch/classify instructions with "if a fresh `data/.last-run-bundle.json` exists use it; else run `node scripts/build-bundle.js --since <delta>`".

- [ ] **Step 3: Verify both files reference real flags/paths**

Run:
```bash
grep -n "force-provisional\|build-bundle.js\|isRepresentative" .claude/commands/issues/issues.md .claude/commands/issues/_reasoner-pass.md
```
Expected: matches in both files.

- [ ] **Step 4: Commit**

```bash
git add .claude/commands/issues/_reasoner-pass.md .claude/commands/issues/issues.md
git commit -m "docs(issues): collapsed-group handling + bootstrap build-bundle/force-provisional

_reasoner-pass: judge the representative once, emit per-member records.
issues.md: bootstrap uses build-bundle.js + --force-provisional (everything
provisional → user sweeps); steady-state heuristic documented as intentional.
Reconciles the F-1 cold-start contradiction.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task R-7: load-test smoke (manual, user-run — no commit)

After R-1..R-6, validate at scale on real inboxes. This is the design-effectiveness gate, not just "does it run."

- [ ] **Step 1: Full suite green**

Run: `npm test 2>&1 | tail -6` — all pass.

- [ ] **Step 2: Build a wide-window bundle**

Run: `node scripts/build-bundle.js --since 30d`
Expected: prints the funnel line to stderr and `{funnel, out}` to stdout. **Nothing fetched is trashed** (build-bundle never deletes). Note the funnel numbers — `fetched`, `explicitDropped`, `survivors`, `heuristicCandidates`, `reasoningUnits`.

- [ ] **Step 3: Read the funnel as the design-effectiveness verdict**

The pass condition is NOT "it produced a bundle." It is: the **deterministic tiers carry the load** — `explicitDropped + collapse savings` remove most of `fetched`, and `reasoningUnits` is a small fraction of `fetched`. If `reasoningUnits` is high, that is the funnel working: it points at which tier leaks (e.g., many un-collapsed near-dups → tighten collapse; much noise reaching survivors → propose explicit-delete patterns). Record the numbers.

- [ ] **Step 4: Run the bootstrap end-to-end via /issues**

Confirm `data/issues/` is empty (or back it up). Invoke `/issues`. Expected: cold-start uses `build-bundle.js`, reasons over representatives, applies with `--force-provisional` → **all issues land provisional**, nothing trashed, nothing sent. Verify `data/issues/provisional/*.md` populated and `data/issues/*.md` empty.

- [ ] **Step 5: Confirm safety + draft idempotency**

`/issues draft <alias>` saves to Drafts-OfficeOS (never sent) and writes `data/drafts-index.json`. Run it twice on the same issue — the second run should skip (drafts-index key present).

- [ ] **Step 6: Record results**

Append a funnel + findings section to the IT-10 AAR (or a new `2026-06-05-load-test.md` under `docs/superpowers/reports/`). This is the empirical cost-effectiveness baseline.

---

## Self-review

**Spec coverage:**
| Spec requirement | Task |
|---|---|
| `build-bundle.js` (paginated fetch→classify→bundle+funnel) — F-2/F-3/F-5/F-6/F-7 | R-2 |
| `collapse.js` reasoning-unit grouping (Q3-A, data-preserving) | R-1 |
| Funnel report (cost-as-effectiveness instrument) | R-2 |
| `forceProvisional` bootstrap + doc reconcile — F-1 | R-3, R-6 |
| applier stderr validation + compact report — F-2/§4.2 | R-3 |
| `findIssue` union — F-11 | R-4 |
| drafts-index schema/helpers — F-8 | R-4 |
| Noise-class proposals via approve loop — §4.3 | R-5 |
| collapsed-group handling in reasoner prompt | R-6 |
| No processing caps / full pagination | R-2 (collectPages; no cap anywhere) |
| Load test as design-effectiveness gate | R-7 |

**Placeholder scan:** none — all steps carry complete code/commands. The one "confirm signature before wiring" note (R-2 Step 3, `classify` signature) is a verify instruction, not a placeholder; the unit tests don't depend on it.

**Type/name consistency:**
- `groupForReasoning(items) → { groups, byMsgid }`; group shape `{ id, kind, representativeMsgid, memberMsgids }`; byMsgid entry `{ groupId, isRepresentative }` — consistent R-1 ↔ R-2 ↔ R-5.
- `buildBundle({ since, deps, pendingProposals })` → `{ generatedAt, window, bundle, emailsById, funnel, proposals }` — consistent R-2 ↔ R-5; the bundle item `group` field `{ id, kind, isRepresentative, size }` matches what `_reasoner-pass.md` reads (R-6).
- `applyReasonerOutput(records, emailsById, { issuesDir, now, heuristicMsgids, forceProvisional })` — R-3 extends the existing signature; default `forceProvisional=false` preserves the 237-test baseline.
- `findIssue(issuesDir, alias)`, `loadDraftsIndex(path)`, `saveDraftsIndex(path, index)` — R-4, consistent with store conventions.
- Funnel keys (`fetched, explicitDropped, survivors, heuristicCandidates, collapsed{groups,fromMembers,savedJudgments}, reasoningUnits, perAccount`) match the spec's reconciliation `fetched = explicitDropped + survivors + heuristicCandidates`.

---

## After all tasks complete

Hand off to `superpowers:finishing-a-development-branch`. Note: merge coordination with the parallel session's `docs/it10-smoke-test-aar` branch — confirm it has merged (or is idle) before merging this to master, since both share one working tree.
