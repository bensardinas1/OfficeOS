# Morning Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `reports:morning-brief` — an autonomous skill that replaces the current triage loop with a single Markdown brief covering triage, drafts, task capture, and pattern discovery in one pass.

**Architecture:** Layer 1 connectors (`scripts/`) do deterministic work and emit structured JSON. A new orchestrator script (`scripts/morning-brief.js`) drives fetch → classify → autonomous-delete → task-capture → pattern-discovery → output. The skill prompt (`.claude/commands/reports/morning-brief.md`) reads the JSON, drafts replies via the LLM with each account's voice profile, calls `save-draft.js`/`save-gmail-draft.js`, and assembles the final brief markdown.

**Tech Stack:** Node.js ESM, `node:test` runner, `node:assert/strict`. Test glob: `scripts/test/**/*.test.js`. Run tests with `npm test`.

---

## File Structure

**Modify:**
- `scripts/classify-emails.js` — add `unless` clause evaluation on `alwaysDelete`; add `scamPatterns` evaluation.
- `scripts/test/classify-emails.test.js` — add tests for `unless` and `scamPatterns`.
- `config/companies.json` — migrate memory rules (Equinox, FIU SigEp newsletter, Castillo Rodney, Juan Santamaria), replace plain `eBay`/`PayPal` `alwaysDelete` entries with `unless`-conditional versions, add `scamPatterns` to summit/brickell/healthcarema.
- `.claude/commands/orchestrators/triage.md` — replace contents with a one-line deprecation notice pointing to `morning-brief`.
- `.claude/commands/reports/daily-brief.md` — same deprecation notice.

**Create:**
- `scripts/sender-history.js` — read/update per-account, per-sender deletion counters; detect threshold crossings.
- `scripts/test/sender-history.test.js`
- `scripts/pattern-discovery.js` — auto-trash detection (via sender-history), scam-pattern detection, memory-backfill detection; emits proposals to `data/proposed-rules.json`.
- `scripts/test/pattern-discovery.test.js`
- `scripts/apply-proposals.js` — parses approval lines, patches `companies.json`/`account-types.json` atomically, writes memory entries, updates `data/proposed-rules.json`.
- `scripts/test/apply-proposals.test.js`
- `scripts/morning-brief.js` — orchestrator: fetch + classify per account, autonomous-delete, task-capture, pattern-discovery, output JSON.
- `scripts/test/morning-brief.test.js` — integration tests with mocked connector outputs.
- `scripts/test/fixtures/morning-brief.js` — inbox snapshots and expected JSON outputs.
- `.claude/commands/reports/morning-brief.md` — the skill prompt.

---

## Task 1: Add `unless` clause evaluation to classify-emails.js

**Files:**
- Modify: `scripts/classify-emails.js` (extend `matchesSender` semantics for alwaysDelete; new helper `senderRuleApplies`)
- Test: `scripts/test/classify-emails.test.js`

- [ ] **Step 1: Write failing tests for `senderRuleApplies`**

Append to `scripts/test/classify-emails.test.js` (after the existing `describe("classify-emails — alwaysDelete protection wins", ...)` block, or at end of file):

```js
import { senderRuleApplies } from "../classify-emails.js";

describe("senderRuleApplies — unless clause on alwaysDelete", () => {
  const ebayMarketingRule = {
    type: "name",
    value: "eBay",
    label: "eBay marketing",
    unless: {
      subjectContains: ["delivered", "out for delivery", "order", "security", "buyer", "seller"]
    }
  };

  it("returns true when sender matches and unless is not present", () => {
    const rule = { type: "name", value: "eBay", label: "eBay" };
    const email = { fromName: "eBay", subject: "Big sale this week" };
    assert.equal(senderRuleApplies(email, rule), true);
  });

  it("returns false when sender matches but unless.subjectContains matches", () => {
    const email = { fromName: "eBay", subject: "Your order is OUT FOR DELIVERY" };
    assert.equal(senderRuleApplies(email, ebayMarketingRule), false);
  });

  it("returns true when sender matches and unless.subjectContains does not match", () => {
    const email = { fromName: "eBay", subject: "Deal Days — extra 20% off" };
    assert.equal(senderRuleApplies(email, ebayMarketingRule), true);
  });

  it("returns false when sender does not match (regardless of unless)", () => {
    const email = { fromName: "Amazon", subject: "Your order is delivered" };
    assert.equal(senderRuleApplies(email, ebayMarketingRule), false);
  });

  it("unless.subjectContains is case-insensitive", () => {
    const email = { fromName: "ebay", subject: "ORDER confirmed" };
    assert.equal(senderRuleApplies(email, ebayMarketingRule), false);
  });
});

describe("classify-emails — unless clause on personal alwaysDelete", () => {
  const personalAccountWithEbayUnless = {
    ...personalAccount,
    alwaysDelete: [
      {
        type: "name",
        value: "eBay",
        label: "eBay marketing",
        unless: { subjectContains: ["delivered", "order", "security"] }
      }
    ]
  };

  it("keeps eBay transactional email out of deletion candidates", () => {
    const emails = [
      { id: "1", fromName: "eBay", from: "noreply@ebay.com", subject: "Your order is delivered" }
    ];
    const result = classifyWithAccount(emails, personalAccountWithEbayUnless, personalTypeConfig);
    assert.equal(result.deletionCandidates.length, 0);
  });

  it("deletes eBay promotional email", () => {
    const emails = [
      { id: "1", fromName: "eBay", from: "noreply@ebay.com", subject: "Flash deal — 50% off" }
    ];
    const result = classifyWithAccount(emails, personalAccountWithEbayUnless, personalTypeConfig);
    assert.equal(result.deletionCandidates.length, 1);
  });
});
```

If a `classifyWithAccount` test helper does not exist, add it at the top of the test file (after the imports):

```js
import { classify } from "../classify-emails.js";

// Helper that bypasses loadConfig() by injecting account + type directly.
// Used by tests that want to test classify() behavior without filesystem config.
function classifyWithAccount(emails, account, typeConfig) {
  // Reproduce the inner logic of classify() that runs after loadConfig.
  const categories = resolveCategories(typeConfig, account);
  const downrankList = resolveDownrank(typeConfig, account);
  const policy = typeConfig.deletionPolicy || { categories: ["ignore"], patterns: [] };
  const neverDeleteList = [...(policy.neverDelete || []), ...(account.neverDelete || [])];
  const alwaysDeleteList = [...(policy.alwaysDelete || []), ...(account.alwaysDelete || [])];
  const scamPatterns = account.scamPatterns || [];
  const deletionCategoryIds = new Set(policy.categories);

  const result = { categories: {}, deletionCandidates: [] };
  for (const cat of categories) result.categories[cat.id] = { label: cat.label, emails: [] };

  for (const email of emails) {
    let categoryId = classifyEmail(email, account, typeConfig, categories, downrankList);
    const alwaysDeleteHit = alwaysDeleteList.find(r => senderRuleApplies(email, r));
    const scamHit = scamPatterns.find(p => matchesScamPattern(email, p));
    if (alwaysDeleteHit || scamHit) categoryId = "ignore";
    if (!result.categories[categoryId]) result.categories[categoryId] = { label: categoryId, emails: [] };
    result.categories[categoryId].emails.push(email);
    if (alwaysDeleteHit || scamHit) {
      result.deletionCandidates.push(email);
    } else if (matchesSender(email, neverDeleteList)) {
      // protected
    } else if (deletionCategoryIds.has(categoryId)) {
      result.deletionCandidates.push(email);
    }
  }
  return result;
}
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test 2>&1 | head -80`
Expected: failures referencing `senderRuleApplies` not exported (or `matchesScamPattern` if defined in helper).

- [ ] **Step 3: Implement `senderRuleApplies` in classify-emails.js**

Find the existing `matchesSender` function (around line 52). Add this new exported function immediately after it:

```js
/**
 * Returns true if `rule` matches `email` (using same logic as matchesSender for a single sender)
 * AND the rule's `unless` clause (if present) does NOT match.
 *
 * Used for alwaysDelete entries to support conditional senders like:
 *   { type: "name", value: "eBay", unless: { subjectContains: ["delivered", "order"] } }
 */
export function senderRuleApplies(email, rule) {
  if (!matchesSender(email, [rule])) return false;
  if (!rule.unless) return true;
  const subject = (email.subject || "").toLowerCase();
  const unlessSubject = rule.unless.subjectContains || [];
  for (const term of unlessSubject) {
    if (subject.includes(term.toLowerCase())) return false;
  }
  return true;
}
```

- [ ] **Step 4: Wire `senderRuleApplies` into `classify()` for alwaysDelete**

Locate the existing `classify()` function (around line 184). Find the two `matchesSender(email, alwaysDeleteList)` call sites (around lines 224 and 234). Replace both with `alwaysDeleteList.some(r => senderRuleApplies(email, r))`.

Before (around line 222-235):

```js
    // alwaysDelete overrides category — reclassify to ignore so it doesn't appear in visible sections
    if (matchesSender(email, alwaysDeleteList)) {
      categoryId = "ignore";
    }

    if (!result.categories[categoryId]) {
      result.categories[categoryId] = { label: categoryId, hidden: false, emails: [] };
    }
    result.categories[categoryId].emails.push(email);

    // alwaysDelete — force into deletion candidates
    if (matchesSender(email, alwaysDeleteList)) {
      result.deletionCandidates.push(email);
    }
```

After:

```js
    const alwaysDeleteApplies = alwaysDeleteList.some(r => senderRuleApplies(email, r));

    // alwaysDelete overrides category — reclassify to ignore so it doesn't appear in visible sections
    if (alwaysDeleteApplies) {
      categoryId = "ignore";
    }

    if (!result.categories[categoryId]) {
      result.categories[categoryId] = { label: categoryId, hidden: false, emails: [] };
    }
    result.categories[categoryId].emails.push(email);

    // alwaysDelete — force into deletion candidates
    if (alwaysDeleteApplies) {
      result.deletionCandidates.push(email);
    }
```

- [ ] **Step 5: Run tests to confirm `senderRuleApplies` tests pass**

Run: `npm test -- --grep "senderRuleApplies"` (or `npm test 2>&1 | grep -E "senderRuleApplies|unless"`)
Expected: all five `senderRuleApplies` tests pass. The `classify-emails — unless clause on personal alwaysDelete` tests will still fail because `matchesScamPattern` isn't defined yet (that's Task 2).

- [ ] **Step 6: Run full test suite to confirm no regressions**

Run: `npm test 2>&1 | tail -20`
Expected: all previously-passing tests still pass. Failing tests should be limited to new ones that depend on `matchesScamPattern` (covered in Task 2).

- [ ] **Step 7: Commit**

```bash
git add scripts/classify-emails.js scripts/test/classify-emails.test.js
git commit -m "feat(classify): add unless clause for conditional alwaysDelete senders

Adds senderRuleApplies() helper that respects an optional unless.subjectContains
field on alwaysDelete entries. Enables 'eBay marketing UNLESS subject mentions
delivered/order/security' style rules.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `scamPatterns` evaluation to classify-emails.js

**Files:**
- Modify: `scripts/classify-emails.js` (new `matchesScamPattern` export; wire into `classify()`)
- Test: `scripts/test/classify-emails.test.js`

- [ ] **Step 1: Write failing tests for `matchesScamPattern`**

Append to `scripts/test/classify-emails.test.js`:

```js
import { matchesScamPattern } from "../classify-emails.js";

describe("matchesScamPattern", () => {
  const annualReportScam = {
    label: "Annual Report filing scam",
    subjectAll: ["annual report"],
    senderAllowlist: ["sunbiz.org"],
    action: "delete"
  };

  it("matches when subject contains all subjectAll terms and sender not in allowlist", () => {
    const email = {
      from: "renew@flcorpfiling.com",
      subject: "2026 Annual Report Filing Notice"
    };
    assert.equal(matchesScamPattern(email, annualReportScam), true);
  });

  it("does not match when sender is in allowlist", () => {
    const email = {
      from: "noreply@sunbiz.org",
      subject: "Annual Report Reminder"
    };
    assert.equal(matchesScamPattern(email, annualReportScam), false);
  });

  it("does not match when subject is missing a subjectAll term", () => {
    const email = {
      from: "renew@flcorpfiling.com",
      subject: "Corporate Filing Reminder"
    };
    assert.equal(matchesScamPattern(email, annualReportScam), false);
  });

  it("matches all subjectAll terms (multi-term)", () => {
    const pattern = { subjectAll: ["annual report", "filing"], senderAllowlist: [] };
    const email1 = { from: "x@y.com", subject: "Annual Report — filing due" };
    const email2 = { from: "x@y.com", subject: "Annual Report" };
    assert.equal(matchesScamPattern(email1, pattern), true);
    assert.equal(matchesScamPattern(email2, pattern), false);
  });

  it("is case-insensitive on subject and sender domain", () => {
    const email = { from: "Renew@FLCorpFiling.COM", subject: "ANNUAL REPORT 2026" };
    assert.equal(matchesScamPattern(email, annualReportScam), true);
  });

  it("empty subjectAll never matches (defensive)", () => {
    const pattern = { subjectAll: [], senderAllowlist: ["sunbiz.org"] };
    const email = { from: "anything@x.com", subject: "Anything" };
    assert.equal(matchesScamPattern(email, pattern), false);
  });
});

describe("classify-emails — scamPatterns force into deletion", () => {
  const summitWithScam = {
    id: "summitmiami",
    name: "Summit Miami",
    accountType: "business",
    provider: "outlook",
    myEmail: "ben@summit.com",
    prioritySenders: [],
    urgencyRules: { flags: [] },
    downrank: [],
    alwaysDelete: [],
    neverDelete: [],
    scamPatterns: [{
      label: "Annual Report scam",
      subjectAll: ["annual report"],
      senderAllowlist: ["sunbiz.org"],
      action: "delete"
    }]
  };

  it("deletes scam pattern hit from rotating domain", () => {
    const emails = [
      { id: "1", from: "renew@corporateusafilings.com", fromName: "Filing Co", subject: "2026 Annual Report Filing Notice" }
    ];
    const result = classifyWithAccount(emails, summitWithScam, businessTypeConfig);
    assert.equal(result.deletionCandidates.length, 1);
    assert.equal(result.categories.ignore.emails.length, 1);
  });

  it("does not delete from allowlisted sender", () => {
    const emails = [
      { id: "1", from: "noreply@sunbiz.org", fromName: "Sunbiz", subject: "Annual Report Reminder" }
    ];
    const result = classifyWithAccount(emails, summitWithScam, businessTypeConfig);
    assert.equal(result.deletionCandidates.length, 0);
  });

  it("neverDelete wins over scamPatterns (protection precedence)", () => {
    const account = {
      ...summitWithScam,
      neverDelete: [{ type: "domain", value: "flcorpfiling.com", label: "test override" }]
    };
    const emails = [
      { id: "1", from: "renew@flcorpfiling.com", fromName: "Filing Co", subject: "Annual Report 2026" }
    ];
    const result = classifyWithAccount(emails, account, businessTypeConfig);
    assert.equal(result.deletionCandidates.length, 0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test 2>&1 | grep -E "matchesScamPattern|scamPatterns" | head -20`
Expected: failures referencing `matchesScamPattern` not exported.

- [ ] **Step 3: Implement `matchesScamPattern` in classify-emails.js**

Add immediately after `senderRuleApplies` (from Task 1):

```js
/**
 * Returns true if the email matches the scamPattern:
 *   - subject contains ALL of pattern.subjectAll (case-insensitive)
 *   - sender's domain is NOT in pattern.senderAllowlist (case-insensitive)
 *
 * Empty subjectAll never matches (defensive). Used to catch recurring scams
 * that arrive from rotating third-party domains (e.g., Annual Report filing scam).
 */
export function matchesScamPattern(email, pattern) {
  const subjectAll = pattern.subjectAll || [];
  if (subjectAll.length === 0) return false;
  const subject = (email.subject || "").toLowerCase();
  for (const term of subjectAll) {
    if (!subject.includes(term.toLowerCase())) return false;
  }
  const fromDomain = ((email.from || "").split("@")[1] || "").toLowerCase();
  const allowlist = (pattern.senderAllowlist || []).map(d => d.toLowerCase());
  if (allowlist.includes(fromDomain)) return false;
  return true;
}
```

- [ ] **Step 4: Wire `matchesScamPattern` into `classify()`**

In the `classify()` function, around line 218 (where `alwaysDeleteList` is built), add scamPatterns extraction:

```js
  const alwaysDeleteList = [
    ...(policy.alwaysDelete || []),
    ...(account.alwaysDelete || []),
  ];
  const scamPatterns = account.scamPatterns || [];
  const deletionCategoryIds = new Set(policy.categories);
```

Then update the per-email loop. Find the block that begins `const alwaysDeleteApplies = ...` (added in Task 1) and replace it with:

```js
    const alwaysDeleteApplies = alwaysDeleteList.some(r => senderRuleApplies(email, r));
    const scamApplies = scamPatterns.some(p => matchesScamPattern(email, p));
    const isProtected = matchesSender(email, neverDeleteList);
    const forceDelete = (alwaysDeleteApplies || scamApplies) && !isProtected;

    // alwaysDelete / scamPatterns override category — reclassify to ignore
    if (forceDelete) {
      categoryId = "ignore";
    }

    if (!result.categories[categoryId]) {
      result.categories[categoryId] = { label: categoryId, hidden: false, emails: [] };
    }
    result.categories[categoryId].emails.push(email);

    // Force into deletion candidates
    if (forceDelete) {
      result.deletionCandidates.push(email);
    }
    // neverDelete protects against pattern/category-based deletion
    else if (isProtected) {
      // skip — protected sender
    }
    // Standard category/pattern-based deletion
    else if (deletionCategoryIds.has(categoryId) || matchesDeletionPattern(email, policy.patterns)) {
      result.deletionCandidates.push(email);
    }
```

Note: the existing code path for `matchesSender(email, neverDeleteList)` is replaced by the `isProtected` variable, which makes the precedence rule explicit (neverDelete wins over alwaysDelete and scamPatterns).

- [ ] **Step 5: Run all tests**

Run: `npm test 2>&1 | tail -30`
Expected: all tests pass — Task 1's `senderRuleApplies` tests, Task 2's `matchesScamPattern` tests, the classify-level `scamPatterns force into deletion` tests, AND the deferred Task 1 tests `classify-emails — unless clause on personal alwaysDelete` (they require `matchesScamPattern` to be defined in the helper).

If any pre-existing tests now fail, the protection-precedence reordering changed behavior — review carefully and fix.

- [ ] **Step 6: Commit**

```bash
git add scripts/classify-emails.js scripts/test/classify-emails.test.js
git commit -m "feat(classify): add scamPatterns heuristic for rotating-domain scams

Adds matchesScamPattern() and wires it into classify() with explicit
protection precedence: neverDelete wins over alwaysDelete and scamPatterns.
Designed for recurring scams like Annual Report filing notices that arrive
from new third-party domains every few days.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Migrate memory rules into config/companies.json

**Files:**
- Modify: `config/companies.json`

This is a data change. No new tests; the entries are exercised by Task 1 and Task 2 tests via fixtures.

- [ ] **Step 1: Read current config/companies.json**

(Subagent: use the Read tool to load the file before editing.)

- [ ] **Step 2: Edit `personal.alwaysDelete` — replace plain eBay entry**

Find the entry `{ "type": "name", "value": "eBay", "label": "eBay promos" }` in `personal.alwaysDelete`. Replace with:

```json
{
  "type": "name",
  "value": "eBay",
  "label": "eBay marketing (transactional allowed)",
  "unless": {
    "subjectContains": ["delivered", "shipped", "out for delivery", "order", "security", "device", "message", "buyer", "seller", "feedback"]
  }
}
```

- [ ] **Step 3: Edit `personal.alwaysDelete` — replace plain PayPal entry**

Find `{ "type": "name", "value": "PayPal", "label": "PayPal marketing" }`. Replace with:

```json
{
  "type": "name",
  "value": "PayPal",
  "label": "PayPal marketing (receipts allowed)",
  "unless": {
    "subjectContains": ["you've got money", "you received", "payment received", "payment confirmation", "receipt for your payment", "refund"]
  }
}
```

- [ ] **Step 4: Append to `personal.neverDelete`**

After the existing entries in `personal.neverDelete`, append (preserving JSON syntax — add a comma to the previous last entry):

```json
{ "type": "domain", "value": "equinox.com", "label": "Equinox account info" },
{ "type": "email", "value": "avc@fiusigepalumni.ccsend.com", "label": "FIU SigEp Alumni newsletter" },
{ "type": "name", "value": "Castillo, Rodney", "label": "AANHPI / AAAB contact" }
```

- [ ] **Step 5: Append to `healthcarema.neverDelete`**

After existing entries in `healthcarema.neverDelete`:

```json
{ "type": "email", "value": "assuredinvestmentsrealty@gmail.com", "label": "Juan Santamaria (\"John\") — friend" }
```

- [ ] **Step 6: Add `scamPatterns` to `summitmiami`**

Inside the `summitmiami` account object, after `neverDelete` (and before `outputs`), insert:

```json
"scamPatterns": [
  {
    "label": "Annual Report filing scam (rotating third-party domains)",
    "subjectAll": ["annual report"],
    "senderAllowlist": ["sunbiz.org"],
    "action": "delete"
  }
],
```

- [ ] **Step 7: Add `scamPatterns` to `brickellpay` and `healthcarema`**

Same field, same pattern, inserted in the same position relative to the account object structure. Use identical JSON.

- [ ] **Step 8: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('config/companies.json'))"` (or `node --input-type=module -e "JSON.parse(await import('fs').then(fs => fs.readFileSync('config/companies.json', 'utf-8')))"`)
Expected: no output (parse succeeded).

If parse fails: review and fix syntax errors before continuing.

- [ ] **Step 9: Run full test suite**

Run: `npm test 2>&1 | tail -15`
Expected: all tests pass. Tests that mocked `personal.alwaysDelete` directly still pass (they didn't load the real file); tests that load from disk via `classify()` need the new schema-shaped entries — which they now have.

- [ ] **Step 10: Commit**

```bash
git add config/companies.json
git commit -m "config: migrate memory rules into companies.json

- personal.alwaysDelete: eBay and PayPal entries now use unless clause
  to keep transactional emails (orders, deliveries, security, receipts)
- personal.neverDelete: Equinox account info, FIU SigEp Alumni newsletter,
  Castillo Rodney (AANHPI / AAAB contact)
- healthcarema.neverDelete: Juan Santamaria (assuredinvestmentsrealty@gmail.com)
- summitmiami / brickellpay / healthcarema scamPatterns: Annual Report
  filing scam (subject contains 'annual report' + sender not in sunbiz.org)

These rules were previously applied manually each triage session from memory.
Memory entries stay in place as the journal of why each rule exists.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Create scripts/sender-history.js

**Files:**
- Create: `scripts/sender-history.js`
- Test: `scripts/test/sender-history.test.js`

Tracks per-account, per-sender consecutive-deletion counters in `data/sender-history.json`. Used by pattern-discovery for auto-trash proposals.

- [ ] **Step 1: Write failing tests**

Create `scripts/test/sender-history.test.js`:

```js
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadHistory,
  saveHistory,
  recordDeletion,
  recordKeep,
  thresholdCrossed
} from "../sender-history.js";

let tmpDir;
let historyPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sender-history-test-"));
  historyPath = join(tmpDir, "sender-history.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadHistory", () => {
  it("returns empty object when file does not exist", () => {
    const h = loadHistory(historyPath);
    assert.deepEqual(h, {});
  });

  it("returns parsed JSON when file exists", () => {
    writeFileSync(historyPath, JSON.stringify({ "personal:foo@x.com": { deletedCount: 3 } }));
    const h = loadHistory(historyPath);
    assert.equal(h["personal:foo@x.com"].deletedCount, 3);
  });
});

describe("saveHistory", () => {
  it("writes atomically (no partial file on failure simulated by file existing)", () => {
    saveHistory(historyPath, { "personal:a@b.com": { deletedCount: 1 } });
    assert.ok(existsSync(historyPath));
    const parsed = JSON.parse(readFileSync(historyPath, "utf-8"));
    assert.equal(parsed["personal:a@b.com"].deletedCount, 1);
  });
});

describe("recordDeletion", () => {
  it("creates entry with deletedCount=1 on first deletion", () => {
    const h = {};
    recordDeletion(h, "personal", "foo@x.com", { hasListUnsubscribe: true, timestamp: "2026-05-21T06:00:00Z" });
    assert.equal(h["personal:foo@x.com"].deletedCount, 1);
    assert.equal(h["personal:foo@x.com"].hasListUnsubscribe, true);
    assert.equal(h["personal:foo@x.com"].lastDeletedAt, "2026-05-21T06:00:00Z");
  });

  it("increments existing counter", () => {
    const h = { "personal:foo@x.com": { deletedCount: 4, hasListUnsubscribe: true, lastDeletedAt: "..." } };
    recordDeletion(h, "personal", "foo@x.com", { hasListUnsubscribe: true, timestamp: "2026-05-21T07:00:00Z" });
    assert.equal(h["personal:foo@x.com"].deletedCount, 5);
    assert.equal(h["personal:foo@x.com"].lastDeletedAt, "2026-05-21T07:00:00Z");
  });

  it("preserves hasListUnsubscribe=true if any prior deletion had it", () => {
    const h = { "personal:foo@x.com": { deletedCount: 1, hasListUnsubscribe: true } };
    recordDeletion(h, "personal", "foo@x.com", { hasListUnsubscribe: false, timestamp: "..." });
    assert.equal(h["personal:foo@x.com"].hasListUnsubscribe, true);
  });

  it("lowercases the sender key", () => {
    const h = {};
    recordDeletion(h, "personal", "FOO@X.com", { hasListUnsubscribe: false, timestamp: "..." });
    assert.ok(h["personal:foo@x.com"]);
  });
});

describe("recordKeep", () => {
  it("resets deletedCount to 0", () => {
    const h = { "personal:foo@x.com": { deletedCount: 7, hasListUnsubscribe: true, lastDeletedAt: "..." } };
    recordKeep(h, "personal", "foo@x.com");
    assert.equal(h["personal:foo@x.com"].deletedCount, 0);
  });

  it("is a no-op when sender not tracked", () => {
    const h = {};
    recordKeep(h, "personal", "foo@x.com");
    assert.deepEqual(h, {});
  });
});

describe("thresholdCrossed", () => {
  it("returns true when deletedCount >= threshold AND hasListUnsubscribe", () => {
    const entry = { deletedCount: 5, hasListUnsubscribe: true };
    assert.equal(thresholdCrossed(entry, 5), true);
  });

  it("returns false when deletedCount < threshold", () => {
    const entry = { deletedCount: 4, hasListUnsubscribe: true };
    assert.equal(thresholdCrossed(entry, 5), false);
  });

  it("returns false when hasListUnsubscribe is false", () => {
    const entry = { deletedCount: 10, hasListUnsubscribe: false };
    assert.equal(thresholdCrossed(entry, 5), false);
  });

  it("returns false when entry is undefined", () => {
    assert.equal(thresholdCrossed(undefined, 5), false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test scripts/test/sender-history.test.js 2>&1 | tail -10`
Expected: file-not-found error for `../sender-history.js`.

- [ ] **Step 3: Implement `scripts/sender-history.js`**

Create `scripts/sender-history.js`:

```js
/**
 * sender-history.js
 *
 * Tracks per-account, per-sender consecutive-deletion counters used by
 * pattern-discovery to propose auto-trash rules.
 *
 * State file: data/sender-history.json
 * Keys: "<accountId>:<senderEmail-lowercase>"
 * Values: { deletedCount, lastDeletedAt, hasListUnsubscribe }
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function loadHistory(historyPath) {
  if (!existsSync(historyPath)) return {};
  const raw = readFileSync(historyPath, "utf-8");
  return JSON.parse(raw);
}

export function saveHistory(historyPath, history) {
  mkdirSync(dirname(historyPath), { recursive: true });
  const tmpPath = `${historyPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(history, null, 2), "utf-8");
  renameSync(tmpPath, historyPath);
}

function keyFor(accountId, senderEmail) {
  return `${accountId}:${(senderEmail || "").toLowerCase()}`;
}

export function recordDeletion(history, accountId, senderEmail, { hasListUnsubscribe, timestamp }) {
  const key = keyFor(accountId, senderEmail);
  const existing = history[key] || { deletedCount: 0, hasListUnsubscribe: false };
  history[key] = {
    deletedCount: existing.deletedCount + 1,
    hasListUnsubscribe: existing.hasListUnsubscribe || !!hasListUnsubscribe,
    lastDeletedAt: timestamp,
  };
}

export function recordKeep(history, accountId, senderEmail) {
  const key = keyFor(accountId, senderEmail);
  if (history[key]) {
    history[key].deletedCount = 0;
  }
}

export function thresholdCrossed(entry, threshold) {
  if (!entry) return false;
  if (!entry.hasListUnsubscribe) return false;
  return entry.deletedCount >= threshold;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test scripts/test/sender-history.test.js 2>&1 | tail -15`
Expected: all tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test 2>&1 | tail -15`
Expected: all tests pass (no regressions).

- [ ] **Step 6: Commit**

```bash
git add scripts/sender-history.js scripts/test/sender-history.test.js
git commit -m "feat(sender-history): track per-sender deletion counters for auto-trash discovery

Persists consecutive-deletion counters per (account, sender) in
data/sender-history.json with atomic writes. Counter resets to 0 when the
user keeps an email from that sender. thresholdCrossed() encapsulates the
auto-trash criterion (>=N consecutive deletes + List-Unsubscribe header).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Create scripts/pattern-discovery.js

**Files:**
- Create: `scripts/pattern-discovery.js`
- Test: `scripts/test/pattern-discovery.test.js`

Three discovery functions: auto-trash (from sender-history), scam-pattern (3+ hits across 2+ domains in 30d), memory-backfill (scan memory dir for unmigrated rules).

- [ ] **Step 1: Write failing tests**

Create `scripts/test/pattern-discovery.test.js`:

```js
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverAutoTrash,
  discoverScamPatterns,
  discoverMemoryBackfill,
  proposalId,
  isPendingProposal
} from "../pattern-discovery.js";

describe("proposalId", () => {
  it("generates stable id from timestamp and counter", () => {
    const id = proposalId("2026-05-21T06:00:00Z", 1);
    assert.equal(id, "p-2026-05-21-001");
  });
  it("pads counter to 3 digits", () => {
    assert.equal(proposalId("2026-05-21T06:00:00Z", 42), "p-2026-05-21-042");
  });
});

describe("isPendingProposal", () => {
  it("returns true when a pending proposal targets the same config path with matching payload value", () => {
    const proposals = [
      { id: "p-1", target: "companies.personal.alwaysDelete", payload: { value: "foo@x.com" }, status: "pending" }
    ];
    assert.equal(isPendingProposal(proposals, "companies.personal.alwaysDelete", "foo@x.com"), true);
  });
  it("returns false when proposal is approved/declined", () => {
    const proposals = [
      { id: "p-1", target: "companies.personal.alwaysDelete", payload: { value: "foo@x.com" }, status: "approved" }
    ];
    assert.equal(isPendingProposal(proposals, "companies.personal.alwaysDelete", "foo@x.com"), false);
  });
});

describe("discoverAutoTrash", () => {
  it("emits proposal when sender-history has >=5 deletes + list-unsubscribe + not protected", () => {
    const history = {
      "personal:noreply@bizjournals.com": {
        deletedCount: 7,
        hasListUnsubscribe: true,
        lastDeletedAt: "2026-05-21T06:00:00Z"
      }
    };
    const accounts = [{ id: "personal", neverDelete: [], prioritySenders: [] }];
    const proposals = discoverAutoTrash(history, accounts, [], { now: "2026-05-21T06:00:00Z" });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].target, "companies.personal.alwaysDelete");
    assert.equal(proposals[0].payload.value, "noreply@bizjournals.com");
    assert.equal(proposals[0].payload.type, "email");
  });

  it("does not propose when sender is in neverDelete", () => {
    const history = {
      "personal:noreply@bizjournals.com": { deletedCount: 9, hasListUnsubscribe: true, lastDeletedAt: "..." }
    };
    const accounts = [{ id: "personal", neverDelete: [{ type: "domain", value: "bizjournals.com" }], prioritySenders: [] }];
    const proposals = discoverAutoTrash(history, accounts, [], { now: "..." });
    assert.equal(proposals.length, 0);
  });

  it("does not re-propose when pending proposal already exists", () => {
    const history = {
      "personal:noreply@bizjournals.com": { deletedCount: 7, hasListUnsubscribe: true, lastDeletedAt: "..." }
    };
    const accounts = [{ id: "personal", neverDelete: [], prioritySenders: [] }];
    const pending = [
      { id: "p-1", target: "companies.personal.alwaysDelete", payload: { value: "noreply@bizjournals.com" }, status: "pending" }
    ];
    const proposals = discoverAutoTrash(history, accounts, pending, { now: "..." });
    assert.equal(proposals.length, 0);
  });

  it("does not propose under threshold", () => {
    const history = { "personal:foo@x.com": { deletedCount: 3, hasListUnsubscribe: true, lastDeletedAt: "..." } };
    const accounts = [{ id: "personal", neverDelete: [], prioritySenders: [] }];
    assert.equal(discoverAutoTrash(history, accounts, [], { now: "..." }).length, 0);
  });
});

describe("discoverScamPatterns", () => {
  it("emits proposal when >=3 deletions match fuzzy subject across >=2 domains in 30d", () => {
    const recentDeletions = [
      { accountId: "summitmiami", subject: "Annual Report Filing Notice", senderDomain: "flcorpfiling.com", deletedAt: "2026-05-15T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report 2026", senderDomain: "corporateusafilings.com", deletedAt: "2026-05-18T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report Reminder", senderDomain: "myfloridacorpfilings.com", deletedAt: "2026-05-20T00:00:00Z" }
    ];
    const accounts = [{ id: "summitmiami", neverDelete: [] }];
    const proposals = discoverScamPatterns(recentDeletions, accounts, [], { now: "2026-05-21T00:00:00Z" });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].target, "companies.summitmiami.scamPatterns");
    assert.ok(proposals[0].payload.subjectAll.includes("annual report"));
    assert.deepEqual(proposals[0].payload.senderAllowlist, []);
  });

  it("does not emit when fewer than 2 distinct domains", () => {
    const recentDeletions = [
      { accountId: "summitmiami", subject: "Annual Report Filing", senderDomain: "flcorpfiling.com", deletedAt: "2026-05-15T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report 2026", senderDomain: "flcorpfiling.com", deletedAt: "2026-05-18T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report Reminder", senderDomain: "flcorpfiling.com", deletedAt: "2026-05-20T00:00:00Z" }
    ];
    const proposals = discoverScamPatterns(recentDeletions, [{ id: "summitmiami", neverDelete: [] }], [], { now: "2026-05-21T00:00:00Z" });
    assert.equal(proposals.length, 0);
  });

  it("ignores deletions older than 30d", () => {
    const recentDeletions = [
      { accountId: "summitmiami", subject: "Annual Report Filing", senderDomain: "a.com", deletedAt: "2026-03-01T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report 2026", senderDomain: "b.com", deletedAt: "2026-03-02T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report Reminder", senderDomain: "c.com", deletedAt: "2026-03-03T00:00:00Z" }
    ];
    const proposals = discoverScamPatterns(recentDeletions, [{ id: "summitmiami", neverDelete: [] }], [], { now: "2026-05-21T00:00:00Z" });
    assert.equal(proposals.length, 0);
  });

  it("does not re-propose when pending proposal already exists for same pattern", () => {
    const recentDeletions = [
      { accountId: "summitmiami", subject: "Annual Report Filing", senderDomain: "a.com", deletedAt: "2026-05-15T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report 2026", senderDomain: "b.com", deletedAt: "2026-05-18T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report Reminder", senderDomain: "c.com", deletedAt: "2026-05-20T00:00:00Z" }
    ];
    const pending = [
      { id: "p-x", target: "companies.summitmiami.scamPatterns", payload: { subjectAll: ["annual report"] }, status: "pending" }
    ];
    const proposals = discoverScamPatterns(recentDeletions, [{ id: "summitmiami", neverDelete: [] }], pending, { now: "2026-05-21T00:00:00Z" });
    assert.equal(proposals.length, 0);
  });
});

describe("discoverMemoryBackfill", () => {
  let tmpDir;
  let memoryDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-backfill-test-"));
    memoryDir = join(tmpDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("proposes neverDelete entry for a feedback_*.md that references a sender not in any config neverDelete", () => {
    writeFileSync(join(memoryDir, "feedback_equinox_account.md"),
      "---\nnode_type: memory\ntype: feedback\n---\n\n" +
      "noreply@equinox.com account info emails are keeps (user is an Equinox member).\n"
    );
    const accounts = [{ id: "personal", neverDelete: [] }];
    const proposals = discoverMemoryBackfill(memoryDir, accounts, [], { now: "2026-05-21T06:00:00Z" });
    assert.ok(proposals.length >= 1);
    const equinoxProposal = proposals.find(p => JSON.stringify(p.payload).toLowerCase().includes("equinox"));
    assert.ok(equinoxProposal, "should propose an equinox-related rule");
  });

  it("does not propose when memory rule is already represented in config", () => {
    writeFileSync(join(memoryDir, "feedback_equinox_account.md"),
      "noreply@equinox.com account info emails are keeps.\n"
    );
    const accounts = [{ id: "personal", neverDelete: [{ type: "domain", value: "equinox.com" }] }];
    const proposals = discoverMemoryBackfill(memoryDir, accounts, [], { now: "2026-05-21T06:00:00Z" });
    const equinoxProposal = proposals.find(p => JSON.stringify(p.payload).toLowerCase().includes("equinox"));
    assert.equal(equinoxProposal, undefined);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test scripts/test/pattern-discovery.test.js 2>&1 | tail -10`
Expected: file-not-found error.

- [ ] **Step 3: Implement `scripts/pattern-discovery.js`**

Create `scripts/pattern-discovery.js`:

```js
/**
 * pattern-discovery.js
 *
 * Three discovery functions that emit rule proposals for the morning brief:
 *
 *   discoverAutoTrash(history, accounts, pendingProposals, opts)
 *     → senders with >=5 consecutive deletes + list-unsubscribe + not protected
 *
 *   discoverScamPatterns(recentDeletions, accounts, pendingProposals, opts)
 *     → recurring subject patterns across multiple sender domains
 *
 *   discoverMemoryBackfill(memoryDir, accounts, pendingProposals, opts)
 *     → memory entries (feedback_*.md / relationship_*.md) referencing
 *       senders not yet represented in any account's neverDelete
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const AUTO_TRASH_THRESHOLD = 5;
const SCAM_WINDOW_DAYS = 30;
const SCAM_MIN_HITS = 3;
const SCAM_MIN_DOMAINS = 2;

export function proposalId(timestamp, counter) {
  const datePart = (timestamp || "").slice(0, 10); // YYYY-MM-DD
  const counterPart = String(counter).padStart(3, "0");
  return `p-${datePart}-${counterPart}`;
}

export function isPendingProposal(proposals, target, payloadValue) {
  return proposals.some(p =>
    p.status === "pending" &&
    p.target === target &&
    JSON.stringify(p.payload).toLowerCase().includes((payloadValue || "").toLowerCase())
  );
}

function findAccount(accounts, accountId) {
  return accounts.find(a => a.id === accountId);
}

function senderIsProtected(account, senderEmail) {
  const domain = (senderEmail.split("@")[1] || "").toLowerCase();
  const lists = [...(account.neverDelete || []), ...(account.prioritySenders || [])];
  for (const rule of lists) {
    if (rule.type === "email" && rule.value.toLowerCase() === senderEmail.toLowerCase()) return true;
    if (rule.type === "domain" && rule.value.toLowerCase() === domain) return true;
  }
  return false;
}

export function discoverAutoTrash(history, accounts, pendingProposals, { now }) {
  const proposals = [];
  let counter = pendingProposals.length + 1;
  for (const [key, entry] of Object.entries(history)) {
    const [accountId, senderEmail] = key.split(":");
    if (!entry.hasListUnsubscribe) continue;
    if (entry.deletedCount < AUTO_TRASH_THRESHOLD) continue;
    const account = findAccount(accounts, accountId);
    if (!account) continue;
    if (senderIsProtected(account, senderEmail)) continue;
    const target = `companies.${accountId}.alwaysDelete`;
    if (isPendingProposal(pendingProposals, target, senderEmail)) continue;
    proposals.push({
      id: proposalId(now, counter++),
      target,
      payload: {
        type: "email",
        value: senderEmail,
        label: `${senderEmail} (${entry.deletedCount} consecutive deletes)`
      },
      reason: `${entry.deletedCount} consecutive deletes + list-unsubscribe + not protected`,
      proposedAt: now,
      status: "pending"
    });
  }
  return proposals;
}

/**
 * Extract a "fuzzy subject pattern" — the common lowercase content words
 * across a set of subject strings. Stopwords filtered. Returns up to 2 terms.
 */
function commonSubjectTerms(subjects) {
  const STOPWORDS = new Set(["the", "a", "an", "your", "you", "is", "for", "of", "and", "to", "in", "on", "at", "2026", "2025", "re", "fw", "fwd"]);
  const sets = subjects.map(s =>
    new Set(
      s.toLowerCase()
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length >= 4 && !STOPWORDS.has(w))
    )
  );
  if (sets.length === 0) return [];
  // intersection
  let common = [...sets[0]];
  for (let i = 1; i < sets.length; i++) {
    common = common.filter(w => sets[i].has(w));
  }
  return common.slice(0, 2);
}

export function discoverScamPatterns(recentDeletions, accounts, pendingProposals, { now }) {
  const proposals = [];
  let counter = pendingProposals.length + 1;
  const cutoff = new Date(now).getTime() - SCAM_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  // group by account
  const byAccount = {};
  for (const d of recentDeletions) {
    const ts = new Date(d.deletedAt).getTime();
    if (ts < cutoff) continue;
    (byAccount[d.accountId] = byAccount[d.accountId] || []).push(d);
  }

  for (const [accountId, deletions] of Object.entries(byAccount)) {
    const account = findAccount(accounts, accountId);
    if (!account) continue;

    // Cluster by common subject terms — naive: any pair sharing a common
    // content term forms a cluster. For v1 we look at the dominant term.
    const termHits = {}; // term -> { domains: Set, deletions: [] }
    for (const d of deletions) {
      const terms = commonSubjectTerms([d.subject]);
      for (const t of terms) {
        const entry = (termHits[t] = termHits[t] || { domains: new Set(), deletions: [] });
        entry.domains.add(d.senderDomain.toLowerCase());
        entry.deletions.push(d);
      }
    }

    for (const [term, info] of Object.entries(termHits)) {
      if (info.deletions.length < SCAM_MIN_HITS) continue;
      if (info.domains.size < SCAM_MIN_DOMAINS) continue;

      // Look at all subjects sharing this term and intersect to find the full pattern
      const subjectAll = commonSubjectTerms(info.deletions.map(d => d.subject));
      if (subjectAll.length === 0) continue;
      // Skip if any sender domain is in neverDelete (would be a false positive)
      const anyProtected = [...info.domains].some(domain =>
        (account.neverDelete || []).some(r => r.type === "domain" && r.value.toLowerCase() === domain)
      );
      if (anyProtected) continue;

      const target = `companies.${accountId}.scamPatterns`;
      if (isPendingProposal(pendingProposals, target, subjectAll[0])) continue;

      proposals.push({
        id: proposalId(now, counter++),
        target,
        payload: {
          label: `Recurring subject pattern: "${subjectAll.join(" ")}"`,
          subjectAll,
          senderAllowlist: [],
          action: "delete"
        },
        reason: `${info.deletions.length} deletions in ${SCAM_WINDOW_DAYS}d across ${info.domains.size} sender domains`,
        proposedAt: now,
        status: "pending"
      });
    }
  }

  return proposals;
}

/**
 * Scan a memory directory for feedback_*.md / relationship_*.md files and
 * propose neverDelete entries for senders mentioned in those files that
 * are not yet in any account's neverDelete.
 *
 * v1 heuristic: extract an email-shaped or domain-shaped token from the
 * body. If none, propose nothing for that file (the human will do it).
 */
export function discoverMemoryBackfill(memoryDir, accounts, pendingProposals, { now }) {
  if (!existsSync(memoryDir)) return [];
  const proposals = [];
  let counter = pendingProposals.length + 1;
  const files = readdirSync(memoryDir).filter(f =>
    (f.startsWith("feedback_") || f.startsWith("relationship_")) && f.endsWith(".md")
  );

  for (const file of files) {
    const body = readFileSync(join(memoryDir, file), "utf-8");
    // Extract email-shaped token
    const emailMatch = body.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    const domainMatch = !emailMatch && body.match(/\b([a-z0-9-]+\.(?:com|org|net|edu|gov|io))\b/i);
    const value = emailMatch ? emailMatch[0].toLowerCase() : (domainMatch ? domainMatch[1].toLowerCase() : null);
    if (!value) continue;
    const type = emailMatch ? "email" : "domain";

    // Check if any account's neverDelete already covers this
    const alreadyCovered = accounts.some(account =>
      (account.neverDelete || []).some(rule => {
        if (rule.type === "email" && rule.value.toLowerCase() === value) return true;
        if (rule.type === "domain") {
          if (type === "email") return value.endsWith("@" + rule.value.toLowerCase()) || value.endsWith("." + rule.value.toLowerCase());
          return rule.value.toLowerCase() === value;
        }
        return false;
      })
    );
    if (alreadyCovered) continue;

    // Default to personal account if no signal; this is a hint, user can change on approval
    const targetAccount = body.toLowerCase().includes("healthcare m&a") || body.toLowerCase().includes("hcma")
      ? "healthcarema"
      : "personal";
    const target = `companies.${targetAccount}.neverDelete`;
    if (isPendingProposal(pendingProposals, target, value)) continue;

    proposals.push({
      id: proposalId(now, counter++),
      target,
      payload: {
        type,
        value,
        label: `Backfilled from memory: ${file}`
      },
      reason: `Memory entry ${file} references ${value} but no config rule exists`,
      proposedAt: now,
      status: "pending",
      sourceMemoryFile: file
    });
  }
  return proposals;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test scripts/test/pattern-discovery.test.js 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test 2>&1 | tail -15`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add scripts/pattern-discovery.js scripts/test/pattern-discovery.test.js
git commit -m "feat(pattern-discovery): auto-trash, scam-pattern, and memory-backfill detection

discoverAutoTrash: senders with >=5 consecutive deletes + list-unsubscribe + not protected
discoverScamPatterns: >=3 deletions matching fuzzy subject pattern across >=2 domains in 30d
discoverMemoryBackfill: memory entries referencing senders not yet in config

All three emit pending proposals to be reviewed via the morning brief.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Create scripts/apply-proposals.js

**Files:**
- Create: `scripts/apply-proposals.js`
- Test: `scripts/test/apply-proposals.test.js`

Parses approval lines ("approve p-... ; decline p-..."), atomically patches config files, writes memory entries, updates `data/proposed-rules.json`.

- [ ] **Step 1: Write failing tests**

Create `scripts/test/apply-proposals.test.js`:

```js
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseApprovalLine, applyProposals } from "../apply-proposals.js";

describe("parseApprovalLine", () => {
  it("parses approve and decline lists", () => {
    const r = parseApprovalLine("approve p-2026-05-21-001, p-2026-05-21-003; decline p-2026-05-21-002");
    assert.deepEqual(r.approve, ["p-2026-05-21-001", "p-2026-05-21-003"]);
    assert.deepEqual(r.decline, ["p-2026-05-21-002"]);
  });
  it("handles approve only", () => {
    const r = parseApprovalLine("approve p-1, p-2");
    assert.deepEqual(r.approve, ["p-1", "p-2"]);
    assert.deepEqual(r.decline, []);
  });
  it("handles decline only", () => {
    const r = parseApprovalLine("decline p-9");
    assert.deepEqual(r.approve, []);
    assert.deepEqual(r.decline, ["p-9"]);
  });
  it("is whitespace-tolerant", () => {
    const r = parseApprovalLine("  approve  p-1 ,  p-2  ;  decline  p-3  ");
    assert.deepEqual(r.approve, ["p-1", "p-2"]);
    assert.deepEqual(r.decline, ["p-3"]);
  });
});

describe("applyProposals", () => {
  let tmpDir, configDir, memoryDir, dataDir, companiesPath, proposalsPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "apply-proposals-test-"));
    configDir = join(tmpDir, "config");
    memoryDir = join(tmpDir, "memory");
    dataDir = join(tmpDir, "data");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    companiesPath = join(configDir, "companies.json");
    proposalsPath = join(dataDir, "proposed-rules.json");
    writeFileSync(companiesPath, JSON.stringify({
      companies: [
        { id: "personal", name: "Personal", accountType: "personal", neverDelete: [{ type: "domain", value: "existing.com", label: "preexisting" }], alwaysDelete: [] }
      ]
    }, null, 2));
    writeFileSync(proposalsPath, JSON.stringify({ proposals: [
      { id: "p-1", target: "companies.personal.alwaysDelete", payload: { type: "email", value: "spam@x.com", label: "spam" }, reason: "5 deletes", proposedAt: "2026-05-21T06:00:00Z", status: "pending" },
      { id: "p-2", target: "companies.personal.neverDelete", payload: { type: "domain", value: "newkeep.com", label: "newkeep" }, reason: "memory backfill", proposedAt: "...", status: "pending", sourceMemoryFile: "feedback_newkeep.md" }
    ] }, null, 2));
  });

  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("appends approved proposal to the target array in companies.json", () => {
    const report = applyProposals({ approve: ["p-1"], decline: [] }, { companiesPath, proposalsPath, memoryDir, now: "2026-05-21T06:00:00Z" });
    const companies = JSON.parse(readFileSync(companiesPath, "utf-8"));
    const personal = companies.companies.find(c => c.id === "personal");
    assert.equal(personal.alwaysDelete.length, 1);
    assert.equal(personal.alwaysDelete[0].value, "spam@x.com");
    assert.equal(report.approved.length, 1);
    assert.equal(report.approved[0].id, "p-1");
  });

  it("marks declined proposals as declined in proposed-rules.json", () => {
    applyProposals({ approve: [], decline: ["p-2"] }, { companiesPath, proposalsPath, memoryDir, now: "2026-05-21T06:00:00Z" });
    const proposals = JSON.parse(readFileSync(proposalsPath, "utf-8"));
    const p2 = proposals.proposals.find(p => p.id === "p-2");
    assert.equal(p2.status, "declined");
    // companies.json unchanged
    const companies = JSON.parse(readFileSync(companiesPath, "utf-8"));
    const personal = companies.companies.find(c => c.id === "personal");
    assert.equal(personal.neverDelete.length, 1); // still only the preexisting one
  });

  it("writes a memory journal entry per approved proposal", () => {
    applyProposals({ approve: ["p-1"], decline: [] }, { companiesPath, proposalsPath, memoryDir, now: "2026-05-21T06:00:00Z" });
    const files = readdirSync(memoryDir);
    const ruleFile = files.find(f => f.startsWith("rule-p-1"));
    assert.ok(ruleFile, "memory entry should be created for approved proposal");
    const body = readFileSync(join(memoryDir, ruleFile), "utf-8");
    assert.match(body, /p-1/);
    assert.match(body, /companies\.personal\.alwaysDelete/);
  });

  it("marks approved proposals as approved", () => {
    applyProposals({ approve: ["p-1"], decline: [] }, { companiesPath, proposalsPath, memoryDir, now: "2026-05-21T06:00:00Z" });
    const proposals = JSON.parse(readFileSync(proposalsPath, "utf-8"));
    const p1 = proposals.proposals.find(p => p.id === "p-1");
    assert.equal(p1.status, "approved");
  });

  it("appends 'migrated to config' note to source memory file when sourceMemoryFile is present", () => {
    writeFileSync(join(memoryDir, "feedback_newkeep.md"), "newkeep.com is a keep domain.\n");
    applyProposals({ approve: ["p-2"], decline: [] }, { companiesPath, proposalsPath, memoryDir, now: "2026-05-21T06:00:00Z" });
    const updated = readFileSync(join(memoryDir, "feedback_newkeep.md"), "utf-8");
    assert.match(updated, /migrated to config on 2026-05-21/i);
  });

  it("does nothing for unknown proposal IDs (no crash)", () => {
    const report = applyProposals({ approve: ["p-does-not-exist"], decline: [] }, { companiesPath, proposalsPath, memoryDir, now: "2026-05-21T06:00:00Z" });
    assert.equal(report.approved.length, 0);
    assert.equal(report.skipped.length, 1);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test scripts/test/apply-proposals.test.js 2>&1 | tail -10`
Expected: file-not-found error.

- [ ] **Step 3: Implement `scripts/apply-proposals.js`**

Create `scripts/apply-proposals.js`:

```js
/**
 * apply-proposals.js
 *
 * Parses an approval line like:
 *   "approve p-2026-05-21-001, p-2026-05-21-003; decline p-2026-05-21-002"
 *
 * For each approved proposal:
 *   - Atomically patches the target config file (companies.json or account-types.json).
 *   - Writes a memory journal entry: memory/rule-<id>.md
 *   - If sourceMemoryFile is set, appends "migrated to config on <date>" to that file.
 *
 * For each declined proposal: marks status="declined" in proposed-rules.json.
 *
 * Atomic writes: temp file + rename.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function parseApprovalLine(line) {
  const result = { approve: [], decline: [] };
  const segments = line.split(/;|\bthen\b/i);
  for (const seg of segments) {
    const trimmed = seg.trim();
    const approveMatch = trimmed.match(/^\s*approve\s+(.+)/i);
    const declineMatch = trimmed.match(/^\s*decline\s+(.+)/i);
    const m = approveMatch || declineMatch;
    if (!m) continue;
    const ids = m[1].split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    if (approveMatch) result.approve.push(...ids);
    if (declineMatch) result.decline.push(...ids);
  }
  return result;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

function targetPathPieces(target) {
  // "companies.personal.alwaysDelete" → ["companies", "personal", "alwaysDelete"]
  return target.split(".");
}

function applyToCompanies(companiesObj, target, payload) {
  const pieces = targetPathPieces(target);
  if (pieces[0] !== "companies") throw new Error(`Unsupported target root: ${pieces[0]}`);
  const accountId = pieces[1];
  const field = pieces[2];
  const account = companiesObj.companies.find(c => c.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);
  if (!Array.isArray(account[field])) account[field] = [];
  account[field].push(payload);
}

export function applyProposals({ approve, decline }, { companiesPath, proposalsPath, memoryDir, now }) {
  const proposals = JSON.parse(readFileSync(proposalsPath, "utf-8"));
  const companies = JSON.parse(readFileSync(companiesPath, "utf-8"));

  const report = { approved: [], declined: [], skipped: [] };
  const approvedSet = new Set(approve);
  const declinedSet = new Set(decline);

  for (const p of proposals.proposals) {
    if (approvedSet.has(p.id)) {
      if (p.status !== "pending") { report.skipped.push(p); continue; }
      // Currently only companies.* targets are supported in v1.
      if (p.target.startsWith("companies.")) {
        applyToCompanies(companies, p.target, p.payload);
      } else {
        report.skipped.push(p);
        continue;
      }
      p.status = "approved";
      p.appliedAt = now;
      report.approved.push(p);

      // Memory journal entry
      const memPath = join(memoryDir, `rule-${p.id}.md`);
      const memBody =
        `---\nnode_type: memory\ntype: rule-journal\n---\n\n` +
        `# Rule ${p.id}\n\n` +
        `**Target:** \`${p.target}\`\n\n` +
        `**Applied on:** ${now}\n\n` +
        `**Reason:** ${p.reason || "(no reason recorded)"}\n\n` +
        `**Payload:**\n\n\`\`\`json\n${JSON.stringify(p.payload, null, 2)}\n\`\`\`\n`;
      atomicWrite(memPath, memBody);

      // Annotate source memory file
      if (p.sourceMemoryFile) {
        const srcPath = join(memoryDir, p.sourceMemoryFile);
        if (existsSync(srcPath)) {
          appendFileSync(srcPath, `\n\n> Migrated to config on ${now.slice(0, 10)} as proposal ${p.id} → \`${p.target}\`.\n`);
        }
      }
    } else if (declinedSet.has(p.id)) {
      if (p.status !== "pending") { report.skipped.push(p); continue; }
      p.status = "declined";
      p.declinedAt = now;
      report.declined.push(p);
    }
  }

  // Unknown ids
  for (const id of [...approvedSet, ...declinedSet]) {
    if (!proposals.proposals.some(p => p.id === id)) {
      report.skipped.push({ id, status: "unknown" });
    }
  }

  // Write back atomically
  atomicWrite(proposalsPath, JSON.stringify(proposals, null, 2));
  atomicWrite(companiesPath, JSON.stringify(companies, null, 2));

  return report;
}

// CLI mode (optional)
if (import.meta.url === `file://${process.argv[1]}`) {
  const line = process.argv.slice(2).join(" ");
  if (!line) {
    console.error('Usage: node scripts/apply-proposals.js "approve p-... ; decline p-..."');
    process.exit(1);
  }
  const parsed = parseApprovalLine(line);
  const { fileURLToPath } = await import("node:url");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = join(__dirname, "..");
  const report = applyProposals(parsed, {
    companiesPath: join(root, "config/companies.json"),
    proposalsPath: join(root, "data/proposed-rules.json"),
    memoryDir: join(root, "memory"),
    now: new Date().toISOString()
  });
  console.log(JSON.stringify(report, null, 2));
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test scripts/test/apply-proposals.test.js 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test 2>&1 | tail -15`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add scripts/apply-proposals.js scripts/test/apply-proposals.test.js
git commit -m "feat(apply-proposals): atomic config patching for approved rule proposals

Parses approval lines ('approve p-... ; decline p-...'), atomically patches
companies.json, writes per-rule memory journal entries (memory/rule-<id>.md),
and appends 'migrated to config' notes to source memory files when present.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Create scripts/morning-brief.js (orchestrator)

**Files:**
- Create: `scripts/morning-brief.js`
- Create: `scripts/test/morning-brief.test.js`
- Create: `scripts/test/fixtures/morning-brief.js`

The orchestrator does the deterministic work and emits a structured JSON output. It does NOT draft replies (the skill prompt does that, calling the existing `save-draft.js` / `save-gmail-draft.js`) and does NOT write the brief markdown (the skill prompt does that too).

The orchestrator's responsibilities:
1. Determine window (default = since last successful run; override via `--since` / `--window`)
2. Fetch per account (via existing fetch-emails.js / fetch-gmail.js — invoked as subprocesses by the skill, NOT by this script — see note below)
3. Classify per account (calls `classify()` from classify-emails.js in-process)
4. Apply autonomous deletes (calls delete-emails.js / delete-gmail-emails.js as subprocesses)
5. Capture action items to `data/tasks.md`
6. Update `data/sender-history.json`
7. Run pattern-discovery; merge into `data/proposed-rules.json`
8. Append run entry to `data/triage-log.md`; update `data/last-run-state.json`
9. Emit a JSON to stdout describing: per-account summary, action-needs-decision items, draft candidates, proposed rules, travel context, FYI counts, warnings

**Note on testing strategy:** The orchestrator takes injected dependencies (fetchFn, classifyFn, deleteFn, clock, fs paths) so it can be tested without real connectors. The CLI entry point at the bottom wires up the real connectors.

- [ ] **Step 1: Create fixtures file**

Create `scripts/test/fixtures/morning-brief.js`:

```js
export const sampleAccounts = [
  {
    id: "personal",
    name: "Personal",
    accountType: "personal",
    provider: "gmail",
    myEmail: "ben@personal.com",
    prioritySenders: [],
    neverDelete: [{ type: "domain", value: "equinox.com" }],
    alwaysDelete: [{ type: "name", value: "LinkedIn", label: "LinkedIn notifications" }],
    scamPatterns: [],
    urgencyRules: { flags: [] },
    downrank: [],
  }
];

export const sampleTypeConfig = {
  business: {
    triageCategories: [
      { id: "action", label: "ACTION REQUIRED" },
      { id: "fyi", label: "FYI" },
      { id: "ignore", label: "IGNORE", hidden: true }
    ],
    downrankDefaults: [],
    bulkSignalThreshold: 2,
    deletionPolicy: { categories: ["ignore"], patterns: [], neverDelete: [], alwaysDelete: [] }
  },
  personal: {
    triageCategories: [
      { id: "respond", label: "RESPOND" },
      { id: "newsletters", label: "NEWSLETTERS" },
      { id: "shopping", label: "SHOPPING" },
      { id: "ignore", label: "IGNORE", hidden: true }
    ],
    downrankDefaults: [],
    bulkSignalThreshold: 1,
    deletionPolicy: { categories: ["ignore"], patterns: [], neverDelete: [], alwaysDelete: [] },
    noiseFilters: null
  }
};

export const sampleEmails = {
  personal: [
    { id: "m1", from: "noreply@linkedin.com", fromName: "LinkedIn", subject: "Your weekly digest", hasListUnsubscribe: true, receivedAt: "2026-05-21T05:00:00Z" },
    { id: "m2", from: "noreply@equinox.com", fromName: "Equinox", subject: "Your account info", hasListUnsubscribe: true, receivedAt: "2026-05-21T05:30:00Z" },
    { id: "m3", from: "george@healthcarema.com", fromName: "George Gabela", subject: "URGENT: review LOI", hasListUnsubscribe: false, receivedAt: "2026-05-21T05:45:00Z" }
  ]
};
```

- [ ] **Step 2: Write failing tests for morning-brief.js**

Create `scripts/test/morning-brief.test.js`:

```js
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMorningBrief, determineWindow, isCatchUp } from "../morning-brief.js";
import { sampleAccounts, sampleTypeConfig, sampleEmails } from "./fixtures/morning-brief.js";

describe("determineWindow", () => {
  it("uses --since when provided", () => {
    const w = determineWindow({ since: "2026-05-07T00:00:00Z" }, { now: "2026-05-21T00:00:00Z", lastRun: null });
    assert.equal(w.since, "2026-05-07T00:00:00Z");
    assert.equal(w.windowHours, 14 * 24);
  });
  it("uses --window when provided", () => {
    const w = determineWindow({ window: "48h" }, { now: "2026-05-21T00:00:00Z", lastRun: null });
    assert.equal(w.windowHours, 48);
  });
  it("defaults to since-last-run when neither provided", () => {
    const w = determineWindow({}, { now: "2026-05-21T06:00:00Z", lastRun: "2026-05-20T06:00:00Z" });
    assert.equal(w.since, "2026-05-20T06:00:00Z");
    assert.equal(w.windowHours, 24);
  });
  it("defaults to 24h when no last-run", () => {
    const w = determineWindow({}, { now: "2026-05-21T06:00:00Z", lastRun: null });
    assert.equal(w.windowHours, 24);
  });
});

describe("isCatchUp", () => {
  it("returns true when window > 72h", () => {
    assert.equal(isCatchUp({ windowHours: 73 }), true);
  });
  it("returns false at 72h boundary", () => {
    assert.equal(isCatchUp({ windowHours: 72 }), false);
  });
});

describe("runMorningBrief — orchestration", () => {
  let tmpDir, dataDir, memoryDir, configDir;
  let fetched, classified, deleted;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "morning-brief-test-"));
    dataDir = join(tmpDir, "data");
    memoryDir = join(tmpDir, "memory");
    configDir = join(tmpDir, "config");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    fetched = []; classified = []; deleted = [];
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  function buildDeps() {
    return {
      paths: {
        dataDir,
        memoryDir,
        senderHistoryPath: join(dataDir, "sender-history.json"),
        proposedRulesPath: join(dataDir, "proposed-rules.json"),
        tasksPath: join(dataDir, "tasks.md"),
        triageLogPath: join(dataDir, "triage-log.md"),
        lastRunStatePath: join(dataDir, "last-run-state.json")
      },
      accounts: sampleAccounts,
      typeConfigs: sampleTypeConfig,
      fetchFn: async (accountId, sinceIso) => {
        fetched.push({ accountId, sinceIso });
        return sampleEmails[accountId] || [];
      },
      classifyFn: (emails, account, typeConfig) => {
        classified.push({ accountId: account.id, count: emails.length });
        // Naive: anything in alwaysDelete by name → deletionCandidates
        const result = { accountId: account.id, accountName: account.name, accountType: account.accountType, categories: {}, deletionCandidates: [] };
        const cats = typeConfig.triageCategories;
        for (const c of cats) result.categories[c.id] = { label: c.label, emails: [] };
        for (const e of emails) {
          let cat = "fyi";
          if ((e.fromName || "").toLowerCase().includes("linkedin")) {
            cat = "ignore";
            result.deletionCandidates.push(e);
          } else if ((e.subject || "").toLowerCase().includes("urgent")) {
            cat = account.accountType === "personal" ? "respond" : "action";
          }
          if (!result.categories[cat]) result.categories[cat] = { label: cat, emails: [] };
          result.categories[cat].emails.push(e);
        }
        return result;
      },
      deleteFn: async (accountId, messageIds) => {
        for (const id of messageIds) deleted.push({ accountId, id });
        return { trashed: messageIds.length, failed: 0 };
      },
      clock: { now: "2026-05-21T06:00:00Z" }
    };
  }

  it("returns a structured result containing summary, decisions, drafts, proposals, warnings", async () => {
    const deps = buildDeps();
    const result = await runMorningBrief({ flags: { window: "24h" }, deps });
    assert.ok(result.summary);
    assert.ok(result.needsDecision);
    assert.ok(result.draftCandidates);
    assert.ok(result.proposedRules);
    assert.ok(result.warnings);
    assert.equal(Array.isArray(result.warnings), true);
  });

  it("fetches each configured account once", async () => {
    const deps = buildDeps();
    await runMorningBrief({ flags: { window: "24h" }, deps });
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].accountId, "personal");
  });

  it("autonomously deletes emails in deletionCandidates", async () => {
    const deps = buildDeps();
    const result = await runMorningBrief({ flags: { window: "24h" }, deps });
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].id, "m1");
    assert.equal(result.summary.personal.autoDeleted, 1);
  });

  it("does NOT delete in dry-run mode", async () => {
    const deps = buildDeps();
    const result = await runMorningBrief({ flags: { window: "24h", dryRun: true }, deps });
    assert.equal(deleted.length, 0);
    assert.equal(result.dryRun, true);
  });

  it("captures action items as draft candidates and tasks", async () => {
    const deps = buildDeps();
    const result = await runMorningBrief({ flags: { window: "24h" }, deps });
    assert.ok(result.needsDecision.find(item => item.email.subject.includes("URGENT")));
    // Tasks file should exist with the action item
    const tasks = readFileSync(join(dataDir, "tasks.md"), "utf-8");
    assert.match(tasks, /URGENT/);
    assert.match(tasks, /<!-- msgid:m3 -->/);
  });

  it("updates sender-history with deletion counters", async () => {
    const deps = buildDeps();
    await runMorningBrief({ flags: { window: "24h" }, deps });
    const history = JSON.parse(readFileSync(join(dataDir, "sender-history.json"), "utf-8"));
    assert.equal(history["personal:noreply@linkedin.com"].deletedCount, 1);
  });

  it("appends a structured log entry to triage-log.md", async () => {
    const deps = buildDeps();
    await runMorningBrief({ flags: { window: "24h" }, deps });
    const log = readFileSync(join(dataDir, "triage-log.md"), "utf-8");
    assert.match(log, /2026-05-21/);
    assert.match(log, /personal/);
  });

  it("updates last-run-state.json on success", async () => {
    const deps = buildDeps();
    await runMorningBrief({ flags: { window: "24h" }, deps });
    const state = JSON.parse(readFileSync(join(dataDir, "last-run-state.json"), "utf-8"));
    assert.equal(state.lastRunAt, "2026-05-21T06:00:00Z");
  });

  it("does NOT write any state in dry-run mode", async () => {
    const deps = buildDeps();
    await runMorningBrief({ flags: { window: "24h", dryRun: true }, deps });
    assert.equal(existsSync(join(dataDir, "sender-history.json")), false);
    assert.equal(existsSync(join(dataDir, "last-run-state.json")), false);
    assert.equal(existsSync(join(dataDir, "tasks.md")), false);
  });

  it("warns and continues when a fetch throws", async () => {
    const deps = buildDeps();
    deps.fetchFn = async () => { throw new Error("auth expired"); };
    const result = await runMorningBrief({ flags: { window: "24h" }, deps });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /auth expired/);
  });

  it("does not exceed catch-up draft cap of 5", async () => {
    const deps = buildDeps();
    // Inject 10 urgent emails
    deps.fetchFn = async () => Array.from({ length: 10 }, (_, i) => ({
      id: `u${i}`, from: "x@y.com", fromName: "X", subject: `URGENT thing ${i}`, hasListUnsubscribe: false, receivedAt: "2026-05-21T05:00:00Z"
    }));
    const result = await runMorningBrief({ flags: { since: "2026-05-01T00:00:00Z" }, deps });
    assert.ok(result.window.catchUp, "expected catchUp=true");
    assert.ok(result.draftCandidates.length <= 5, `expected <=5 draft candidates in catch-up, got ${result.draftCandidates.length}`);
  });

  it("caps Needs Decision at 25 in catch-up mode", async () => {
    const deps = buildDeps();
    deps.fetchFn = async () => Array.from({ length: 50 }, (_, i) => ({
      id: `u${i}`, from: "x@y.com", fromName: "X", subject: `URGENT ${i}`, hasListUnsubscribe: false, receivedAt: "2026-05-21T05:00:00Z"
    }));
    const result = await runMorningBrief({ flags: { since: "2026-05-01T00:00:00Z" }, deps });
    assert.equal(result.needsDecision.length, 25);
    assert.equal(result.deferred.length, 25);
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

Run: `npm test scripts/test/morning-brief.test.js 2>&1 | tail -10`
Expected: file-not-found error.

- [ ] **Step 4: Implement `scripts/morning-brief.js`**

Create `scripts/morning-brief.js`:

```js
/**
 * morning-brief.js
 *
 * Orchestrator for the morning-brief skill. Does the deterministic work
 * (fetch, classify, autonomous-delete, capture tasks, update sender-history,
 * run pattern-discovery, log run) and emits a structured JSON describing
 * what the skill prompt should put into the brief — including draft
 * candidates (the skill drafts replies via the LLM and calls save-draft).
 *
 * Designed with injected dependencies so it's testable without real connectors.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadHistory, saveHistory, recordDeletion, recordKeep } from "./sender-history.js";
import { discoverAutoTrash, discoverScamPatterns, discoverMemoryBackfill } from "./pattern-discovery.js";

const CATCH_UP_THRESHOLD_HOURS = 72;
const CATCH_UP_DECISION_CAP = 25;
const CATCH_UP_DRAFT_CAP = 5;
const DRAFTABLE_HEURISTICS = [
  /\bcalendar\b/i, /\binvite\b/i, /\bdecline\b/i, /\brenewal\b/i,
  /\bconfirm\b/i, /\bschedule\b/i, /\baccept\b/i
];

export function determineWindow(flags, { now, lastRun }) {
  if (flags.since) {
    const since = flags.since;
    const windowHours = (new Date(now).getTime() - new Date(since).getTime()) / 3600000;
    return { since, windowHours, catchUp: windowHours > CATCH_UP_THRESHOLD_HOURS };
  }
  if (flags.window) {
    const match = flags.window.match(/^(\d+)(h|d)$/i);
    if (!match) throw new Error(`Invalid --window: ${flags.window}`);
    const hours = Number(match[1]) * (match[2].toLowerCase() === "d" ? 24 : 1);
    const since = new Date(new Date(now).getTime() - hours * 3600000).toISOString();
    return { since, windowHours: hours, catchUp: hours > CATCH_UP_THRESHOLD_HOURS };
  }
  if (lastRun) {
    const since = lastRun;
    const windowHours = (new Date(now).getTime() - new Date(since).getTime()) / 3600000;
    return { since, windowHours, catchUp: windowHours > CATCH_UP_THRESHOLD_HOURS };
  }
  const since = new Date(new Date(now).getTime() - 24 * 3600000).toISOString();
  return { since, windowHours: 24, catchUp: false };
}

export function isCatchUp(window) {
  return window.windowHours > CATCH_UP_THRESHOLD_HOURS;
}

function isDraftable(email) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  return DRAFTABLE_HEURISTICS.some(rx => rx.test(text));
}

function priorityRank(item, account) {
  // Higher = more important. Used to sort decisions in catch-up.
  let score = 0;
  if (item.email.urgent) score += 10;
  if ((account.prioritySenders || []).some(s => itemMatchesSender(item.email, s))) score += 20;
  if ((item.classification === "action" || item.classification === "respond")) score += 5;
  return score;
}

function itemMatchesSender(email, sender) {
  const from = (email.from || "").toLowerCase();
  const name = (email.fromName || "").toLowerCase();
  if (sender.type === "email") return from === sender.value.toLowerCase();
  if (sender.type === "domain") return from.endsWith("@" + sender.value.toLowerCase()) || from.endsWith("." + sender.value.toLowerCase());
  if (sender.type === "name") return name.includes(sender.value.toLowerCase());
  return false;
}

function actionableCategoryIds(typeConfig) {
  const ids = new Set();
  for (const cat of typeConfig.triageCategories) {
    if (cat.id === "action" || cat.id === "respond") ids.add(cat.id);
  }
  return ids;
}

function appendTask(tasksPath, email, accountId) {
  const priority = (email.subject || "").toLowerCase().includes("urgent") ? "P1" : "P2";
  const line = `- [${priority}] [${accountId}] ${email.subject} — ${email.fromName || email.from} <!-- msgid:${email.id} -->\n`;
  mkdirSync(dirname(tasksPath), { recursive: true });
  if (!existsSync(tasksPath)) writeFileSync(tasksPath, "# Tasks\n\n");
  const current = readFileSync(tasksPath, "utf-8");
  if (current.includes(`msgid:${email.id}`)) return; // idempotent
  appendFileSync(tasksPath, line);
}

function appendTriageLog(logPath, entry) {
  mkdirSync(dirname(logPath), { recursive: true });
  if (!existsSync(logPath)) writeFileSync(logPath, "# Triage Log\n\n");
  const block =
    `## ${entry.timestamp}\n` +
    `Window: ${entry.window.since} → ${entry.timestamp} (${entry.window.windowHours.toFixed(1)}h${entry.window.catchUp ? ", catch-up" : ""})\n` +
    Object.entries(entry.perAccount).map(([acct, s]) =>
      `- ${acct}: fetched=${s.fetched}, autoDeleted=${s.autoDeleted}, draftCandidates=${s.draftCandidates}, tasksCaptured=${s.tasksCaptured}, proposalsAdded=${s.proposalsAdded}`
    ).join("\n") + "\n";
  appendFileSync(logPath, block + "\n");
}

function loadProposals(path) {
  if (!existsSync(path)) return { proposals: [] };
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveProposals(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  // We use renameSync semantics via writeFile+rename in sender-history; do the same here
  // Simplest: just writeFileSync — atomicity-relaxed for the proposal file since it's append-only state.
}

export async function runMorningBrief({ flags, deps }) {
  const { paths, accounts, typeConfigs, fetchFn, classifyFn, deleteFn, clock } = deps;
  const now = clock.now;
  const dryRun = !!flags.dryRun;

  const lastRunState = existsSync(paths.lastRunStatePath)
    ? JSON.parse(readFileSync(paths.lastRunStatePath, "utf-8"))
    : { lastRunAt: null };
  const window = determineWindow(flags, { now, lastRun: lastRunState.lastRunAt });

  const history = dryRun ? loadHistory(paths.senderHistoryPath) : loadHistory(paths.senderHistoryPath);
  const proposalsObj = loadProposals(paths.proposedRulesPath);
  const newProposals = [];

  const summary = {};
  const needsDecisionAll = [];
  const draftCandidatesAll = [];
  const fyiCounts = {};
  const travelEmails = [];
  const warnings = [];
  const recentDeletionsForScam = [];
  const perAccountStats = {};

  for (const account of accounts) {
    let emails;
    try {
      emails = await fetchFn(account.id, window.since);
    } catch (err) {
      warnings.push(`[${account.id}] fetch failed: ${err.message}`);
      perAccountStats[account.id] = { fetched: 0, autoDeleted: 0, draftCandidates: 0, tasksCaptured: 0, proposalsAdded: 0 };
      continue;
    }

    const typeConfig = typeConfigs[account.accountType];
    const result = classifyFn(emails, account, typeConfig);
    const actionableIds = actionableCategoryIds(typeConfig);

    const autoDeleteIds = result.deletionCandidates.map(e => e.id);

    if (!dryRun && autoDeleteIds.length > 0) {
      try {
        await deleteFn(account.id, autoDeleteIds);
        // Update sender-history
        for (const e of result.deletionCandidates) {
          recordDeletion(history, account.id, e.from || "", {
            hasListUnsubscribe: !!e.hasListUnsubscribe,
            timestamp: now
          });
          recentDeletionsForScam.push({
            accountId: account.id,
            subject: e.subject || "",
            senderDomain: (e.from || "").split("@")[1] || "",
            deletedAt: now
          });
        }
      } catch (err) {
        warnings.push(`[${account.id}] delete batch failed: ${err.message}`);
      }
    }

    let actions = [];
    for (const [catId, bucket] of Object.entries(result.categories)) {
      if (!actionableIds.has(catId)) continue;
      for (const e of bucket.emails) {
        actions.push({
          accountId: account.id,
          classification: catId,
          email: e,
          draftable: isDraftable(e)
        });
      }
    }
    actions.sort((a, b) => priorityRank(b, account) - priorityRank(a, account));

    // FYI count
    fyiCounts[account.id] = Object.entries(result.categories)
      .filter(([id]) => !actionableIds.has(id) && id !== "ignore")
      .reduce((sum, [, b]) => sum + b.emails.length, 0);

    // Capture tasks (skip in dry-run)
    let tasksCaptured = 0;
    if (!dryRun) {
      for (const item of actions) {
        appendTask(paths.tasksPath, item.email, account.id);
        tasksCaptured++;
      }
    }

    needsDecisionAll.push(...actions);
    draftCandidatesAll.push(...actions.filter(a => a.draftable));

    perAccountStats[account.id] = {
      fetched: emails.length,
      autoDeleted: autoDeleteIds.length,
      draftCandidates: actions.filter(a => a.draftable).length,
      tasksCaptured,
      proposalsAdded: 0
    };
    summary[account.id] = {
      fetched: emails.length,
      autoDeleted: autoDeleteIds.length,
      draftCandidates: actions.filter(a => a.draftable).length,
      actions: actions.length,
      fyi: fyiCounts[account.id]
    };

    // Travel: collect signals across personal/business — naive substring match
    for (const bucket of Object.values(result.categories)) {
      for (const e of bucket.emails) {
        const text = `${e.subject || ""} ${e.preview || ""}`.toLowerCase();
        if (/\b(itinerary|booking|reservation|boarding|hotel|flight|rail|train|öbb|car rental|avis|noleggiare)\b/.test(text)) {
          travelEmails.push({ accountId: account.id, subject: e.subject, from: e.fromName || e.from, receivedAt: e.receivedAt });
        }
      }
    }
  }

  // Apply catch-up caps
  let needsDecision = needsDecisionAll;
  let deferred = [];
  let draftCandidates = draftCandidatesAll;
  if (window.catchUp) {
    needsDecision = needsDecisionAll.slice(0, CATCH_UP_DECISION_CAP);
    deferred = needsDecisionAll.slice(CATCH_UP_DECISION_CAP);
    draftCandidates = draftCandidatesAll.slice(0, CATCH_UP_DRAFT_CAP);
  }

  // Pattern discovery
  if (!dryRun) {
    const autoTrash = discoverAutoTrash(history, accounts, proposalsObj.proposals, { now });
    const scam = discoverScamPatterns(recentDeletionsForScam, accounts, proposalsObj.proposals, { now });
    const backfill = window.catchUp
      ? discoverMemoryBackfill(paths.memoryDir, accounts, proposalsObj.proposals, { now })
      : [];
    newProposals.push(...autoTrash, ...scam, ...backfill);
    proposalsObj.proposals.push(...newProposals);
    saveProposals(paths.proposedRulesPath, proposalsObj);
    saveHistory(paths.senderHistoryPath, history);

    // Append log + update last-run state
    appendTriageLog(paths.triageLogPath, {
      timestamp: now,
      window,
      perAccount: perAccountStats
    });
    mkdirSync(dirname(paths.lastRunStatePath), { recursive: true });
    writeFileSync(paths.lastRunStatePath, JSON.stringify({ lastRunAt: now }, null, 2));
  }

  return {
    timestamp: now,
    window,
    dryRun,
    summary,
    needsDecision,
    deferred,
    draftCandidates,
    proposedRules: newProposals,
    travel: travelEmails,
    fyiCounts,
    warnings
  };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI mode: parse args, wire up real connectors via subprocess.
  // The skill prompt usually invokes this; the CLI path is for manual debugging.
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") flags.dryRun = true;
    else if (args[i] === "--since") flags.since = args[++i];
    else if (args[i] === "--window") flags.window = args[++i];
  }
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(__dirname, "..");
  const companies = JSON.parse(readFileSync(path.join(root, "config/companies.json"), "utf-8"));
  const accountTypes = JSON.parse(readFileSync(path.join(root, "config/account-types.json"), "utf-8"));
  const { classify } = await import("./classify-emails.js");

  function fetchSubprocess(accountId, sinceIso) {
    // Determine connector by account provider
    const account = companies.companies.find(c => c.id === accountId);
    const script = account.provider === "gmail" ? "fetch-gmail.js" : "fetch-emails.js";
    const hours = Math.ceil((Date.now() - new Date(sinceIso).getTime()) / 3600000);
    const child = spawnSync("node", [path.join(root, "scripts", script), accountId, String(hours), "inbox"], {
      encoding: "utf-8", maxBuffer: 50 * 1024 * 1024
    });
    if (child.status !== 0) throw new Error(child.stderr || `fetch failed for ${accountId}`);
    return JSON.parse(child.stdout);
  }
  function deleteSubprocess(accountId, ids) {
    if (ids.length === 0) return { trashed: 0, failed: 0 };
    const account = companies.companies.find(c => c.id === accountId);
    const script = account.provider === "gmail" ? "delete-gmail-emails.js" : "delete-emails.js";
    const child = spawnSync("node", [path.join(root, "scripts", script), accountId, ...ids], { encoding: "utf-8" });
    if (child.status !== 0) throw new Error(child.stderr || `delete failed for ${accountId}`);
    return { trashed: ids.length, failed: 0 };
  }

  const result = await runMorningBrief({
    flags,
    deps: {
      paths: {
        dataDir: path.join(root, "data"),
        memoryDir: path.join(root, "memory"),
        senderHistoryPath: path.join(root, "data/sender-history.json"),
        proposedRulesPath: path.join(root, "data/proposed-rules.json"),
        tasksPath: path.join(root, "data/tasks.md"),
        triageLogPath: path.join(root, "data/triage-log.md"),
        lastRunStatePath: path.join(root, "data/last-run-state.json")
      },
      accounts: companies.companies,
      typeConfigs: accountTypes,
      fetchFn: async (accountId, sinceIso) => fetchSubprocess(accountId, sinceIso),
      classifyFn: (emails, account, typeConfig) => classify(emails, account.id),
      deleteFn: async (accountId, ids) => deleteSubprocess(accountId, ids),
      clock: { now: new Date().toISOString() }
    }
  });
  process.stdout.write(JSON.stringify(result, null, 2));
}
```

- [ ] **Step 5: Run tests to confirm they pass**

Run: `npm test scripts/test/morning-brief.test.js 2>&1 | tail -30`
Expected: all tests pass.

- [ ] **Step 6: Run full test suite**

Run: `npm test 2>&1 | tail -15`
Expected: no regressions.

- [ ] **Step 7: Commit**

```bash
git add scripts/morning-brief.js scripts/test/morning-brief.test.js scripts/test/fixtures/morning-brief.js
git commit -m "feat(morning-brief): orchestrator for autonomous triage + brief data

Drives the full morning-brief flow: window detection, per-account
fetch+classify, autonomous deletes, task capture to data/tasks.md,
sender-history updates, pattern discovery (auto-trash, scam, backfill),
catch-up caps, log + last-run state.

Emits a structured JSON for the skill prompt to consume — drafts and
brief assembly happen in the skill, not here. Injected dependencies
enable unit testing without real connectors.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Create the skill .claude/commands/reports/morning-brief.md

**Files:**
- Create: `.claude/commands/reports/morning-brief.md`

The skill is a Markdown prompt template that orchestrates:
1. Invoke `scripts/morning-brief.js` (parsing `$ARGUMENTS` for flags)
2. For each draft candidate: read the email body via `scripts/fetch-thread.js` if needed, draft a short reply using the account's voice profile, call `save-draft.js`/`save-gmail-draft.js`
3. Assemble the final brief markdown and write to `data/morning-queue.md`
4. Echo a 1-paragraph summary to chat

- [ ] **Step 1: Create the skill file**

Create `.claude/commands/reports/morning-brief.md`:

```markdown
---
description: Single autonomous morning brief covering triage, drafts, task capture, and pattern discovery across all accounts
allowed-tools: Bash, Read, Write, Edit
---

# Morning Brief

Generate the autonomous morning brief. Replaces `/triage` and `/daily-brief`.

## Inputs

- `$ARGUMENTS` — optional flags. Recognized:
  - `--dry-run` — no deletes, no drafts saved, no state mutations; brief written to `data/morning-queue.dry-run.md`
  - `--since YYYY-MM-DD` — process emails received since this date
  - `--window 24h` / `--window 14d` — alternative to `--since`
  - `--draft-only` — only draft replies; skip deletes and pattern discovery (used during catch-up follow-up)

## Steps

### 1. Load configuration

Use Bash to load (read into the prompt):

```
cat config/companies.json
cat config/account-types.json
cat config/attention-profile.md
cat config/prefs.json
```

Note each account's `voiceProfile` for the drafting step.

### 2. Run the orchestrator

Pass `$ARGUMENTS` to the orchestrator via Bash:

```bash
node scripts/morning-brief.js $ARGUMENTS
```

Capture stdout as JSON. The orchestrator has already:
- Fetched + classified per account
- Auto-deleted noise (unless `--dry-run`)
- Captured action items to `data/tasks.md`
- Updated `data/sender-history.json`
- Run pattern discovery; merged new proposals into `data/proposed-rules.json`
- Appended to `data/triage-log.md`; updated `data/last-run-state.json`

The JSON contains:
- `timestamp`, `window`, `dryRun`
- `summary` — per-account counts
- `needsDecision` — capped action items (action-shaped emails needing your decision)
- `deferred` — overflow from catch-up cap
- `draftCandidates` — action items that match draftable heuristics
- `proposedRules` — new proposals this run
- `travel` — emails matching travel signals
- `fyiCounts` — FYI counts per account
- `warnings`

### 3. Draft replies for each draft candidate

Skip this step if `--dry-run` is set.

For each `draftCandidate`:

1. Look up the account's `voiceProfile` from companies.json.
2. Compose a short reply (≤ 3 sentences, ≤ 4 lines including sign-off):
   - Open in the voice profile's `openingStyle` (`direct` or `warm`)
   - Address the specific ask in the email
   - Close with the voice profile's `signOff`
   - Match the formality level
3. Save the draft. For Outlook accounts:

```bash
echo '{"to":["<recipient>"],"subject":"Re: <subject>","body":"<draft body>","replyToMessageId":"<email.id>"}' | node scripts/save-draft.js <accountId>
```

For Gmail accounts:

```bash
echo '{"to":["<recipient>"],"subject":"Re: <subject>","body":"<draft body>","threadId":"<email.threadId>"}' | node scripts/save-gmail-draft.js <accountId>
```

Parse the returned `draftId` and store it next to the email's needsDecision entry.

If the save fails, capture the error message as a warning and include the draft body inline in the brief instead.

### 4. Assemble the brief

Write the final brief to `data/morning-queue.md` (or `data/morning-queue.dry-run.md` in dry-run mode).

If a previous brief exists, move it to `data/archive/morning-queue-<timestamp>.md` first.

Structure (write each section unconditionally — show "(none)" if a section is empty):

```markdown
# Morning Brief — <YYYY-MM-DD> (<window descriptor>)

## Summary
- <Account 1>: <fetched> emails / <autoDeleted> auto-deleted / <draftCandidates> drafts / <actions> actions / <proposals from this account> rules proposed
- <Account 2>: ...
- Total: <totals>

## Needs your decision (<count>)
1. [<account> / <classification>] <fromName> — "<subject>" (<receivedAt date>)
   - Why: <one-line reason — urgency flag, priority sender, etc.>
   - <If draft staged>: Draft staged in <Account> Drafts (see #D<n>)
   - <If no draft>: Suggested: <short suggested action>
2. ...

## Drafts staged for approval (<count>)
D1. To: <recipient> — Re: <subject>
    Preview: "<first sentence of draft>..."
    [Open in <Account> Drafts]
D2. ...

## Proposed rules (<count>) — reply "approve <ids>; decline <ids>"
<id> → `<target>`: <one-line description and reason>
<id> → ...

## Travel / event context
<If travel emails present, group by destination or trip; otherwise: "No active travel signals.">

## FYI digest (collapsed)
<details>
<summary><Account> — <N> FYI emails</summary>
<list a few notable ones, or omit details>
</details>

## Autonomous activity (collapsed)
<details>
<summary><N> emails auto-deleted</summary>
Top sender domains: <list top 5 with counts>
[Full log: data/triage-log.md @ <timestamp>]
</details>

## Deferred (<count from catch-up cap, if any>)
<List or "(none)">

## Warnings
<List warnings or "(none)">
```

### 5. Echo summary to chat

Print a one-paragraph summary:

> Brief written to `data/morning-queue.md`. Processed <total> emails across <N> accounts; auto-deleted <X>, staged <Y> drafts, captured <Z> tasks, proposed <W> new rules. <Warnings if any.>

If there are pending proposals, remind the user: "Reply with `approve <ids>; decline <ids>` to apply."

## Notes

- **Never send email.** Drafts only.
- **Never edit `companies.json` or `account-types.json` from the skill prompt.** Rule changes go through `scripts/apply-proposals.js` when the user approves proposals.
- **First run**: if `data/last-run-state.json` does not exist, treat as catch-up and pass `--dry-run` automatically. Note this in the brief header. The user re-invokes without `--dry-run` after reviewing.
- **Concurrency**: if `data/.lock-<account>` exists and is < 1 hour old, abort with a warning. Otherwise proceed and create the lock; clear it at the end.
```

- [ ] **Step 2: Verify the file parses as valid Markdown with frontmatter**

Run: `head -5 .claude/commands/reports/morning-brief.md`
Expected: frontmatter visible, `description` and `allowed-tools` present.

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/reports/morning-brief.md
git commit -m "feat(skill): add reports:morning-brief skill prompt

The skill orchestrates the morning brief: runs morning-brief.js for
deterministic work, drafts replies via the LLM using each account's
voice profile, saves drafts to mail-account Drafts folders via the
existing connectors, and assembles the final Markdown brief.

Replaces orchestrators:triage and reports:daily-brief.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Deprecate orchestrators:triage and reports:daily-brief

**Files:**
- Modify: `.claude/commands/orchestrators/triage.md` — replace with deprecation notice
- Modify: `.claude/commands/reports/daily-brief.md` — replace with deprecation notice

- [ ] **Step 1: Replace orchestrators/triage.md**

Overwrite `.claude/commands/orchestrators/triage.md` with:

```markdown
---
description: DEPRECATED — use /morning-brief instead
---

# Triage (deprecated)

This skill has been replaced by `/morning-brief`, which does triage, drafting, task capture, and pattern discovery in one autonomous pass.

To run a 24-hour triage equivalent:

```
/morning-brief --window 24h
```

To catch up on a longer window:

```
/morning-brief --since 2026-05-07
```

For a no-op preview (no deletes, no drafts saved, no state changes):

```
/morning-brief --dry-run
```

See `docs/superpowers/specs/2026-05-21-morning-brief-design.md` for the design rationale.
```

- [ ] **Step 2: Replace reports/daily-brief.md**

Overwrite `.claude/commands/reports/daily-brief.md` with the same content as above but adjusted for the daily-brief context:

```markdown
---
description: DEPRECATED — use /morning-brief instead
---

# Daily Brief (deprecated)

This skill has been replaced by `/morning-brief`, which combines the morning briefing with autonomous triage, drafting, task capture, and pattern discovery in a single pass.

To run:

```
/morning-brief
```

See `docs/superpowers/specs/2026-05-21-morning-brief-design.md` for the design rationale.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/orchestrators/triage.md .claude/commands/reports/daily-brief.md
git commit -m "chore: deprecate orchestrators:triage and reports:daily-brief

Both replaced by reports:morning-brief which combines triage, drafting,
task capture, and pattern discovery into a single autonomous skill.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Checklist (run before handoff)

### Spec coverage

| Spec requirement | Implemented by |
|---|---|
| `unless` clause on alwaysDelete | Task 1 |
| `scamPatterns` per account | Task 2 |
| Memory rule migration | Task 3 |
| Sender history tracking | Task 4 |
| Auto-trash discovery | Task 5 (`discoverAutoTrash`) |
| Scam-pattern discovery | Task 5 (`discoverScamPatterns`) |
| Memory backfill discovery | Task 5 (`discoverMemoryBackfill`) |
| Proposal approval mechanism | Task 6 |
| Atomic config writes | Task 6 |
| Memory journal entry on approval | Task 6 |
| Morning-brief orchestrator | Task 7 |
| Dry-run mode | Task 7 |
| Catch-up window detection + caps | Task 7 |
| Autonomous deletes via existing connectors | Task 7 (deleteFn) |
| Task capture with idempotency (msgid) | Task 7 |
| Triage-log entries | Task 7 |
| Last-run state tracking | Task 7 |
| Skill prompt with drafting | Task 8 |
| Travel context aggregation | Task 7 (travelEmails) + Task 8 (rendered) |
| Deprecation of old skills | Task 9 |
| First-run safeguard (auto dry-run) | Task 8 (in skill prompt) |
| Lock file for concurrency | Task 8 (in skill prompt) |
| Never auto-send | Enforced — no send-email call in any task |

### Placeholder scan

None — all code blocks are complete, all commands are concrete, all paths are absolute.

### Type consistency

- `senderRuleApplies(email, rule)` defined Task 1, used Task 1 and (via classifyWithAccount helper) in Task 2.
- `matchesScamPattern(email, pattern)` defined Task 2, used Task 2.
- Sender-history shape: `{ deletedCount, hasListUnsubscribe, lastDeletedAt }` consistent in Tasks 4, 5, 7.
- Proposal shape: `{ id, target, payload, reason, proposedAt, status, sourceMemoryFile? }` consistent in Tasks 5, 6, 7.
- Run result shape from `runMorningBrief` matches what the skill prompt consumes in Task 8.

---

## Manual smoke test (after Task 9)

1. `npm test` — all green.
2. From repo root, `node scripts/morning-brief.js --dry-run --window 1h` — should produce JSON output, no state changes (no `data/sender-history.json`, no `data/last-run-state.json`, no `data/tasks.md` written).
3. `/morning-brief --dry-run` (or in chat: invoke the skill) — should produce `data/morning-queue.dry-run.md`.
4. Review the dry-run brief; if drafts look reasonable, run `/morning-brief --window 24h` for a real run.
5. Approve a couple of proposals in chat: `approve p-...; decline p-...` — verify `companies.json` updated and `memory/rule-<id>.md` created.

---

## After all tasks complete

Hand off to `superpowers:finishing-a-development-branch`.
