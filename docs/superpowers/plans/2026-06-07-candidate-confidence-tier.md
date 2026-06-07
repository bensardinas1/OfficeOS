# Candidate-Lane Confidence Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give corroborated-bulk candidate *groups* their `trash` disposition deterministically — the same verdict the reasoner would emit — so the reasoner spends no judgment on obvious bulk, lowering R (reasoningUnits) without silent loss.

**Architecture:** Two new pure modules. `confidence-tier.js` decides which candidate groups are eligible (high structural bulk score **AND** collapse-grouped **AND** all-members-candidate **AND** sender-not-protected) and emits deterministic trash records in `active` mode. `tier-audit.js` compares tier verdicts against reasoner verdicts to catch false-trash (the silent-loss harm), driving the zero-false-trash graduation gate and the live drift guard. `build-bundle.js` orchestrates: computes the per-candidate bulk score, calls the tier, stamps verdicts, extends the funnel, and emits `tierRecords`. `build-bundle` still never deletes — soft-delete stays in the `/issues` skill.

**Tech Stack:** Node.js (ESM, `node --test`, `node:assert/strict`). Pure functions, dependency-injected; no network in tests. Spec: `docs/superpowers/specs/2026-06-07-candidate-confidence-tier-design.md`.

**Repo conventions:**
- Shell anchors to a dead worktree between commands — prefix every command with `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf"` (the live worktree, branch `claude/fervent-buck-9ef3bf`).
- Multi-line commit messages: use a **bash heredoc** (`git commit -F - <<'EOF' … EOF`), never PowerShell `@'…'@` in the Bash tool (it leaks a literal `@`).
- Append this trailer to every commit body: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- `config/companies.json` and `config/account-types.json` are **gitignored** — config steps are local edits, never committed.

---

## File structure

**Create:**
- `scripts/sender-guards.js` — pure sender helpers (`looksAutomated`, `findAccount`, `isProtectedSender`), moved out of `build-bundle.js` to avoid a circular import. Owns "is this sender automated / protected / which account is it".
- `scripts/confidence-tier.js` — pure tier decision engine. Owns "which candidate groups auto-trash, and what records that emits".
- `scripts/tier-audit.js` — pure tier-vs-reasoner comparison + thin CLI. Owns "did the tier ever trash something the reasoner would keep, and should we demote".
- Tests: `scripts/test/sender-guards.test.js`, `scripts/test/confidence-tier.test.js`, `scripts/test/tier-audit.test.js`.

**Modify:**
- `scripts/build-bundle.js` — remove the three sender helpers (import + re-export from `sender-guards.js`); compute `bulkScore` per candidate; call `applyConfidenceTier`; stamp `tier` on representatives; extend the funnel; emit `tierRecords`; thread resolved `candidateTier` config through the CLI account mapping.
- `scripts/test/build-bundle.test.js` — keep existing imports working (re-export); add tier integration tests.
- `.claude/commands/issues/_reasoner-pass.md` — skip active non-audited tier representatives; concat `tierRecords`; run `tier-audit`.
- `.claude/commands/issues/issues.md` — document the tier stage + shadow/active/audit lifecycle.
- `config/account-types.json` (gitignored) — add `candidateTier` defaults.

---

## Task 1: Extract sender guards into a shared module

Behavior-preserving move. The existing `build-bundle.test.js` (Task-1 guard tests) is the safety net — it imports `looksAutomated`/`isProtectedSender` from `build-bundle.js`, so we re-export them there.

**Files:**
- Create: `scripts/sender-guards.js`
- Create: `scripts/test/sender-guards.test.js`
- Modify: `scripts/build-bundle.js` (remove definitions; import + re-export)

- [ ] **Step 1: Create `scripts/sender-guards.js` with the three helpers moved verbatim**

```javascript
/**
 * sender-guards.js
 *
 * Pure sender-classification helpers shared by build-bundle's alert-batch
 * proposal guard and the confidence tier. NO I/O.
 *
 *   looksAutomated(senderEmail, hasListUnsubscribe) -> bool
 *   findAccount(accounts, accountId) -> account | undefined
 *   isProtectedSender(account, senderEmail) -> bool
 */

// Local-part patterns that mark a sender as a machine, not a person. Anchored to
// a word boundary (start, or a . _ + - separator) so "salesnoreply" stays human
// while "billing.noreply" / "alerts+sec" register as automated.
const AUTOMATED_LOCALPART =
  /(?:^|[._+-])(?:no-?reply|do-?not-?reply|notifications?|alerts?|mailer-daemon)(?:$|[._+-])/i;

export function looksAutomated(senderEmail, hasListUnsubscribe) {
  if (hasListUnsubscribe) return true;
  const local = (String(senderEmail || "").split("@")[0] || "").toLowerCase();
  return AUTOMATED_LOCALPART.test(local);
}

export function findAccount(accounts, accountId) {
  return (accounts || []).find(a => a.id === accountId);
}

export function isProtectedSender(account, senderEmail) {
  if (!account) return false;
  const email = String(senderEmail || "").toLowerCase();
  const domain = email.split("@")[1] || "";
  const myDomain = ((account.myEmail || "").split("@")[1] || "").toLowerCase();
  if (myDomain && domain === myDomain) return true;
  const lists = [...(account.prioritySenders || []), ...(account.neverDelete || [])];
  for (const rule of lists) {
    if (rule.type === "email" && (rule.value || "").toLowerCase() === email) return true;
    if (rule.type === "domain" && (rule.value || "").toLowerCase() === domain) return true;
  }
  return false;
}
```

- [ ] **Step 2: Write `scripts/test/sender-guards.test.js`** (moves coverage to its new home)

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksAutomated, findAccount, isProtectedSender } from "../sender-guards.js";

describe("looksAutomated", () => {
  it("flags common automated local-parts", () => {
    for (const a of ["noreply@x.com", "no-reply@x.com", "donotreply@x.com", "notifications@x.com", "alert@x.com", "mailer-daemon@x.com", "billing.noreply@x.com", "alerts+sec@x.com"])
      assert.equal(looksAutomated(a, false), true, a);
  });
  it("does not flag human/processor local-parts", () => {
    for (const a of ["jared.kernodle@p.com", "luis@brickellpay.com", "support@tsys.com", "defender@microsoft.com"])
      assert.equal(looksAutomated(a, false), false, a);
  });
  it("treats List-Unsubscribe as automated regardless of local-part", () => {
    assert.equal(looksAutomated("jane@vendor.com", true), true);
  });
});

describe("findAccount", () => {
  it("finds by id, undefined when absent", () => {
    const accts = [{ id: "a" }, { id: "b" }];
    assert.equal(findAccount(accts, "b").id, "b");
    assert.equal(findAccount(accts, "z"), undefined);
    assert.equal(findAccount(undefined, "a"), undefined);
  });
});

describe("isProtectedSender", () => {
  const account = { myEmail: "me@brickellpay.com", prioritySenders: [{ type: "email", value: "partner@bigco.com" }], neverDelete: [{ type: "domain", value: "processor.com" }] };
  it("protects internal domain, priority email, neverDelete domain", () => {
    assert.equal(isProtectedSender(account, "noreply@brickellpay.com"), true);
    assert.equal(isProtectedSender(account, "partner@bigco.com"), true);
    assert.equal(isProtectedSender(account, "alerts@processor.com"), true);
  });
  it("does not protect unrelated sender or missing account", () => {
    assert.equal(isProtectedSender(account, "noreply@random.com"), false);
    assert.equal(isProtectedSender(undefined, "noreply@x.com"), false);
  });
});
```

- [ ] **Step 3: Run the new test to verify it passes (the helpers exist via the new module)**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && node --test scripts/test/sender-guards.test.js`
Expected: PASS (all 3 describes green).

- [ ] **Step 4: In `scripts/build-bundle.js`, delete the three helper definitions and the `AUTOMATED_LOCALPART` const, and import + re-export from the new module**

Remove the block that defines `AUTOMATED_LOCALPART`, `looksAutomated`, `findAccount`, `isProtectedSender` (currently between `mapOutlookMessage` and `compactEmail`). Add this import near the top with the other imports:

```javascript
import { looksAutomated, isProtectedSender, findAccount } from "./sender-guards.js";
```

And re-export the two that `build-bundle.test.js` imports, so its imports keep working — add right after the import line:

```javascript
export { looksAutomated, isProtectedSender } from "./sender-guards.js";
```

- [ ] **Step 5: Run the full suite to verify the move broke nothing**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && npm test 2>&1 | tail -8`
Expected: `pass 281 … fail 0` (276 prior + 5 new sender-guards tests; build-bundle's own guard tests still pass via re-export).

- [ ] **Step 6: Commit**

```bash
cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && git add scripts/sender-guards.js scripts/test/sender-guards.test.js scripts/build-bundle.js && git commit -F - <<'EOF'
refactor(sender-guards): extract looksAutomated/isProtectedSender/findAccount to shared module

Moved out of build-bundle.js so confidence-tier.js can reuse isProtectedSender
without a circular import. build-bundle re-exports the two helpers its tests
import. Behavior-preserving; full suite green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: confidence-tier — hash, audit sampling, eligibility + shadow mode

**Files:**
- Create: `scripts/confidence-tier.js`
- Create: `scripts/test/confidence-tier.test.js`

- [ ] **Step 1: Write the failing test for the deterministic hash, audit sampling, eligibility, and shadow mode**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashMsgid, isAuditSampled, applyConfidenceTier } from "../confidence-tier.js";

// A 5-member alert-batch of candidates from an automated sender.
function batch({ mode = "shadow", score = 3, size = 5, kind = "alert-batch", tag = "heuristic-delete-candidate", from = "alerts@vendor.com" } = {}) {
  const memberMsgids = Array.from({ length: size }, (_, i) => "m" + i);
  const bundle = memberMsgids.map((id, i) => ({
    msgid: id, account: "biz", tag, from, subject: "Notice", preview: "p",
    bulkScore: i === 0 ? score : score, // rep is m0
    group: { id: "g0", kind, isRepresentative: i === 0, size },
  }));
  const groups = [{ id: "g0", kind, representativeMsgid: "m0", memberMsgids }];
  const accountsById = { biz: { id: "biz", candidateTier: { mode, scoreCutoff: 3, minGroupSize: 4, auditSamplePercent: 0 } } };
  return { bundle, groups, accountsById };
}

describe("hashMsgid / isAuditSampled — deterministic", () => {
  it("hash is stable and non-negative", () => {
    assert.equal(hashMsgid("abc"), hashMsgid("abc"));
    assert.ok(hashMsgid("abc") >= 0);
  });
  it("0% never samples; 100% always samples; same id same answer", () => {
    assert.equal(isAuditSampled("x", 0), false);
    assert.equal(isAuditSampled("x", 100), true);
    assert.equal(isAuditSampled("x", 50), isAuditSampled("x", 50));
  });
});

describe("applyConfidenceTier — eligibility", () => {
  it("eligible group (grouped + score>=cutoff + all candidates) is decided", () => {
    const { bundle, groups, accountsById } = batch();
    const { decisions } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(decisions["m0"].verdict, "trash");
    assert.equal(decisions["m0"].score, 3);
  });
  it("score below cutoff → not eligible", () => {
    const { bundle, groups, accountsById } = batch({ score: 2 });
    const { decisions, stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(decisions["m0"], undefined);
    assert.equal(stats.eligibleGroups, 0);
  });
  it("size below minGroupSize → not eligible", () => {
    const { bundle, groups, accountsById } = batch({ size: 3 });
    const { stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(stats.eligibleGroups, 0);
  });
  it("a single (ungrouped) representative → not eligible", () => {
    const bundle = [{ msgid: "s1", account: "biz", tag: "heuristic-delete-candidate", from: "alerts@vendor.com", bulkScore: 5, group: { id: "g0", kind: "single", isRepresentative: true, size: 1 } }];
    const groups = [{ id: "g0", kind: "single", representativeMsgid: "s1", memberMsgids: ["s1"] }];
    const accountsById = { biz: { id: "biz", candidateTier: { mode: "active", scoreCutoff: 3, minGroupSize: 4 } } };
    const { stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(stats.eligibleGroups, 0);
  });
  it("a survivor member in the group → never trashed (all-members-candidate rule)", () => {
    const { bundle, groups, accountsById } = batch({ mode: "active" });
    bundle[2].tag = "survivor"; // one member is a survivor
    const { decisions, tierRecords, stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(decisions["m0"], undefined);
    assert.equal(tierRecords.length, 0);
    assert.equal(stats.eligibleGroups, 0);
  });
  it("protected sender → excluded even if grouped+high-score", () => {
    const { bundle, groups, accountsById } = batch();
    accountsById.biz.myEmail = "me@vendor.com"; // sender alerts@vendor.com shares the domain
    const { stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(stats.eligibleGroups, 0);
  });
  it("no candidateTier config → no-op", () => {
    const { bundle, groups } = batch();
    const { decisions, stats } = applyConfidenceTier(bundle, groups, { biz: { id: "biz" } });
    assert.equal(decisions["m0"], undefined);
    assert.equal(stats.eligibleGroups, 0);
  });
});

describe("applyConfidenceTier — shadow mode", () => {
  it("stamps a decision but emits NO tierRecords (reasoner still judges)", () => {
    const { bundle, groups, accountsById } = batch({ mode: "shadow" });
    const { decisions, tierRecords, stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(decisions["m0"].mode, "shadow");
    assert.equal(decisions["m0"].audited, false);
    assert.equal(tierRecords.length, 0);
    assert.equal(stats.eligibleGroups, 1);
    assert.equal(stats.trashedGroups, 0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && node --test scripts/test/confidence-tier.test.js`
Expected: FAIL — `does not provide an export named 'hashMsgid'` (module missing).

- [ ] **Step 3: Write `scripts/confidence-tier.js`**

```javascript
/**
 * confidence-tier.js
 *
 * Pure, deterministic candidate-lane confidence tier. NO I/O.
 *
 * Gives a corroborated-bulk candidate GROUP its `trash` disposition
 * deterministically — the same verdict the reasoner would emit — so the reasoner
 * need not spend a judgment on it. The silent-loss risk is quarantined here:
 * a group auto-trashes ONLY when TWO independent signals agree (a high structural
 * bulk score AND a collapse group), every member is a candidate (never trash a
 * survivor that collapsed in), and the sender is not protected. This module only
 * stamps verdicts and emits trash records; soft-delete happens downstream.
 *
 * applyConfidenceTier(bundleItems, groups, accountsById)
 *   -> { decisions, tierRecords, stats }
 */

import { isProtectedSender } from "./sender-guards.js";

export function hashMsgid(s) {
  let h = 5381;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

export function isAuditSampled(msgid, auditSamplePercent) {
  if (!auditSamplePercent || auditSamplePercent <= 0) return false;
  if (auditSamplePercent >= 100) return true;
  return hashMsgid(msgid) % 100 < auditSamplePercent;
}

export function applyConfidenceTier(bundleItems, groups, accountsById = {}) {
  const byMsgid = {};
  for (const it of bundleItems || []) byMsgid[it.msgid] = it;

  const decisions = {};
  const tierRecords = [];
  const blankPer = () => ({ eligibleGroups: 0, trashedGroups: 0, auditedGroups: 0, trashedMembers: 0 });
  const stats = { eligibleGroups: 0, trashedGroups: 0, auditedGroups: 0, trashedMembers: 0, perAccount: {} };

  for (const group of groups || []) {
    if (group.kind !== "alert-batch" && group.kind !== "exact-dup") continue;
    const rep = byMsgid[group.representativeMsgid];
    if (!rep) continue;
    const account = accountsById[rep.account];
    const cfg = account && account.candidateTier;
    if (!cfg || (cfg.mode !== "shadow" && cfg.mode !== "active")) continue;

    // All members must be candidates — never trash a survivor that collapsed in.
    const members = group.memberMsgids.map(id => byMsgid[id]);
    if (members.some(m => !m)) continue;
    if (!members.every(m => m.tag === "heuristic-delete-candidate")) continue;

    // Two independent signals: group size AND structural bulk score.
    const size = group.memberMsgids.length;
    if (size < (cfg.minGroupSize ?? 4)) continue;
    const score = rep.bulkScore ?? 0;
    if (score < (cfg.scoreCutoff ?? 3)) continue;

    // Defense-in-depth: never a protected sender.
    if (isProtectedSender(account, (rep.from || "").toLowerCase())) continue;

    stats.eligibleGroups++;
    const per = (stats.perAccount[rep.account] ||= blankPer());
    per.eligibleGroups++;

    const audited = cfg.mode === "active" && isAuditSampled(group.representativeMsgid, cfg.auditSamplePercent);
    decisions[group.representativeMsgid] = { verdict: "trash", score, groupId: group.id, mode: cfg.mode, audited };

    if (cfg.mode === "active" && !audited) {
      stats.trashedGroups++; per.trashedGroups++;
      stats.trashedMembers += size; per.trashedMembers += size;
      const reason = `tier:bulk-score>=${score}+${group.kind}(${size})`;
      for (const id of group.memberMsgids) {
        tierRecords.push({ msgid: id, verdict: "trash", issue: null, reason, next_action_update: "", waiting_on_update: null });
      }
    } else if (cfg.mode === "active" && audited) {
      stats.auditedGroups++; per.auditedGroups++;
    }
  }

  return { decisions, tierRecords, stats };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && node --test scripts/test/confidence-tier.test.js`
Expected: PASS (hash/sampling, eligibility, shadow describes all green).

- [ ] **Step 5: Commit**

```bash
cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && git add scripts/confidence-tier.js scripts/test/confidence-tier.test.js && git commit -F - <<'EOF'
feat(confidence-tier): eligibility + shadow mode

Pure module. A candidate group is eligible only when grouped (alert-batch/
exact-dup) AND bulkScore>=cutoff AND all members are candidates AND sender not
protected. Shadow mode stamps a decision but emits no tierRecords (reasoner
still judges). Deterministic msgid-hash audit sampling.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: confidence-tier — active mode (tierRecords + audit hold-back) + stats

**Files:**
- Modify: `scripts/test/confidence-tier.test.js` (add active-mode describe)

(The implementation already handles active mode from Task 2; these tests lock the active behavior and stats. If any fails, fix `confidence-tier.js`.)

- [ ] **Step 1: Append the active-mode test describe to `scripts/test/confidence-tier.test.js`**

```javascript
describe("applyConfidenceTier — active mode", () => {
  it("auto-trashes a non-sampled eligible group: tierRecords for EVERY member", () => {
    const { bundle, groups, accountsById } = batch({ mode: "active" });
    accountsById.biz.candidateTier.auditSamplePercent = 0; // none held back
    const { decisions, tierRecords, stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(decisions["m0"].audited, false);
    assert.equal(tierRecords.length, 5, "one trash record per member");
    assert.deepEqual(tierRecords.map(r => r.msgid).sort(), ["m0", "m1", "m2", "m3", "m4"]);
    assert.ok(tierRecords.every(r => r.verdict === "trash" && r.issue === null));
    assert.match(tierRecords[0].reason, /^tier:bulk-score>=3\+alert-batch\(5\)$/);
    assert.equal(stats.trashedGroups, 1);
    assert.equal(stats.trashedMembers, 5);
    assert.equal(stats.auditedGroups, 0);
    assert.equal(stats.perAccount.biz.trashedMembers, 5);
  });

  it("a sampled eligible group is held back: decision.audited=true, NO tierRecords", () => {
    const { bundle, groups, accountsById } = batch({ mode: "active" });
    accountsById.biz.candidateTier.auditSamplePercent = 100; // always hold back
    const { decisions, tierRecords, stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(decisions["m0"].audited, true);
    assert.equal(tierRecords.length, 0);
    assert.equal(stats.trashedGroups, 0);
    assert.equal(stats.auditedGroups, 1);
  });
});
```

- [ ] **Step 2: Run to verify pass (implementation from Task 2 already covers it)**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && node --test scripts/test/confidence-tier.test.js`
Expected: PASS (implementation from Task 2 already emits `reason` as `tier:bulk-score>=3+alert-batch(5)`).

- [ ] **Step 3: Commit**

```bash
cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && git add scripts/test/confidence-tier.test.js && git commit -F - <<'EOF'
test(confidence-tier): lock active-mode tierRecords + audit hold-back + stats

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: build-bundle integration — bulkScore, tier call, funnel, tierRecords, CLI config

**Files:**
- Modify: `scripts/build-bundle.js`
- Modify: `scripts/test/build-bundle.test.js`

- [ ] **Step 1: Write failing integration tests — append to `scripts/test/build-bundle.test.js`**

```javascript
describe("buildBundle — confidence tier integration", () => {
  // 5 same-sender candidates with 3 structural bulk signals (list-unsub + precedence:bulk + bcc).
  function tierDeps(mode) {
    return {
      accounts: [{ id: "biz", accountType: "business", myEmail: "me@brickellpay.com", candidateTier: { mode, scoreCutoff: 3, minGroupSize: 4, auditSamplePercent: 0 } }],
      now: "2026-06-05T12:00:00Z",
      fetchAllFn: async () => Array.from({ length: 5 }, (_, i) => ({
        id: "b" + i, from: "blast@vendor.com", fromName: "Vendor", subject: `Deal #${i}`, preview: "buy",
        receivedAt: "2026-06-05T08:00:00Z", hasListUnsubscribe: true, precedence: "bulk", toRecipients: "list@vendor.com", ccRecipients: "",
      })),
      classifyFn: (emails) => {
        const r = { categories: {}, deletionCandidates: [], explicitDeletions: [], heuristicDeletions: [] };
        for (const e of emails) { r.deletionCandidates.push(e); r.heuristicDeletions.push(e); }
        return r;
      },
    };
  }

  it("computes bulkScore on candidates", async () => {
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: tierDeps("shadow") });
    const b0 = out.bundle.find(b => b.msgid === "b0");
    assert.ok(b0.bulkScore >= 3, `expected bulkScore>=3, got ${b0.bulkScore}`);
  });

  it("shadow mode: stamps tier on representative, emits no tierRecords, reasoningUnits unchanged", async () => {
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: tierDeps("shadow") });
    const rep = out.bundle.find(b => b.tier);
    assert.equal(rep.tier.mode, "shadow");
    assert.equal(rep.tier.verdict, "trash");
    assert.equal((out.tierRecords || []).length, 0);
    assert.equal(out.funnel.reasoningUnits, out.funnel.collapsed.groups, "shadow does not reduce reasoningUnits");
    assert.equal(out.funnel.tier.mode, "shadow");
    assert.equal(out.funnel.tier.trashedGroups, 0);
  });

  it("active mode: emits tierRecords for all members and drops reasoningUnits by the trashed group", async () => {
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: tierDeps("active") });
    assert.equal(out.tierRecords.length, 5, "one trash record per batch member");
    assert.equal(out.funnel.tier.trashedGroups, 1);
    assert.equal(out.funnel.tier.trashedMembers, 5);
    assert.equal(out.funnel.reasoningUnits, out.funnel.collapsed.groups - 1, "active drops R by the auto-trashed group");
  });

  it("funnel still reconciles fetched = explicitDropped + survivors + heuristicCandidates", async () => {
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: tierDeps("active") });
    const f = out.funnel;
    assert.equal(f.fetched, f.explicitDropped + f.survivors + f.heuristicCandidates);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && node --test scripts/test/build-bundle.test.js 2>&1 | tail -20`
Expected: FAIL — `b0.bulkScore` undefined / `out.tierRecords` undefined / `out.funnel.tier` undefined.

- [ ] **Step 3: Wire the tier into `scripts/build-bundle.js`**

Add imports near the top (alongside existing imports):

```javascript
import { detectBulkSignals } from "./classify-emails.js";
import { applyConfidenceTier } from "./confidence-tier.js";
```

In the `toCollapse.push({...})` block inside `buildBundle`, attach `bulkScore` for candidates. Replace the existing push with:

```javascript
      const item = {
        msgid: e.id, account: acct.id, tag,
        from: e.from, fromName: e.fromName, subject: e.subject,
        preview: (e.preview || "").slice(0, 200),
        receivedAt: e.receivedAt || e.received, hasListUnsubscribe: !!e.hasListUnsubscribe,
      };
      if (tag === "heuristic-delete-candidate") item.bulkScore = detectBulkSignals(e, acct.myEmail).score;
      toCollapse.push(item);
```

After the loop that stamps `item.group` and pushes to `bundle` (right before the proposals block), insert the tier call:

```javascript
  // Confidence tier — deterministic disposition of corroborated-bulk candidate
  // groups (the same verdict the reasoner would emit), gated + validated. Stamps
  // representatives; emits tierRecords (active mode only). build-bundle never deletes.
  const accountsById = {};
  for (const a of accounts) accountsById[a.id] = a;
  const tier = applyConfidenceTier(bundle, groups, accountsById);
  for (const [repMsgid, d] of Object.entries(tier.decisions)) {
    const item = bundle.find(b => b.msgid === repMsgid);
    if (item) item.tier = { verdict: d.verdict, score: d.score, mode: d.mode, audited: d.audited };
  }
  const tierMode = (() => {
    const modes = new Set(accounts.map(a => a.candidateTier && a.candidateTier.mode).filter(Boolean));
    if (modes.has("active")) return "active";
    if (modes.has("shadow")) return "shadow";
    return "off";
  })();
```

Replace the funnel construction:

```javascript
  const fromMembers = toCollapse.length;
  const totalGroups = groups.length;
  const reasoningUnits = totalGroups - tier.stats.trashedGroups;
  const funnel = {
    fetched, explicitDropped, survivors, heuristicCandidates,
    collapsed: { groups: totalGroups, fromMembers, savedJudgments: fromMembers - totalGroups },
    reasoningUnits,
    tier: {
      mode: tierMode,
      eligibleGroups: tier.stats.eligibleGroups,
      trashedGroups: tier.stats.trashedGroups,
      auditedGroups: tier.stats.auditedGroups,
      trashedMembers: tier.stats.trashedMembers,
      perAccount: tier.stats.perAccount,
    },
    perAccount,
  };
```

Replace the return statement to include `tierRecords`:

```javascript
  return { generatedAt: now, window: { since: sinceIso }, bundle, emailsById, funnel, warnings, proposals, tierRecords: tier.tierRecords };
```

- [ ] **Step 4: Run the build-bundle tests to verify pass**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && node --test scripts/test/build-bundle.test.js 2>&1 | tail -12`
Expected: PASS (tier integration describe green; the pre-existing funnel/proposal tests still pass — they have no `candidateTier`, so `tier.mode==="off"`, `trashedGroups===0`, `reasoningUnits===collapsed.groups`).

- [ ] **Step 5: Thread resolved `candidateTier` config through the CLI account mapping**

In the `if (process.argv[1] && process.argv[1].endsWith("build-bundle.js"))` block, load account-types and resolve `candidateTier` (account override wins over type default). Replace the `accounts` mapping:

```javascript
  const accountTypes = JSON.parse(readFileSync(join(root, "config/account-types.json"), "utf-8"));
  const accounts = companies.companies
    .filter(c => !wanted || wanted.has(c.id))
    .map(c => {
      const typeCfg = accountTypes[c.accountType] || {};
      return {
        id: c.id, accountType: c.accountType, provider: c.provider,
        myEmail: c.myEmail, prioritySenders: c.prioritySenders, neverDelete: c.neverDelete,
        candidateTier: c.candidateTier ?? typeCfg.candidateTier,
      };
    });
```

(`readFileSync`, `join`, `root` are already in scope in that block.)

- [ ] **Step 6: Run the full suite**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && npm test 2>&1 | tail -8`
Expected: `fail 0`.

- [ ] **Step 7: Commit**

```bash
cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && git add scripts/build-bundle.js scripts/test/build-bundle.test.js && git commit -F - <<'EOF'
feat(build-bundle): integrate confidence tier (bulkScore, tierRecords, funnel)

Compute detectBulkSignals score per candidate; call applyConfidenceTier after
collapse; stamp tier verdict on representatives; emit tierRecords; funnel gains a
tier stage with reasoningUnits = groups - trashedGroups. CLI resolves
candidateTier (account override wins over account-type default). build-bundle
still never deletes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: tier-audit — pure comparison module

**Files:**
- Create: `scripts/tier-audit.js`
- Create: `scripts/test/tier-audit.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditTier } from "../tier-audit.js";

// bundle items carrying tier verdicts (representatives), + reasoner records.
function fixture() {
  const bundle = [
    { msgid: "a", account: "biz", from: "blast@v.com", subject: "Deal", tier: { verdict: "trash" } },
    { msgid: "b", account: "biz", from: "news@v.com", subject: "Update", tier: { verdict: "trash" } },
    { msgid: "c", account: "biz", from: "x@v.com", subject: "Plain", /* no tier */ },
  ];
  return bundle;
}

describe("auditTier — confusion matrix", () => {
  it("counts agreement (tier=trash & reasoner=trash)", () => {
    const r = auditTier(fixture(), [{ msgid: "a", verdict: "trash" }, { msgid: "b", verdict: "trash" }]);
    assert.equal(r.agree, 2);
    assert.equal(r.falseTrash, 0);
    assert.equal(r.falseTrashRate, 0);
    assert.equal(r.demoteRecommended, false);
  });

  it("flags false-trash (tier=trash & reasoner=keep) and lists it in full", () => {
    const r = auditTier(fixture(), [{ msgid: "a", verdict: "trash" }, { msgid: "b", verdict: "keep" }]);
    assert.equal(r.agree, 1);
    assert.equal(r.falseTrash, 1);
    assert.equal(r.falseTrashRate, 50);
    assert.equal(r.falseTrashList.length, 1);
    assert.deepEqual(r.falseTrashList[0], { msgid: "b", account: "biz", sender: "news@v.com", subject: "Update" });
    assert.equal(r.demoteRecommended, true); // default threshold 0
  });

  it("ignores tier items the reasoner never judged (active non-audited)", () => {
    const r = auditTier(fixture(), [{ msgid: "a", verdict: "trash" }]); // b not judged
    assert.equal(r.agree, 1);
    assert.equal(r.falseTrash, 0);
  });

  it("ignores items without a tier verdict", () => {
    const r = auditTier(fixture(), [{ msgid: "c", verdict: "keep" }]);
    assert.equal(r.agree, 0);
    assert.equal(r.falseTrash, 0);
  });

  it("per-account isolation + threshold tolerance", () => {
    const bundle = [
      { msgid: "a", account: "biz", from: "x@v.com", subject: "s", tier: { verdict: "trash" } },
      { msgid: "p", account: "personal", from: "y@w.com", subject: "t", tier: { verdict: "trash" } },
    ];
    const r = auditTier(bundle, [{ msgid: "a", verdict: "keep" }, { msgid: "p", verdict: "trash" }], { demoteThresholdPercent: 60 });
    assert.equal(r.perAccount.biz.falseTrash, 1);
    assert.equal(r.perAccount.biz.falseTrashRate, 100);
    assert.equal(r.perAccount.biz.demoteRecommended, true);
    assert.equal(r.perAccount.personal.falseTrash, 0);
    assert.equal(r.perAccount.personal.demoteRecommended, false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && node --test scripts/test/tier-audit.test.js`
Expected: FAIL — `does not provide an export named 'auditTier'`.

- [ ] **Step 3: Write `scripts/tier-audit.js`**

```javascript
/**
 * tier-audit.js
 *
 * Pure. Compares confidence-tier verdicts (stamped on bundle representatives)
 * against reasoner verdicts to detect FALSE-TRASH — tier=trash where the reasoner
 * would KEEP. False-trash is the silent-loss harm; this is the metric the
 * graduation gate (must be zero) and the live drift guard watch.
 *
 * Only items that carry a tier verdict AND were judged by the reasoner are
 * comparable — active non-audited groups are skipped by the reasoner, so they are
 * (correctly) absent from this comparison.
 *
 * auditTier(bundle, reasonerRecords, { demoteThresholdPercent })
 *   -> { agree, falseTrash, falseTrashRate, falseTrashList, demoteRecommended, perAccount }
 */

export function auditTier(bundle, reasonerRecords, { demoteThresholdPercent = 0 } = {}) {
  const verdictByMsgid = {};
  for (const r of reasonerRecords || []) if (r && r.msgid) verdictByMsgid[r.msgid] = r.verdict;

  let agree = 0, falseTrash = 0;
  const falseTrashList = [];
  const per = {};
  const rate = (ft, ag) => (ft + ag) === 0 ? 0 : (ft / (ft + ag)) * 100;

  for (const it of bundle || []) {
    if (!it.tier || it.tier.verdict !== "trash") continue;
    const reasoner = verdictByMsgid[it.msgid];
    if (reasoner === undefined) continue; // reasoner didn't judge it — nothing to compare
    const p = (per[it.account] ||= { agree: 0, falseTrash: 0 });
    if (reasoner === "keep") {
      falseTrash++; p.falseTrash++;
      falseTrashList.push({ msgid: it.msgid, account: it.account, sender: it.from, subject: it.subject });
    } else {
      agree++; p.agree++;
    }
  }

  const perAccount = {};
  for (const [acct, c] of Object.entries(per)) {
    const r = rate(c.falseTrash, c.agree);
    perAccount[acct] = { agree: c.agree, falseTrash: c.falseTrash, falseTrashRate: r, demoteRecommended: r > demoteThresholdPercent };
  }
  const falseTrashRate = rate(falseTrash, agree);
  return { agree, falseTrash, falseTrashRate, falseTrashList, demoteRecommended: falseTrashRate > demoteThresholdPercent, perAccount };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && node --test scripts/test/tier-audit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && git add scripts/tier-audit.js scripts/test/tier-audit.test.js && git commit -F - <<'EOF'
feat(tier-audit): pure tier-vs-reasoner false-trash comparison

auditTier computes the confusion matrix over bundle tier verdicts vs reasoner
records, surfaces the full falseTrashList (no compression), and flags
demoteRecommended per account. Drives the zero-false-trash graduation gate and
the live drift guard.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: tier-audit CLI — report + optional auto-demote

A thin CLI wrapper (like build-bundle's) that reads a bundle file + a reasoner-records file, prints the audit JSON, and with `--apply-demote` flips flagged accounts to `mode:"shadow"` in `config/companies.json` via the existing atomic writer. Pure `auditTier` stays the tested core; the CLI is thin wiring.

**Files:**
- Modify: `scripts/tier-audit.js` (append CLI block)

- [ ] **Step 1: Append the CLI block to `scripts/tier-audit.js`**

```javascript
if (process.argv[1] && process.argv[1].endsWith("tier-audit.js")) {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { atomicWrite } = await import("./fs-utils.js");

  const args = process.argv.slice(2);
  const flags = { applyDemote: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bundle") flags.bundle = args[++i];
    else if (args[i] === "--records") flags.records = args[++i];
    else if (args[i] === "--threshold") flags.threshold = Number(args[++i]);
    else if (args[i] === "--apply-demote") flags.applyDemote = true;
  }
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = join(__dirname, "..");
  const bundleObj = JSON.parse(readFileSync(flags.bundle || join(root, "data/.last-run-bundle.json"), "utf-8"));
  const records = JSON.parse(readFileSync(flags.records, "utf-8"));
  const result = auditTier(bundleObj.bundle, records, { demoteThresholdPercent: flags.threshold ?? 0 });

  if (flags.applyDemote) {
    const cfgPath = join(root, "config/companies.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const demoted = [];
    for (const [acct, r] of Object.entries(result.perAccount)) {
      if (!r.demoteRecommended) continue;
      const c = cfg.companies.find(x => x.id === acct);
      if (c && c.candidateTier && c.candidateTier.mode === "active") {
        c.candidateTier.mode = "shadow";
        demoted.push(acct);
      }
    }
    if (demoted.length) {
      atomicWrite(cfgPath, JSON.stringify(cfg, null, 2));
      process.stderr.write(`tier-audit: DEMOTED to shadow (drift): ${demoted.join(", ")}\n`);
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
```

- [ ] **Step 2: Verify the CLI parses and the pure tests still pass**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && node --test scripts/test/tier-audit.test.js && node --check scripts/tier-audit.js && echo OK`
Expected: tests PASS, `node --check` prints nothing (syntax OK), then `OK`.

- [ ] **Step 3: Commit**

```bash
cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && git add scripts/tier-audit.js && git commit -F - <<'EOF'
feat(tier-audit): thin CLI — report + --apply-demote (active->shadow on drift)

Reads a bundle + reasoner-records file, prints the audit JSON; --apply-demote
atomically flips drift-flagged accounts back to shadow in companies.json.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7: Golden flow — end-to-end batch through build-bundle (active)

Proves a clean corroborated-bulk batch flows fetch→classify→collapse→tier(active)→`tierRecords` ready for `issue-apply`, and that `emailsById` still carries every member so nothing is unlinkable.

**Files:**
- Modify: `scripts/test/build-bundle.test.js` (add golden describe)

- [ ] **Step 1: Append the golden test**

```javascript
describe("buildBundle — golden: corroborated-bulk batch auto-trashes end-to-end", () => {
  it("every batch member is in emailsById and has a trash tierRecord; R drops by one group", async () => {
    const deps = {
      accounts: [{ id: "biz", accountType: "business", myEmail: "me@brickellpay.com", candidateTier: { mode: "active", scoreCutoff: 3, minGroupSize: 4, auditSamplePercent: 0 } }],
      now: "2026-06-05T12:00:00Z",
      fetchAllFn: async () => Array.from({ length: 6 }, (_, i) => ({
        id: "g" + i, from: "promos@shop.com", fromName: "Shop", subject: `Sale #${i}`, preview: "save now",
        receivedAt: "2026-06-05T08:00:00Z", hasListUnsubscribe: true, precedence: "bulk", toRecipients: "list@shop.com", ccRecipients: "",
      })),
      classifyFn: (emails) => {
        const r = { categories: {}, deletionCandidates: [], explicitDeletions: [], heuristicDeletions: [] };
        for (const e of emails) { r.deletionCandidates.push(e); r.heuristicDeletions.push(e); }
        return r;
      },
    };
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps });
    // all 6 linkable
    for (let i = 0; i < 6; i++) assert.ok(out.emailsById["g" + i], `g${i} in emailsById`);
    // one trash record per member, all trash
    assert.equal(out.tierRecords.length, 6);
    assert.ok(out.tierRecords.every(r => r.verdict === "trash"));
    assert.deepEqual(out.tierRecords.map(r => r.msgid).sort(), ["g0", "g1", "g2", "g3", "g4", "g5"]);
    // R reduced by exactly the one auto-trashed group
    assert.equal(out.funnel.reasoningUnits, out.funnel.collapsed.groups - 1);
    assert.equal(out.funnel.tier.trashedGroups, 1);
  });
});
```

- [ ] **Step 2: Run to verify pass**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && node --test scripts/test/build-bundle.test.js 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && git add scripts/test/build-bundle.test.js && git commit -F - <<'EOF'
test(build-bundle): golden — corroborated-bulk batch auto-trashes, all members linkable

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 8: Skill + config wiring (docs + gitignored config)

**Files:**
- Modify: `.claude/commands/issues/_reasoner-pass.md`
- Modify: `.claude/commands/issues/issues.md`
- Modify: `config/account-types.json` (gitignored — local edit, NOT committed)

- [ ] **Step 1: Add the tier rule to `_reasoner-pass.md`**

In the "Collapsed groups" subsection, add this paragraph immediately after the existing collapsed-group instructions:

```markdown
**Confidence-tier verdicts.** Some representatives carry a `tier` field
(`{ verdict, score, mode, audited }`). When `tier.mode === "active"` **and**
`tier.audited === false`, that group has ALREADY been dispositioned
deterministically as `trash` — do NOT judge it and do NOT emit records for it;
the bundle's `tierRecords` already cover every member. When `tier.mode ===
"shadow"`, OR `tier.audited === true`, judge the representative NORMALLY (these
are the validation/drift-audit samples — your verdict is the ground truth the
audit compares the tier against). Representatives with no `tier` field are judged
as usual.
```

And add this to the "Output" section, after the JSON-array paragraph:

```markdown
**After reasoning:** the skill concatenates the bundle's `tierRecords` with your
records before invoking `scripts/issue-apply.js`, then runs
`scripts/tier-audit.js --bundle <bundle> --records <your-records> --apply-demote`
over the run. Any false-trash (tier trashed something you kept) demotes that
account to `shadow` and is surfaced in full — never summarized.
```

- [ ] **Step 2: Document the tier stage in `issues.md`**

Find the section that describes the bundle→reason→apply bootstrap flow and add a bullet:

```markdown
- **Confidence tier (steady-state cost lever).** `build-bundle.js` deterministically
  dispositions corroborated-bulk candidate groups (high structural bulk score AND a
  collapse group AND all-members-candidate AND sender-not-protected) as `trash`,
  emitting `tierRecords` so the reasoner spends no judgment on obvious bulk. Lifecycle
  per account in `config/companies.json` → `candidateTier.mode`: absent = off;
  `shadow` = stamp + validate (reasoner still judges); `active` = auto-trash with a
  sampled hold-back audited every run. Drift demotes `active`→`shadow` automatically.
  Soft-delete only — `build-bundle` never deletes; the skill trashes via the existing
  connectors after `issue-apply`.
```

- [ ] **Step 3: Add `candidateTier` defaults to `config/account-types.json` (gitignored — local only)**

Add a `candidateTier` key to each account type. Conservative shipping default = `shadow`:

```json
"candidateTier": { "mode": "shadow", "scoreCutoff": 3, "minGroupSize": 4, "auditSamplePercent": 10, "demoteThresholdPercent": 0 }
```

Add it under both the `business` and `personal` type objects. Verify the file still parses:

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && node -e "JSON.parse(require('fs').readFileSync('config/account-types.json','utf8')); console.log('account-types.json OK')"`
Expected: `account-types.json OK`.

- [ ] **Step 4: Run the full suite once more**

Run: `cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && npm test 2>&1 | tail -8`
Expected: `fail 0` (≈ 295+ tests).

- [ ] **Step 5: Commit the docs (config is gitignored, nothing to add for it)**

```bash
cd "/d/OneDrive - Brickell Payments (WORKFORCE)/Documents/OfficeOS/.claude/worktrees/fervent-buck-9ef3bf" && git add .claude/commands/issues/_reasoner-pass.md .claude/commands/issues/issues.md && git commit -F - <<'EOF'
docs(issues): document confidence-tier stage + reasoner skip rule

_reasoner-pass: skip active non-audited tier representatives, judge shadow/audited
normally, concat tierRecords, run tier-audit with --apply-demote. issues.md:
document the shadow/active/audit lifecycle. Config defaults live in the gitignored
account-types.json (candidateTier, shipping mode:shadow).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Validation (manual, post-implementation — graduation gate)

Not a code task; the operator runs this to graduate an account from `shadow` to `active`:

1. Set the target account's `candidateTier.mode = "shadow"` in `config/companies.json`.
2. `node scripts/build-bundle.js --since 30d --accounts <acct>` → produces `data/.last-run-bundle.json` with tier verdicts stamped (shadow → reasoner still judges all).
3. Run `/issues` (or the reasoner pass) over the bundle; save the reasoner records JSON to a file.
4. `node scripts/tier-audit.js --records <records.json>` → inspect `falseTrash` and `falseTrashList`.
5. **Graduate only if `falseTrash === 0`.** Pick `scoreCutoff` as the lowest value still yielding zero false-trash (re-run step 4 at candidate cutoffs). Then set `candidateTier.mode = "active"`.
6. Steady-state: the audited sample is checked every run via `tier-audit --apply-demote`; drift auto-demotes to `shadow`.

---

## Self-review notes (completed)

- **Spec coverage:** confidence-tier (Tasks 2–3), tier-audit (Tasks 5–6), build-bundle integration + funnel + CLI config (Task 4), shadow/active/audit lifecycle + reasoner skip (Task 8), graduation gate + drift demote (Task 6 CLI + Validation section), golden flow (Task 7), all-members-candidate silent-loss guard (Task 2), structural-only score (Task 4 uses `detectBulkSignals`). The sender-guards extraction (Task 1) resolves the circular-import the spec's module boundaries imply.
- **Placeholder scan:** none — every code/test step is complete and runnable.
- **Type consistency:** `applyConfidenceTier(bundleItems, groups, accountsById) → { decisions, tierRecords, stats }`; decision shape `{ verdict, score, groupId, mode, audited }`; tierRecord shape matches `_reasoner-pass` records `{ msgid, verdict, issue, reason, next_action_update, waiting_on_update }` with `reason` formatted `tier:bulk-score>=<N>+<kind>(<size>)`; `auditTier(bundle, reasonerRecords, { demoteThresholdPercent }) → { agree, falseTrash, falseTrashRate, falseTrashList, demoteRecommended, perAccount }`. Funnel `tier` object fields match between Task 4 build code and Task 4 tests.
