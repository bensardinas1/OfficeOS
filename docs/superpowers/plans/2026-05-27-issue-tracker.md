# Issue Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reasoning layer + topic-based issue graph on top of the morning-brief pipeline, so email feeds into issues the user converses with (`pp?` → 3-line status; `draft pp` → context-aware reply) instead of a deletion queue.

**Architecture:** A deterministic issue store (`scripts/issue-store.js`) owns `data/issues/*.md` files. A deterministic applier (`scripts/issue-apply.js`) turns reasoner-output records into issue-store mutations + a soft-delete list. The LLM reasoning itself lives in a shared prompt fragment included by the `/issues` skill and the morning-brief skill. `classify-emails.js` and `morning-brief.js` gain the ability to separate explicit (deliberate) deletions from heuristic (guessed) ones, so only the guesses reach the reasoner.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict` (run `npm test`, glob `scripts/test/**/*.test.js`). New dependency: `js-yaml` for issue-file frontmatter. Markdown skill prompts in `.claude/commands/`.

**Spec:** `docs/superpowers/specs/2026-05-27-issue-tracker-design.md`

---

## Spec-to-code reconciliation (read before starting)

The spec's deletion boundary says "explicit alwaysDelete / approved scamPatterns / neverDelete never reach the reasoner; bulk-signal + auto-discovered scamPattern hits do." In the code, **scamPatterns in `config/companies.json` are always already-approved** (auto-discovered ones live in `data/proposed-rules.json`, not in config, and don't fire in `classify()` until approved). Therefore the implementable split is:

- **Explicit deletions** (trash immediately, never deferred): `alwaysDelete` sender match OR `scamPatterns` match — both are deliberate config entries. These are the `forceDelete` branch in `classify()`.
- **Heuristic deletions** (deferred to reasoner when the flag is set): bulk-signal classification into `ignore` + `deletionPolicy.patterns` substring matches — the `else if (deletionCategoryIds.has(...) || matchesDeletionPattern(...))` branch.

This honors decision B's spirit (deliberate per-rule decisions stay fast; fuzzy guesses get reasoned) and matches code reality.

---

## File structure

**Create:**
- `scripts/issue-store.js` — deterministic CRUD over `data/issues/*.md`. Responsibility: read/write/find/merge/graduate issue files + assignment state. No LLM.
- `scripts/issue-apply.js` — deterministic applier: reasoner-output records → issue-store mutations + soft-delete list. No LLM, no network.
- `.claude/commands/issues/_reasoner-pass.md` — shared reasoner-pass prompt fragment (the LLM judgment instructions).
- `.claude/commands/issues/issues.md` — the `/issues` skill (bootstrap, status view, drill-in, verbs, draft).
- `scripts/test/issue-store.test.js`, `scripts/test/issue-apply.test.js`
- `scripts/test/fixtures/issues.js` — issue-file fixtures, reasoner-output fixtures, the SEAA email fixture + expected verdicts.

**Modify:**
- `scripts/classify-emails.js` — add `explicitDeletions[]` and `heuristicDeletions[]` to the `classify()` result (Task 1).
- `scripts/morning-brief.js` — add `--defer-heuristic-deletes` flag + last-run bundle write (Task 4).
- `scripts/pattern-discovery.js` — `discoverAutoTrash` skips senders already in `alwaysDelete` (Task 5).
- `.claude/commands/reports/morning-brief.md` — piggyback the reasoner pass at end of run (Task 9).
- `package.json` — add `js-yaml` dependency (Task 2).

---

## Task 1: Tag explicit vs heuristic deletions in classify-emails.js

**Files:**
- Modify: `scripts/classify-emails.js` (the `classify()` function, ~lines 240-295)
- Test: `scripts/test/classify-emails.test.js`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/classify-emails.test.js`:

```js
describe("classify — explicit vs heuristic deletion tagging", () => {
  const account = {
    id: "brickellpay",
    name: "Brickell Pay",
    accountType: "business",
    provider: "outlook",
    myEmail: "ben@brickellpay.com",
    prioritySenders: [],
    urgencyRules: { flags: [] },
    downrank: [],
    alwaysDelete: [{ type: "name", value: "SpamCo", label: "spam" }],
    neverDelete: [],
    scamPatterns: [{ label: "AR scam", subjectAll: ["annual report"], senderAllowlist: ["sunbiz.org"], action: "delete" }],
  };
  const typeConfig = {
    triageCategories: [
      { id: "action", label: "ACTION", actionable: true },
      { id: "fyi", label: "FYI" },
      { id: "ignore", label: "IGNORE", hidden: true },
    ],
    downrankDefaults: [],
    bulkSignalThreshold: 1,
    deletionPolicy: { categories: ["ignore"], patterns: ["limited time offer"], neverDelete: [], alwaysDelete: [] },
  };

  it("tags alwaysDelete hits as explicit", () => {
    const emails = [{ id: "e1", fromName: "SpamCo", from: "x@spamco.com", subject: "buy now" }];
    const r = classifyWithAccount(emails, account, typeConfig);
    assert.equal(r.explicitDeletions.length, 1);
    assert.equal(r.heuristicDeletions.length, 0);
    assert.equal(r.deletionCandidates.length, 1); // backward-compat: still in the flat list
  });

  it("tags scamPattern hits as explicit", () => {
    const emails = [{ id: "e1", from: "x@flcorpfiling.com", fromName: "Filing Co", subject: "Annual Report Notice" }];
    const r = classifyWithAccount(emails, account, typeConfig);
    assert.equal(r.explicitDeletions.length, 1);
    assert.equal(r.heuristicDeletions.length, 0);
  });

  it("tags bulk-signal / pattern deletions as heuristic", () => {
    const emails = [{ id: "e1", from: "noreply@news.example.com", fromName: "Newsletter", subject: "limited time offer", hasListUnsubscribe: true }];
    const r = classifyWithAccount(emails, account, typeConfig);
    assert.equal(r.explicitDeletions.length, 0);
    assert.equal(r.heuristicDeletions.length, 1);
    assert.equal(r.deletionCandidates.length, 1);
  });

  it("keeps survivors out of both deletion lists", () => {
    const emails = [{ id: "e1", from: "partner@brickellpay.com", fromName: "Partner", subject: "Re: contract question" }];
    const r = classifyWithAccount(emails, account, typeConfig);
    assert.equal(r.explicitDeletions.length, 0);
    assert.equal(r.heuristicDeletions.length, 0);
  });
});
```

Note: `classifyWithAccount` is the existing test helper near the top of the file. It currently does not populate `explicitDeletions`/`heuristicDeletions`. Update the helper's deletion block to mirror the production change you make in Step 3 (same branch tagging), so the helper stays faithful to `classify()`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "explicit vs heuristic"`
Expected: failures — `r.explicitDeletions` is undefined.

- [ ] **Step 3: Implement the tagging in `classify()`**

In `scripts/classify-emails.js`, find the result initialization (~line 240):

```js
    accountType: typeKey,
    categories: {},
    deletionCandidates: [],
  };
```

Change to:

```js
    accountType: typeKey,
    categories: {},
    deletionCandidates: [],
    explicitDeletions: [],
    heuristicDeletions: [],
  };
```

Then find the per-email deletion block (~lines 280-291):

```js
    // Force into deletion candidates
    if (forceDelete) {
      result.deletionCandidates.push(email);
    }
    // neverDelete protects against pattern/category-based deletion
    else if (isProtected) {
      // skip — protected sender
    }
    // Standard category/pattern-based deletion
    else if (deletionCategoryIds.has(categoryId) || matchesDeletionPattern(email, policy.patterns || [])) {
      result.deletionCandidates.push(email);
    }
```

Change to:

```js
    // Force into deletion candidates — explicit (deliberate config rule)
    if (forceDelete) {
      result.deletionCandidates.push(email);
      result.explicitDeletions.push(email);
    }
    // neverDelete protects against pattern/category-based deletion
    else if (isProtected) {
      // skip — protected sender
    }
    // Standard category/pattern-based deletion — heuristic (guessed)
    else if (deletionCategoryIds.has(categoryId) || matchesDeletionPattern(email, policy.patterns || [])) {
      result.deletionCandidates.push(email);
      result.heuristicDeletions.push(email);
    }
```

- [ ] **Step 4: Update the `classifyWithAccount` test helper**

In `scripts/test/classify-emails.test.js`, find the helper's result object and deletion block. Add `explicitDeletions: []` and `heuristicDeletions: []` to its result init, and mirror the same two `push` additions in its deletion branches (the helper already has the matching `forceDelete` / `isProtected` / pattern branches from prior tasks).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: all tests pass (191 prior + 4 new = 195).

- [ ] **Step 6: Commit**

```bash
git add scripts/classify-emails.js scripts/test/classify-emails.test.js
git commit -m "feat(classify): tag deletions as explicit vs heuristic

Adds explicitDeletions[] and heuristicDeletions[] to the classify() result
alongside the existing flat deletionCandidates[] (backward compatible).
Explicit = alwaysDelete/scamPattern config hits (deliberate). Heuristic =
bulk-signal/pattern guesses. Enables the reasoner to review only the guesses.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: issue-store.js — frontmatter primitives + read side

**Files:**
- Modify: `package.json` (add js-yaml)
- Create: `scripts/issue-store.js`
- Test: `scripts/test/issue-store.test.js`

- [ ] **Step 1: Add the js-yaml dependency**

Run: `npm install js-yaml`
Expected: `package.json` gains `"js-yaml": "^4.1.0"` under dependencies; `package-lock.json` updated.

- [ ] **Step 2: Write the failing test**

Create `scripts/test/issue-store.test.js`:

```js
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  slugify, parseIssueFile, serializeIssue,
  loadIssues, loadProvisional, findByAlias, listByStatus,
} from "../issue-store.js";

let tmpDir, issuesDir;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "issue-store-test-"));
  issuesDir = join(tmpDir, "issues");
  mkdirSync(join(issuesDir, "provisional"), { recursive: true });
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

function writeIssue(dir, name, content) { writeFileSync(join(dir, name), content); }

describe("slugify", () => {
  it("kebab-cases a title", () => assert.equal(slugify("Path Peptides Onboarding"), "path-peptides-onboarding"));
  it("strips punctuation and collapses spaces", () => assert.equal(slugify("HHC: Schedule 1 (urgent!)"), "hhc-schedule-1-urgent"));
  it("trims leading/trailing hyphens", () => assert.equal(slugify("  — SEAA — "), "seaa"));
});

describe("parseIssueFile / serializeIssue", () => {
  it("round-trips frontmatter and body", () => {
    const issue = { id: "pp", title: "Path Peptides", aliases: ["pp"], status: "open", body: "## Decisions made\n- x" };
    const parsed = parseIssueFile(serializeIssue(issue));
    assert.equal(parsed.id, "pp");
    assert.deepEqual(parsed.aliases, ["pp"]);
    assert.equal(parsed.status, "open");
    assert.match(parsed.body, /Decisions made/);
  });
  it("parses a file with no frontmatter as body-only", () => {
    const parsed = parseIssueFile("just text");
    assert.equal(parsed.body, "just text");
  });
});

describe("loadIssues / loadProvisional", () => {
  it("loads real issues from the top level only", () => {
    writeIssue(issuesDir, "pp.md", "---\nid: pp\ntitle: PP\nstatus: open\n---\nbody");
    writeIssue(join(issuesDir, "provisional"), "x.md", "---\nid: x\ntitle: X\nstatus: open\n---\nbody");
    const real = loadIssues(issuesDir);
    assert.equal(real.length, 1);
    assert.equal(real[0].id, "pp");
    assert.equal(real[0]._provisional, false);
  });
  it("loads provisional issues from the provisional subdir", () => {
    writeIssue(join(issuesDir, "provisional"), "x.md", "---\nid: x\ntitle: X\nstatus: open\n---\nbody");
    const prov = loadProvisional(issuesDir);
    assert.equal(prov.length, 1);
    assert.equal(prov[0]._provisional, true);
  });
  it("returns [] when the dir does not exist", () => {
    assert.deepEqual(loadIssues(join(tmpDir, "nope")), []);
  });
  it("skips a corrupt file rather than throwing", () => {
    writeIssue(issuesDir, "good.md", "---\nid: good\ntitle: G\nstatus: open\n---\nb");
    writeIssue(issuesDir, "bad.md", "---\n: : : not yaml : :\n---\nb");
    const real = loadIssues(issuesDir);
    assert.ok(real.find(i => i.id === "good"));
  });
});

describe("findByAlias", () => {
  const issues = [
    { id: "path-peptides", title: "Path Peptides", aliases: ["pp", "peptides"], status: "open" },
    { id: "ms-billing", title: "MS Billing", aliases: ["ms"], status: "open" },
  ];
  it("matches by id", () => assert.equal(findByAlias(issues, "ms-billing").id, "ms-billing"));
  it("matches by alias", () => assert.equal(findByAlias(issues, "pp").id, "path-peptides"));
  it("is case-insensitive", () => assert.equal(findByAlias(issues, "PP").id, "path-peptides"));
  it("returns null when nothing matches", () => assert.equal(findByAlias(issues, "zzz"), null));
});

describe("listByStatus", () => {
  const issues = [
    { id: "a", status: "open" }, { id: "b", status: "snoozed" }, { id: "c", status: "open" },
  ];
  it("filters by status", () => assert.deepEqual(listByStatus(issues, "open").map(i => i.id), ["a", "c"]));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test scripts/test/issue-store.test.js 2>&1 | tail -10`
Expected: cannot find module `../issue-store.js`.

- [ ] **Step 4: Implement the read side of `scripts/issue-store.js`**

Create `scripts/issue-store.js`:

```js
/**
 * issue-store.js
 *
 * Deterministic CRUD over the issue graph in data/issues/*.md.
 * Real issues live at the top level; provisional singletons live in
 * data/issues/provisional/. No LLM, no judgment — pure file operations.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { atomicWrite } from "./fs-utils.js";

export function slugify(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseIssueFile(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { body: content.trim() };
  const front = yaml.load(m[1]) || {};
  return { ...front, body: (m[2] || "").trim() };
}

export function serializeIssue(issue) {
  // Strip runtime-only fields (_path, _provisional) and body before dumping.
  const { body = "", _path, _provisional, ...frontmatter } = issue;
  return `---\n${yaml.dump(frontmatter)}---\n\n${body.trim()}\n`;
}

function readDirIssues(dir, provisional) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      const issue = parseIssueFile(readFileSync(path, "utf-8"));
      issue._path = path;
      issue._provisional = provisional;
      out.push(issue);
    } catch {
      // Corrupt file — skip rather than crash the whole load.
    }
  }
  return out;
}

export function loadIssues(issuesDir) {
  // Top-level *.md only (not the provisional/ subdir).
  return readDirIssues(issuesDir, false);
}

export function loadProvisional(issuesDir) {
  return readDirIssues(join(issuesDir, "provisional"), true);
}

export function findByAlias(issues, needle) {
  const n = (needle || "").toLowerCase();
  return issues.find(i =>
    (i.id || "").toLowerCase() === n ||
    (i.aliases || []).some(a => (a || "").toLowerCase() === n)
  ) || null;
}

export function listByStatus(issues, status) {
  return issues.filter(i => i.status === status);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test scripts/test/issue-store.test.js 2>&1 | tail -10`
Expected: all read-side tests pass.

- [ ] **Step 6: Run the full suite**

Run: `npm test 2>&1 | tail -6`
Expected: no regressions.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json scripts/issue-store.js scripts/test/issue-store.test.js
git commit -m "feat(issue-store): frontmatter primitives + read side

Adds js-yaml; implements slugify, parseIssueFile/serializeIssue round-trip,
loadIssues (top-level), loadProvisional (subdir), findByAlias (id or alias,
case-insensitive), listByStatus. Corrupt files are skipped, not fatal.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: issue-store.js — write side + assignment state

**Files:**
- Modify: `scripts/issue-store.js`
- Test: `scripts/test/issue-store.test.js`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/issue-store.test.js`:

```js
import {
  createIssue, saveIssue, markDone, snoozeIssue, mergeIssues, graduateProvisional,
  loadAssignmentState, saveAssignmentState,
} from "../issue-store.js";
import { existsSync, readFileSync } from "node:fs";

describe("createIssue / saveIssue", () => {
  it("creates a real issue file with defaults", () => {
    const issue = createIssue(issuesDir, { title: "Path Peptides", aliases: ["pp"], accounts: ["brickellpay"] }, { now: "2026-05-27" });
    assert.equal(issue.id, "path-peptides");
    assert.equal(issue.status, "open");
    assert.equal(issue._provisional, false);
    assert.ok(existsSync(join(issuesDir, "path-peptides.md")));
  });
  it("creates a provisional issue in the provisional subdir", () => {
    const issue = createIssue(issuesDir, { title: "One Off", accounts: ["personal"] }, { provisional: true, now: "2026-05-27" });
    assert.equal(issue._provisional, true);
    assert.ok(existsSync(join(issuesDir, "provisional", "one-off.md")));
  });
  it("saveIssue round-trips edits", () => {
    const issue = createIssue(issuesDir, { title: "MS Billing", aliases: ["ms"] }, { now: "2026-05-27" });
    issue.next_action = "Update card";
    saveIssue(issue);
    const reloaded = loadIssues(issuesDir).find(i => i.id === "ms-billing");
    assert.equal(reloaded.next_action, "Update card");
  });
});

describe("markDone / snoozeIssue", () => {
  it("markDone sets status done", () => {
    const issue = createIssue(issuesDir, { title: "X" }, { now: "2026-05-27" });
    markDone(issue);
    assert.equal(loadIssues(issuesDir).find(i => i.id === "x").status, "done");
  });
  it("snoozeIssue sets status + snooze_until", () => {
    const issue = createIssue(issuesDir, { title: "Y" }, { now: "2026-05-27" });
    snoozeIssue(issue, "2026-06-01");
    const r = loadIssues(issuesDir).find(i => i.id === "y");
    assert.equal(r.status, "snoozed");
    assert.equal(r.snooze_until, "2026-06-01");
  });
});

describe("mergeIssues", () => {
  it("folds source into target, dedupes linked msgids, removes source file", () => {
    const target = createIssue(issuesDir, { title: "Path Peptides", aliases: ["pp"] }, { now: "2026-05-27" });
    target.body = "## Linked messages\n- msgid:a — x\n- msgid:b — y";
    saveIssue(target);
    const source = createIssue(issuesDir, { title: "Peptides Thread", aliases: ["pep"] }, { now: "2026-05-27" });
    source.body = "## Linked messages\n- msgid:b — y\n- msgid:c — z";
    saveIssue(source);

    const merged = mergeIssues(target, source);
    assert.equal(merged.aliases.includes("pep"), true, "aliases combined");
    const msgids = (merged.body.match(/msgid:\w/g) || []);
    assert.equal(new Set(msgids).size, msgids.length, "no duplicate msgids");
    assert.ok(msgids.includes("msgid:c"));
    assert.equal(existsSync(source._path), false, "source file removed");
  });
});

describe("graduateProvisional", () => {
  it("moves a provisional file to the top level", () => {
    createIssue(issuesDir, { title: "Maybe Real", aliases: ["mr"] }, { provisional: true, now: "2026-05-27" });
    const graduated = graduateProvisional(issuesDir, "maybe-real");
    assert.equal(graduated._provisional, false);
    assert.ok(existsSync(join(issuesDir, "maybe-real.md")));
    assert.equal(existsSync(join(issuesDir, "provisional", "maybe-real.md")), false);
  });
  it("returns null when the provisional slug is absent", () => {
    assert.equal(graduateProvisional(issuesDir, "ghost"), null);
  });
});

describe("assignment state", () => {
  it("returns default when file missing", () => {
    assert.deepEqual(loadAssignmentState(join(tmpDir, "state.json")), { lastAssignedAt: {} });
  });
  it("round-trips", () => {
    const p = join(tmpDir, "state.json");
    saveAssignmentState(p, { lastAssignedAt: { brickellpay: "2026-05-27T00:00:00Z" } });
    assert.equal(loadAssignmentState(p).lastAssignedAt.brickellpay, "2026-05-27T00:00:00Z");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test scripts/test/issue-store.test.js 2>&1 | tail -10`
Expected: failures — `createIssue` etc. not exported.

- [ ] **Step 3: Implement the write side**

Append to `scripts/issue-store.js`:

```js
const DEFAULT_BODY =
  "## Decisions made\n\n## Open questions\n\n## Linked messages\n\n## Log\n";

export function createIssue(issuesDir, fields, { provisional = false, now } = {}) {
  const id = slugify(fields.title);
  const dir = provisional ? join(issuesDir, "provisional") : issuesDir;
  mkdirSync(dir, { recursive: true });
  const issue = {
    id,
    title: fields.title,
    aliases: fields.aliases || [],
    status: "open",
    accounts: fields.accounts || [],
    participants: fields.participants || [],
    opened: now || null,
    last_activity: now || null,
    snooze_until: null,
    next_action: fields.next_action || "",
    waiting_on: fields.waiting_on || "nobody",
    body: fields.body || DEFAULT_BODY,
    _path: join(dir, `${id}.md`),
    _provisional: provisional,
  };
  atomicWrite(issue._path, serializeIssue(issue));
  return issue;
}

export function saveIssue(issue) {
  if (!issue._path) throw new Error(`saveIssue: issue ${issue.id} has no _path`);
  atomicWrite(issue._path, serializeIssue(issue));
  return issue;
}

export function markDone(issue) {
  issue.status = "done";
  return saveIssue(issue);
}

export function snoozeIssue(issue, untilISO) {
  issue.status = "snoozed";
  issue.snooze_until = untilISO;
  return saveIssue(issue);
}

function linkedMsgidLines(body) {
  // Returns the "## Linked messages" bullet lines as an array.
  const m = (body || "").match(/##\s*Linked messages\s*\n([\s\S]*?)(\n##\s|$)/);
  if (!m) return [];
  return m[1].split("\n").map(l => l.trim()).filter(l => l.startsWith("- "));
}

export function mergeIssues(target, source) {
  // Combine aliases.
  target.aliases = [...new Set([...(target.aliases || []), ...(source.aliases || []), source.id])];
  // Combine participants.
  target.participants = [...new Set([...(target.participants || []), ...(source.participants || [])])];
  // Dedupe linked-message lines by their msgid token.
  const seen = new Set();
  const keep = [];
  for (const line of [...linkedMsgidLines(target.body), ...linkedMsgidLines(source.body)]) {
    const id = (line.match(/msgid:\S+/) || [line])[0];
    if (seen.has(id)) continue;
    seen.add(id);
    keep.push(line);
  }
  // Rewrite target's Linked messages section.
  const header = "## Linked messages";
  const rebuilt = `${header}\n${keep.join("\n")}`;
  if (/##\s*Linked messages/.test(target.body)) {
    target.body = target.body.replace(/##\s*Linked messages\s*\n[\s\S]*?(?=\n##\s|$)/, rebuilt + "\n");
  } else {
    target.body = `${target.body}\n\n${rebuilt}\n`;
  }
  saveIssue(target);
  rmSync(source._path, { force: true });
  return target;
}

export function graduateProvisional(issuesDir, slug) {
  const from = join(issuesDir, "provisional", `${slug}.md`);
  if (!existsSync(from)) return null;
  const to = join(issuesDir, `${slug}.md`);
  mkdirSync(issuesDir, { recursive: true });
  renameSync(from, to);
  const issue = parseIssueFile(readFileSync(to, "utf-8"));
  issue._path = to;
  issue._provisional = false;
  return issue;
}

export function loadAssignmentState(path) {
  if (!existsSync(path)) return { lastAssignedAt: {} };
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { lastAssignedAt: {} };
  }
}

export function saveAssignmentState(path, state) {
  atomicWrite(path, JSON.stringify(state, null, 2));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test scripts/test/issue-store.test.js 2>&1 | tail -12`
Expected: all write-side tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test 2>&1 | tail -6`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add scripts/issue-store.js scripts/test/issue-store.test.js
git commit -m "feat(issue-store): write side + assignment state

createIssue (real or provisional), saveIssue, markDone, snoozeIssue,
mergeIssues (alias/participant union + msgid-deduped linked messages),
graduateProvisional (move provisional → top level), loadAssignmentState /
saveAssignmentState. Atomic writes throughout.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: morning-brief.js — `--defer-heuristic-deletes` flag + last-run bundle

**Files:**
- Modify: `scripts/morning-brief.js`
- Test: `scripts/test/morning-brief.test.js`

**Context:** When the flag is set, morning-brief trashes only `explicitDeletions` (not the flat `deletionCandidates`), and writes `data/.last-run-bundle.json` = `{ generatedAt, survivors:[...], heuristicCandidates:[...] }` for the reasoner pass to consume without re-fetching. `survivors` = all emails in non-`ignore` categories. The `classifyFn` used in tests returns the same shape as `classify()` (now including `explicitDeletions`/`heuristicDeletions` from Task 1).

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/morning-brief.test.js` (inside the existing `describe("runMorningBrief — orchestration", ...)` block, reusing its `buildDeps`/`beforeEach`):

```js
  it("with --defer-heuristic-deletes: trashes only explicit deletions", async () => {
    const deps = buildDeps();
    deps.classifyFn = (emails, account) => {
      // e-explicit → explicit delete; e-heur → heuristic delete; e-keep → survivor
      const result = { accountId: account.id, accountName: account.name, accountType: account.accountType,
        categories: { action: { label: "ACTION", emails: [] }, fyi: { label: "FYI", emails: [] }, ignore: { label: "IGNORE", emails: [] } },
        deletionCandidates: [], explicitDeletions: [], heuristicDeletions: [] };
      for (const e of emails) {
        if (e.id === "e-explicit") { result.categories.ignore.emails.push(e); result.deletionCandidates.push(e); result.explicitDeletions.push(e); }
        else if (e.id === "e-heur") { result.categories.ignore.emails.push(e); result.deletionCandidates.push(e); result.heuristicDeletions.push(e); }
        else { result.categories.fyi.emails.push(e); }
      }
      return result;
    };
    deps.fetchFn = async () => ([
      { id: "e-explicit", from: "spam@x.com", fromName: "Spam", subject: "buy", hasListUnsubscribe: true, receivedAt: "2026-05-23T05:00:00Z" },
      { id: "e-heur", from: "news@y.com", fromName: "News", subject: "digest", hasListUnsubscribe: true, receivedAt: "2026-05-23T05:00:00Z" },
      { id: "e-keep", from: "real@z.com", fromName: "Real", subject: "hi", hasListUnsubscribe: false, receivedAt: "2026-05-23T05:00:00Z" },
    ]);
    const result = await runMorningBrief({ flags: { window: "24h", firstRunLive: true, deferHeuristicDeletes: true }, deps });
    // Only e-explicit was trashed
    assert.deepEqual(deleted.map(d => d.id), ["e-explicit"]);
    assert.equal(result.bundle.heuristicCandidates.length, 1);
    assert.equal(result.bundle.heuristicCandidates[0].id, "e-heur");
    assert.ok(result.bundle.survivors.find(e => e.id === "e-keep"), "survivor in bundle");
  });

  it("with --defer-heuristic-deletes: writes data/.last-run-bundle.json", async () => {
    const deps = buildDeps();
    deps.paths.lastRunBundlePath = join(dataDir, ".last-run-bundle.json");
    const result = await runMorningBrief({ flags: { window: "24h", firstRunLive: true, deferHeuristicDeletes: true }, deps });
    assert.ok(existsSync(join(dataDir, ".last-run-bundle.json")));
    const bundle = JSON.parse(readFileSync(join(dataDir, ".last-run-bundle.json"), "utf-8"));
    assert.ok(Array.isArray(bundle.survivors));
    assert.ok(Array.isArray(bundle.heuristicCandidates));
    assert.equal(bundle.generatedAt, result.timestamp);
  });

  it("without the flag: trashes all deletionCandidates as before", async () => {
    const deps = buildDeps(); // default classifyFn marks LinkedIn as deletionCandidate
    const result = await runMorningBrief({ flags: { window: "24h", firstRunLive: true }, deps });
    assert.ok(deleted.length >= 1, "deletes happen as before");
    assert.equal(result.bundle, undefined, "no bundle when flag off");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test scripts/test/morning-brief.test.js 2>&1 | grep -A3 "defer-heuristic"`
Expected: failures — `deferHeuristicDeletes` not handled; `result.bundle` undefined.

- [ ] **Step 3: Implement the flag in `runMorningBrief`**

In `scripts/morning-brief.js`, find where `autoDeleteIds` is computed inside the per-account loop:

```js
    const autoDeleteIds = result.deletionCandidates.map(e => e.id);
```

Replace with:

```js
    // With --defer-heuristic-deletes, only trash explicit (deliberate) deletions;
    // heuristic guesses are handed to the reasoner instead.
    const deferHeuristic = !!flags.deferHeuristicDeletes;
    const toDelete = deferHeuristic
      ? (result.explicitDeletions || [])
      : result.deletionCandidates;
    const autoDeleteIds = toDelete.map(e => e.id);
```

Then, where the per-account `recordDeletion`/`recentDeletionsForScam` loop iterates `result.deletionCandidates`, change it to iterate `toDelete` (so sender-history only counts what was actually trashed):

Find:
```js
        for (const e of result.deletionCandidates) {
          recordDeletion(history, account.id, e.from || "", {
```
Replace `result.deletionCandidates` with `toDelete`.

Next, accumulate the bundle. Near the top of `runMorningBrief` where other accumulators are declared (e.g. `const warnings = [...firstRunWarnings];`), add:

```js
  const bundleSurvivors = [];
  const bundleHeuristicCandidates = [];
```

Inside the per-account loop, after classification, collect survivors (non-ignore category emails) and heuristic candidates:

```js
    if (deferHeuristic) {
      for (const [catId, bucket] of Object.entries(result.categories)) {
        if (catId === "ignore") continue;
        for (const e of bucket.emails) bundleSurvivors.push({ ...e, _account: account.id });
      }
      for (const e of (result.heuristicDeletions || [])) {
        bundleHeuristicCandidates.push({ ...e, _account: account.id });
      }
    }
```

Finally, after the loop and the existing state-write block (and gated the same way — not in dry-run), assemble and write the bundle. Find the return statement:

```js
  return {
    timestamp: now,
    window,
```

Immediately before it, add:

```js
  let bundle;
  if (deferHeuristic) {
    bundle = { generatedAt: now, survivors: bundleSurvivors, heuristicCandidates: bundleHeuristicCandidates };
    if (!effectiveDryRun && paths.lastRunBundlePath) {
      atomicWrite(paths.lastRunBundlePath, JSON.stringify(bundle, null, 2));
    }
  }
```

And add `bundle` to the returned object:

```js
  return {
    timestamp: now,
    window,
    dryRun: effectiveDryRun,
    requestedDryRun: dryRun,
    forcedFirstRunDryRun: effectiveDryRun && !dryRun,
    draftOnly,
    bundle,
    summary,
```

(Insert the `bundle,` line; leave the rest of the returned object unchanged.)

- [ ] **Step 4: Wire the CLI flag + path**

In the CLI arg-parsing block at the bottom of `scripts/morning-brief.js`, find:

```js
    else if (args[i] === "--first-run-live") flags.firstRunLive = true;
```

Add after it:

```js
    else if (args[i] === "--defer-heuristic-deletes") flags.deferHeuristicDeletes = true;
```

In the CLI `paths:` object, add:

```js
        lastRunBundlePath: join(root, "data/.last-run-bundle.json"),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test scripts/test/morning-brief.test.js 2>&1 | tail -10`
Expected: all morning-brief tests pass (existing + 3 new).

- [ ] **Step 6: Run the full suite**

Run: `npm test 2>&1 | tail -6`
Expected: no regressions.

- [ ] **Step 7: Commit**

```bash
git add scripts/morning-brief.js scripts/test/morning-brief.test.js
git commit -m "feat(morning-brief): --defer-heuristic-deletes flag + last-run bundle

When set, morning-brief trashes only explicit (alwaysDelete/scamPattern)
deletions and hands heuristic guesses to the reasoner via a written
data/.last-run-bundle.json ({survivors, heuristicCandidates}). Sender-history
counts only what was actually trashed. Default behavior unchanged when the
flag is absent.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: pattern-discovery.js — discoverAutoTrash skips already-in-alwaysDelete senders

**Files:**
- Modify: `scripts/pattern-discovery.js` (the `senderIsProtected` helper and/or `discoverAutoTrash`)
- Test: `scripts/test/pattern-discovery.test.js`

**Context:** Bug from the 2026-05-23 live run — `discoverAutoTrash` re-proposed `theathletic@e1.theathletic.com` (p-007) even though it was already approved into `personal.alwaysDelete` as p-001. The fix: treat a sender already present in the account's `alwaysDelete` as "already handled" and skip proposing it.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/pattern-discovery.test.js`:

```js
describe("discoverAutoTrash — skips senders already in alwaysDelete", () => {
  it("does not re-propose an email-typed alwaysDelete sender", () => {
    const history = { "personal:theathletic@e1.theathletic.com": { deletedCount: 9, hasListUnsubscribe: true, lastDeletedAt: "..." } };
    const accounts = [{
      id: "personal", neverDelete: [], prioritySenders: [],
      alwaysDelete: [{ type: "email", value: "theathletic@e1.theathletic.com", label: "the athletic" }],
    }];
    const proposals = discoverAutoTrash(history, accounts, [], { now: "2026-05-24T00:00:00Z" });
    assert.equal(proposals.length, 0);
  });
  it("does not re-propose when a domain-typed alwaysDelete rule covers the sender", () => {
    const history = { "personal:promos@bigbox.com": { deletedCount: 7, hasListUnsubscribe: true, lastDeletedAt: "..." } };
    const accounts = [{
      id: "personal", neverDelete: [], prioritySenders: [],
      alwaysDelete: [{ type: "domain", value: "bigbox.com", label: "bigbox" }],
    }];
    const proposals = discoverAutoTrash(history, accounts, [], { now: "2026-05-24T00:00:00Z" });
    assert.equal(proposals.length, 0);
  });
  it("still proposes a sender not covered by alwaysDelete", () => {
    const history = { "personal:new@sender.com": { deletedCount: 6, hasListUnsubscribe: true, lastDeletedAt: "..." } };
    const accounts = [{ id: "personal", neverDelete: [], prioritySenders: [], alwaysDelete: [{ type: "email", value: "other@x.com" }] }];
    const proposals = discoverAutoTrash(history, accounts, [], { now: "2026-05-24T00:00:00Z" });
    assert.equal(proposals.length, 1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test scripts/test/pattern-discovery.test.js 2>&1 | grep -A3 "already in alwaysDelete"`
Expected: the first two tests fail (proposals still emitted).

- [ ] **Step 3: Implement the skip**

In `scripts/pattern-discovery.js`, find `senderIsProtected`:

```js
function senderIsProtected(account, senderEmail) {
  const domain = (senderEmail.split("@")[1] || "").toLowerCase();
  const lists = [...(account.neverDelete || []), ...(account.prioritySenders || [])];
  for (const rule of lists) {
    if (rule.type === "email" && rule.value.toLowerCase() === senderEmail.toLowerCase()) return true;
    if (rule.type === "domain" && rule.value.toLowerCase() === domain) return true;
  }
  return false;
}
```

Add a sibling helper immediately after it:

```js
function alreadyAutoTrashed(account, senderEmail) {
  const domain = (senderEmail.split("@")[1] || "").toLowerCase();
  for (const rule of (account.alwaysDelete || [])) {
    if (rule.type === "email" && rule.value.toLowerCase() === senderEmail.toLowerCase()) return true;
    if (rule.type === "domain" && rule.value.toLowerCase() === domain) return true;
  }
  return false;
}
```

Then in `discoverAutoTrash`, find:

```js
    if (senderIsProtected(account, senderEmail)) continue;
```

Add immediately after it:

```js
    if (alreadyAutoTrashed(account, senderEmail)) continue;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test scripts/test/pattern-discovery.test.js 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test 2>&1 | tail -6`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add scripts/pattern-discovery.js scripts/test/pattern-discovery.test.js
git commit -m "fix(pattern-discovery): don't re-propose senders already in alwaysDelete

discoverAutoTrash now skips any sender already covered by an email- or
domain-typed alwaysDelete rule. Fixes the 2026-05-23 duplicate (p-007
re-proposed theathletic after p-001 was approved).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: issue-apply.js — deterministic applier + SEAA golden test

**Files:**
- Create: `scripts/issue-apply.js`
- Create: `scripts/test/fixtures/issues.js`
- Test: `scripts/test/issue-apply.test.js`

**Context:** The applier takes the reasoner's output records + the email bundle and produces issue-store mutations + a soft-delete list. It groups records by target issue (existing id, or `NEW:Title` → slug) so multiple emails assigned to the same new topic become ONE issue. A new issue with ≥2 linked messages is real; a new issue with exactly 1 message and no `next_action_update` is provisional. The applier returns `toTrash` (msgids) but does NOT delete — the skill calls the soft-delete connectors.

Record shape (from the reasoner): `{ msgid, verdict: "keep"|"trash", issue: "<id>"|"NEW:Title"|null, reason, next_action_update, waiting_on_update }`.

- [ ] **Step 1: Write the fixtures**

Create `scripts/test/fixtures/issues.js`:

```js
// Minimal email objects keyed by msgid, as the applier receives them.
export const sampleEmailsById = {
  "m-neal": { id: "m-neal", from: "neal.zeleznak@nmi.com", fromName: "Neal Zeleznak", subject: "BrickellPay and NMI at SEAA", account: "brickellpay", received: "2026-05-26T19:56:58Z" },
  "m-brad": { id: "m-brad", from: "bstaudt@north.com", fromName: "Brad Staudt", subject: "Partnership Programs, Made For You", account: "brickellpay", received: "2026-05-27T14:07:27Z" },
  "m-promo1": { id: "m-promo1", from: "news@valorpaytech.com", fromName: "Valor PayTech", subject: "Stop by Booth 107 at SEAA 2026", account: "brickellpay", received: "2026-05-26T13:44:45Z" },
  "m-promo2": { id: "m-promo2", from: "sales@dccsupply.com", fromName: "DCCSupply", subject: "Refurbished Devices Backed by Quality & Care", account: "brickellpay", received: "2026-05-27T11:00:27Z" },
  "m-oneoff": { id: "m-oneoff", from: "someone@new.com", fromName: "Someone", subject: "Quick intro", account: "brickellpay", received: "2026-05-27T10:00:00Z" },
};

// Expected reasoner verdicts for the SEAA golden case.
export const seaaReasonerOutput = [
  { msgid: "m-neal", verdict: "keep", issue: "NEW:SEAA Partner Meetings", reason: "Personalized; NMI is a priority sender", next_action_update: "Reply to Neal (NMI) re: meeting at show", waiting_on_update: "you" },
  { msgid: "m-brad", verdict: "keep", issue: "NEW:SEAA Partner Meetings", reason: "Personalized; North is a priority sender", next_action_update: "Reply to Brad (North) re: partner program", waiting_on_update: "you" },
  { msgid: "m-promo1", verdict: "trash", issue: null, reason: "Broadcast booth promo, has unsubscribe" },
  { msgid: "m-promo2", verdict: "trash", issue: null, reason: "Broadcast booth promo" },
  { msgid: "m-oneoff", verdict: "keep", issue: "NEW:Quick Intro From Someone", reason: "Survivor, no existing issue", next_action_update: "", waiting_on_update: "you" },
];
```

- [ ] **Step 2: Write the failing test**

Create `scripts/test/issue-apply.test.js`:

```js
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyReasonerOutput } from "../issue-apply.js";
import { loadIssues, loadProvisional, createIssue } from "../issue-store.js";
import { sampleEmailsById, seaaReasonerOutput } from "./fixtures/issues.js";

let tmpDir, issuesDir;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "issue-apply-test-"));
  issuesDir = join(tmpDir, "issues");
  mkdirSync(join(issuesDir, "provisional"), { recursive: true });
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("applyReasonerOutput — SEAA golden case", () => {
  it("creates one real SEAA issue with Neal+Brad and trashes the promos", () => {
    const out = applyReasonerOutput(seaaReasonerOutput, sampleEmailsById, { issuesDir, now: "2026-05-27" });
    // Neal+Brad → one real issue (2 messages)
    const real = loadIssues(issuesDir);
    const seaa = real.find(i => i.id === "seaa-partner-meetings");
    assert.ok(seaa, "SEAA Partner Meetings issue created at top level");
    const msgids = seaa.body.match(/msgid:m-\w+/g) || [];
    assert.ok(msgids.includes("msgid:m-neal") && msgids.includes("msgid:m-brad"));
    // promos trashed
    assert.deepEqual(out.toTrash.sort(), ["m-promo1", "m-promo2"]);
    // the one-off → provisional (single message, no next_action)
    const prov = loadProvisional(issuesDir);
    assert.ok(prov.find(i => i.id === "quick-intro-from-someone"), "one-off quarantined as provisional");
  });
});

describe("applyReasonerOutput — assignment to existing issue", () => {
  it("appends a message to an existing issue and updates next_action/waiting_on", () => {
    createIssue(issuesDir, { title: "Path Peptides", aliases: ["pp"], accounts: ["brickellpay"] }, { now: "2026-05-20" });
    const records = [{ msgid: "m-neal", verdict: "keep", issue: "path-peptides", reason: "thread continuation", next_action_update: "Wait on Jared", waiting_on_update: "jared" }];
    const emails = { "m-neal": sampleEmailsById["m-neal"] };
    const out = applyReasonerOutput(records, emails, { issuesDir, now: "2026-05-27" });
    const pp = loadIssues(issuesDir).find(i => i.id === "path-peptides");
    assert.match(pp.body, /msgid:m-neal/);
    assert.equal(pp.next_action, "Wait on Jared");
    assert.equal(pp.waiting_on, "jared");
    assert.equal(out.updated.includes("path-peptides"), true);
  });
});

describe("applyReasonerOutput — keep/null is left untouched", () => {
  it("does not create an issue or trash for issue:null keep", () => {
    const records = [{ msgid: "m-neal", verdict: "keep", issue: null, reason: "FYI" }];
    const out = applyReasonerOutput(records, { "m-neal": sampleEmailsById["m-neal"] }, { issuesDir, now: "2026-05-27" });
    assert.equal(out.toTrash.length, 0);
    assert.equal(out.created.length, 0);
    assert.equal(loadIssues(issuesDir).length, 0);
    assert.equal(out.noIssue.includes("m-neal"), true);
  });
});

describe("applyReasonerOutput — single-message new issue is provisional", () => {
  it("quarantines a lone new issue", () => {
    const records = [{ msgid: "m-oneoff", verdict: "keep", issue: "NEW:Lonely Topic", reason: "x", next_action_update: "", waiting_on_update: "you" }];
    const out = applyReasonerOutput(records, { "m-oneoff": sampleEmailsById["m-oneoff"] }, { issuesDir, now: "2026-05-27" });
    assert.equal(loadIssues(issuesDir).length, 0);
    assert.equal(loadProvisional(issuesDir).length, 1);
    assert.equal(out.quarantined.includes("lonely-topic"), true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test scripts/test/issue-apply.test.js 2>&1 | tail -10`
Expected: cannot find module `../issue-apply.js`.

- [ ] **Step 4: Implement `scripts/issue-apply.js`**

Create `scripts/issue-apply.js`:

```js
/**
 * issue-apply.js
 *
 * Deterministic applier: turns reasoner-output records + the email bundle into
 * issue-store mutations and a soft-delete list. No LLM, no network. The skill
 * performs the actual soft-deletes on the returned toTrash msgids.
 *
 * Record: { msgid, verdict: "keep"|"trash", issue: "<id>"|"NEW:Title"|null,
 *           reason, next_action_update, waiting_on_update }
 */

import {
  slugify, loadIssues, loadProvisional, findByAlias, createIssue, saveIssue,
} from "./issue-store.js";

function shortDate(iso) {
  // "2026-05-27T..." → "5/27" for the linked-message log line.
  const m = (iso || "").match(/^\d{4}-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${Number(m[1])}/${Number(m[2])}`;
}

function appendLinkedMessage(issue, email) {
  const line = `- msgid:${email.id} — ${email.fromName || email.from} ${shortDate(email.received)} — ${email.subject || ""}`.trim();
  if (issue.body.includes(`msgid:${email.id}`)) return; // idempotent
  if (/##\s*Linked messages/.test(issue.body)) {
    issue.body = issue.body.replace(/(##\s*Linked messages\s*\n)/, `$1${line}\n`);
  } else {
    issue.body = `${issue.body}\n\n## Linked messages\n${line}\n`;
  }
}

function countLinked(issue) {
  return (issue.body.match(/msgid:\S+/g) || []).length;
}

export function applyReasonerOutput(records, emailsById, { issuesDir, now }) {
  const report = { created: [], updated: [], quarantined: [], rescued: [], toTrash: [], noIssue: [] };

  // Index existing issues (real + provisional) so we can append to them.
  const realIssues = loadIssues(issuesDir);
  const provIssues = loadProvisional(issuesDir);
  const byId = new Map([...realIssues, ...provIssues].map(i => [i.id, i]));

  // First pass: group "NEW:" targets by slug so multiple emails → one issue.
  const newGroups = new Map(); // slug → { title, records: [] }
  for (const rec of records) {
    if (rec.verdict === "trash") continue;
    if (typeof rec.issue === "string" && rec.issue.startsWith("NEW:")) {
      const title = rec.issue.slice(4).trim();
      const slug = slugify(title);
      if (!newGroups.has(slug)) newGroups.set(slug, { title, recs: [] });
      newGroups.get(slug).recs.push(rec);
    }
  }

  // Apply trash + existing-issue assignments + null-keeps.
  for (const rec of records) {
    const email = emailsById[rec.msgid];
    if (rec.verdict === "trash") {
      report.toTrash.push(rec.msgid);
      continue;
    }
    // keep
    if (rec.issue == null) { report.noIssue.push(rec.msgid); continue; }
    if (rec.issue.startsWith("NEW:")) continue; // handled below
    // existing issue id (or alias)
    const issue = byId.get(rec.issue) || findByAlias([...byId.values()], rec.issue);
    if (!issue) { report.noIssue.push(rec.msgid); continue; }
    if (email) appendLinkedMessage(issue, email);
    if (rec.next_action_update) issue.next_action = rec.next_action_update;
    if (rec.waiting_on_update) issue.waiting_on = rec.waiting_on_update;
    issue.last_activity = now;
    saveIssue(issue);
    if (!report.updated.includes(issue.id)) report.updated.push(issue.id);
  }

  // Create the grouped NEW issues.
  for (const [slug, group] of newGroups) {
    const emails = group.recs.map(r => emailsById[r.msgid]).filter(Boolean);
    const participants = [...new Set(emails.map(e => `${e.fromName || e.from} <${e.from}>`))];
    const accounts = [...new Set(emails.map(e => e.account).filter(Boolean))];
    const firstWithAction = group.recs.find(r => r.next_action_update);
    const provisional = emails.length < 2 && !firstWithAction;
    const issue = createIssue(issuesDir, {
      title: group.title,
      aliases: [slug.split("-")[0]].filter(a => a && a !== slug),
      accounts,
      participants,
      next_action: firstWithAction ? firstWithAction.next_action_update : "",
      waiting_on: (group.recs.find(r => r.waiting_on_update) || {}).waiting_on_update || "you",
    }, { provisional, now });
    for (const e of emails) appendLinkedMessage(issue, e);
    saveIssue(issue);
    if (provisional) report.quarantined.push(issue.id);
    else report.created.push(issue.id);
  }

  return report;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test scripts/test/issue-apply.test.js 2>&1 | tail -12`
Expected: all 4 describes pass, including the SEAA golden case.

- [ ] **Step 6: Run the full suite**

Run: `npm test 2>&1 | tail -6`
Expected: no regressions.

- [ ] **Step 7: Commit**

```bash
git add scripts/issue-apply.js scripts/test/issue-apply.test.js scripts/test/fixtures/issues.js
git commit -m "feat(issue-apply): deterministic reasoner-output applier + SEAA golden test

applyReasonerOutput groups NEW: targets by slug (multiple emails → one issue),
creates real vs provisional issues (>=2 messages or a decision = real),
appends idempotent linked-message lines, updates next_action/waiting_on,
and returns a toTrash list (the skill performs the soft-deletes). The SEAA
golden fixture pins the canonical case: 2 partner asks → one real issue,
16-style promos → trash.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: shared reasoner-pass prompt fragment

**Files:**
- Create: `.claude/commands/issues/_reasoner-pass.md`

This is a prompt fragment (not code). No unit test; verified by Task 8's smoke test and the golden test in Task 6 (which pins the *applier* given this fragment's expected output shape).

- [ ] **Step 1: Create the fragment**

Create `.claude/commands/issues/_reasoner-pass.md`:

```markdown
# Reasoner Pass (shared fragment)

> Included by `/issues` and the morning-brief skill. Not invoked as a function —
> the running model performs these steps directly.

## Inputs you will have assembled

- **Bundle**: a list of emails, each tagged `survivor` or `heuristic-delete-candidate`.
  Each email has: msgid, account, sender (name + address), subject, preview/body,
  received date, has-list-unsubscribe, and (for candidates) why the heuristic flagged it.
- **Issue index**: the current open issues — for each: `id`, `title`, `aliases`,
  one-line `next_action`, `participants`.
- **Attention profile**: `config/attention-profile.md` (who matters, what's noise).

## What to decide, per email

Reason about the *content*, not just the sender. Produce one record per email:

```json
{
  "msgid": "<id>",
  "verdict": "keep | trash",
  "issue": "<existing-issue-id> | NEW:Concise Topic Title | null",
  "reason": "<one short clause>",
  "next_action_update": "<new next_action for the issue, or empty string>",
  "waiting_on_update": "you | <participant first name> | nobody | null"
}
```

Rules:
- **heuristic-delete-candidate**: decide `verdict`. `trash` if it really is noise
  (broadcast marketing, booth promos, unsubscribe-footer blasts with no personal ask).
  `keep` (rescue) if the heuristic misfired — a real person with a specific ask, a
  transactional notice that matters, anything a priority sender sent. A rescued email
  is then assigned like a survivor.
- **survivor**: `verdict` is always `keep`. Assign `issue`:
  - An existing issue id if it continues that topic.
  - `NEW:Title` if it starts a new topic. Use the SAME title for emails that belong
    together (e.g. two partner meeting requests for the same conference → one
    `NEW:SEAA Partner Meetings`).
  - `null` if it's a genuine keep but not issue-worthy (pure FYI, no thread of work).
- **Personalization test** (the core judgment): "I saw your name on the attendee
  list, want to connect?" from a known/priority contact → keep + issue. "Visit Booth
  107" broadcast → trash or null. An auto-inserted "Hi <FirstName>" on an otherwise
  templated blast is NOT personalization.
- Set `next_action_update` only when this email changes what needs to happen. Set
  `waiting_on_update` to `you` if the ball is in your court, a participant's name if
  you're waiting on them, `nobody` if nothing is pending, or `null` to leave unchanged.

## Output

Emit the records as a JSON array. The deterministic applier (`scripts/issue-apply.js`)
consumes this array; you do not mutate issue files yourself. After the applier runs,
the skill soft-deletes the returned `toTrash` msgids via the existing delete connectors
(`delete-emails.js` / `delete-gmail-emails.js`) — **soft-delete only, never permanent**.
```

- [ ] **Step 2: Verify it reads cleanly**

Run: `head -5 .claude/commands/issues/_reasoner-pass.md`
Expected: the fragment header is present.

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/issues/_reasoner-pass.md
git commit -m "feat(issues): shared reasoner-pass prompt fragment

The LLM judgment instructions for per-email verdict + issue assignment.
Included by both /issues and the morning-brief skill. Emits the record
array consumed by scripts/issue-apply.js.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: the /issues skill

**Files:**
- Create: `.claude/commands/issues/issues.md`

Prompt file. No unit test; manual smoke in Task 10.

- [ ] **Step 1: Create the skill**

Create `.claude/commands/issues/issues.md`:

```markdown
---
description: Converse with your inbox as topic-based issues — status, drill-in, draft, and lifecycle verbs
allowed-tools: Bash, Read, Write, Edit
---

# Issues

Topic-based issue tracker over your accounts. Email feeds into issues; you converse
with issues. Terse by default — 1-3 lines unless asked for `more`.

## Input — `$ARGUMENTS`

- (empty) → **status view** of open issues.
- `more` → status view with provisional + snoozed expanded.
- `<alias>` or `<alias>?` → **drill-in** on one issue (3 lines).
- `<alias> more` → full drill-in (log + linked messages).
- `draft <alias>` → compose a context-aware reply, save to Drafts-OfficeOS.
- `done <alias>` / `snooze <alias> <when>` / `merge <a> <b>` / `ignore <prov-slug>` /
  `graduate <prov-slug>` → lifecycle verbs.
- `refresh` → force a fresh reasoner pass (fetch delta, assign) before answering.

## Load

```
cat config/companies.json
cat config/account-types.json
cat config/attention-profile.md
cat config/prefs.json
```

Issue files live in `data/issues/*.md` (real) and `data/issues/provisional/*.md`.
Use `scripts/issue-store.js` helpers for all reads/writes (never hand-edit issue files
from the prompt). Assignment state: `data/issue-assignment-state.json`.

## Cold-start (bootstrap)

If `data/issues/` has no `*.md` files (real or provisional), this is the first run:
1. Fetch 14–30 days across all accounts (`fetch-emails.js` / `fetch-gmail.js`).
2. Classify with `classify-emails.js` to drop explicit-rule noise (cheap pre-filter).
3. Run the reasoner pass over survivors **only** (see `_reasoner-pass.md`). **Do NOT
   trash anything on the bootstrap pass** — pass an empty `toTrash` through; this run
   is read-and-organize only.
4. Apply via `scripts/issue-apply.js`; everything new lands provisional.
5. Show the provisional list and tell the user to `graduate` / `merge` / `ignore`.
6. Write `data/issue-assignment-state.json`.

## Normal run (assignment)

Two entry paths (cadence C):
- **Piggyback**: if a fresh `data/.last-run-bundle.json` exists (generatedAt within the
  last ~15 min), use its `survivors` + `heuristicCandidates` — no re-fetch.
- **On-demand / refresh**: read `issue-assignment-state.json`, fetch each account's
  delta since `lastAssignedAt`, classify, build the bundle yourself.

Then:
1. Build the issue index from `loadIssues` (open only).
2. Run the reasoner pass (`_reasoner-pass.md`) over the bundle.
3. Apply via `scripts/issue-apply.js` → `{created, updated, quarantined, rescued, toTrash, noIssue}`.
4. Soft-delete `toTrash` via `delete-emails.js` / `delete-gmail-emails.js`
   (**soft-delete only**). Gmail deletes pass the accountId first (verified).
5. Update `data/issue-assignment-state.json` (`lastAssignedAt[account] = now`).

## Status view (default)

Sort `waiting_on == "you"` first, then others. Collapse provisional + snoozed to counts.

```
Open (N):
  <alias>  <title> — <YOU: <next_action> | waiting on <who> (<next_action>)>
  ...
Provisional (P) · Snoozed (S) · `/issues more` for detail
```

## Drill-in (`<alias>` / `<alias>?`)

Resolve alias via `findByAlias`. If ambiguous, show a one-line numbered shortlist and stop.

```
<title> · <accounts> · since <opened>
Next: <next_action> (<waiting_on>)
Last: <most recent linked-message one-liner>
Open Q: <first open question, if any>
```

`<alias> more` → append the full `## Log` and `## Linked messages` sections.

## Verbs

- **draft `<alias>`**: load the issue + the account `voiceProfile` from companies.json.
  Compose a ≤3-sentence reply that uses the issue's accumulated context (participants,
  next_action, open questions) and the voice profile (openingStyle, signOff, formality).
  Save to Drafts-OfficeOS:
  - Outlook: `echo '{"to":[...],"subject":"Re: ...","body":"...","replyToMessageId":"<msgid>"}' | node scripts/save-draft.js <account>`
  - Gmail: `echo '{"to":[...],"subject":"Re: ...","body":"...","threadId":"<threadId>"}' | node scripts/save-gmail-draft.js <account>`
  Show a 1-line preview. **Never send.** Update `data/drafts-index.json` with the new draftId.
- **done `<alias>`**: `markDone` (via issue-store).
- **snooze `<alias>` `<when>`**: resolve `<when>` (`3d`, `friday`, ISO) to a date; `snoozeIssue`.
- **merge `<a>` `<b>`**: `mergeIssues(target=a, source=b)`.
- **ignore `<prov-slug>`**: delete the provisional file (`rm data/issues/provisional/<slug>.md`).
- **graduate `<prov-slug>`**: `graduateProvisional`.

## Safety (inherited, non-negotiable)

- **Never send email.** Drafts only.
- **Soft-delete only.** No permanent deletion path. Bootstrap never trashes.
- **Never hand-edit issue files** from the prompt — go through `issue-store.js`.
- Issue-file writes are atomic (issue-store uses `fs-utils.atomicWrite`).
```

- [ ] **Step 2: Verify frontmatter + structure**

Run: `head -6 .claude/commands/issues/issues.md`
Expected: YAML frontmatter with `description` and `allowed-tools`.

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/issues/issues.md
git commit -m "feat(issues): the /issues skill

Bootstrap (read-only cold start), normal assignment (piggyback bundle or
on-demand delta), terse status view, drill-in, and lifecycle verbs (draft,
done, snooze, merge, ignore, graduate). Reasoning via the shared
_reasoner-pass fragment; all mutations via issue-store.js / issue-apply.js.
Inherits soft-delete-only + never-send.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: morning-brief skill piggyback

**Files:**
- Modify: `.claude/commands/reports/morning-brief.md`

- [ ] **Step 1: Add the piggyback step**

Open `.claude/commands/reports/morning-brief.md`. In Step 2 (running the orchestrator), change the orchestrator invocation so the integrated path passes the flag. Find the bash invocation:

```bash
node scripts/morning-brief.js $ARGUMENTS
```

Add a note immediately above it:

```
If the issue tracker is in use (data/issues/ exists), append --defer-heuristic-deletes
so heuristic guesses are handed to the reasoner instead of trashed outright:

    node scripts/morning-brief.js $ARGUMENTS --defer-heuristic-deletes
```

Then add a new step after Step 5 (the echo summary):

```markdown
### 6. Piggyback issue assignment

If `data/issues/` exists (issue tracker in use) and this was NOT a dry-run:

1. A fresh `data/.last-run-bundle.json` was just written by the orchestrator.
2. Perform the reasoner pass per `.claude/commands/issues/_reasoner-pass.md` using that
   bundle's `survivors` + `heuristicCandidates` (no re-fetch).
3. Apply via `scripts/issue-apply.js`; soft-delete the returned `toTrash` msgids
   (**soft-delete only**).
4. Update `data/issue-assignment-state.json`.
5. Add one line to the brief summary: "Issues: N open, M new, K heuristic deletes rescued."

This keeps the issue graph current as a side effect of the morning brief. Standalone
`/issues` remains available for mid-day refresh.
```

- [ ] **Step 2: Verify the edit**

Run: `grep -n "defer-heuristic-deletes\|Piggyback issue" .claude/commands/reports/morning-brief.md`
Expected: both strings present.

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/reports/morning-brief.md
git commit -m "feat(morning-brief skill): piggyback issue assignment

When the issue tracker is in use, morning-brief runs with
--defer-heuristic-deletes and performs the reasoner pass over the written
bundle at end of run, keeping the issue graph current with no extra fetch.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: manual smoke test (no commit)

After Tasks 1-9, verify end-to-end on real data with zero risk.

- [ ] **Step 1: Full suite green**

Run: `npm test 2>&1 | tail -6`
Expected: all tests pass.

- [ ] **Step 2: Bootstrap dry cold-start**

Confirm `data/issues/` does not yet exist, then invoke `/issues`. Expected: it runs the
bootstrap, proposes provisional issues from 14-30d of mail, trashes nothing, and shows
a provisional list. Verify `data/issues/provisional/*.md` files exist and `data/issues/`
has no top-level `*.md` yet.

- [ ] **Step 3: Sweep**

`graduate` a couple of real ones, `ignore` the junk, `merge` any dupes. Confirm files
move from `provisional/` to top-level.

- [ ] **Step 4: Drill-in + draft**

`/issues pp` (or whatever graduated) → 3-line status. `/issues draft <alias>` → confirm a
draft lands in the account's Drafts-OfficeOS folder (NOT sent), and `data/drafts-index.json`
gets the entry.

- [ ] **Step 5: Integrated run**

Run `/morning-brief --window 24h` (with `data/issues/` now present). Confirm: heuristic
deletes were handed to the reasoner (check the brief's "Issues:" line), explicit
alwaysDelete still trashed, issue files updated, `data/issue-assignment-state.json` advanced.

---

## Self-review

**Spec coverage:**
- Reasoning layer + issue graph → Tasks 2,3,6,7,8 ✓
- Topic-based issues → issue-store data model (Task 2/3) + applier grouping (Task 6) ✓
- Scope 2 (foundation + drafting, morning-brief coexists) → Tasks 8 (draft verb), 9 (coexist via flag) ✓
- Cadence C (piggyback + on-demand) → Task 4 (bundle), Task 8 (both paths), Task 9 (piggyback) ✓
- New-issue birth B (auto-create, quarantine singletons) → Task 6 applier (provisional when <2 msgs & no decision) ✓
- Reasoner/deletion boundary B → Task 1 (explicit/heuristic tag) + Task 4 (defer flag) + Task 7 (rescue rule) ✓
- Issue data model (frontmatter fields) → Task 2/3 ✓
- Reasoner pass schema → Task 7 + Task 6 record shape ✓
- Commands & verbs → Task 8 ✓
- Bootstrap (read-only) → Task 8 cold-start + Task 10 smoke ✓
- Testing (issue-store full, applier vs fixtures, SEAA golden, defer-flag) → Tasks 2,3,4,6 ✓
- Opportunistic discoverAutoTrash fix → Task 5 ✓
- Soft-delete-only / never-send inheritance → Tasks 7,8,9 prompt rails ✓

**Placeholder scan:** none — all code blocks complete, all paths exact.

**Type/name consistency:**
- `applyReasonerOutput(records, emailsById, { issuesDir, now })` → returns `{created, updated, quarantined, rescued, toTrash, noIssue}` — consistent Task 6 ↔ Task 8 ↔ Task 9.
- issue-store exports used by applier: `slugify, loadIssues, loadProvisional, findByAlias, createIssue, saveIssue` — all defined in Tasks 2/3.
- `result.explicitDeletions` / `result.heuristicDeletions` — defined Task 1, consumed Task 4.
- `data/.last-run-bundle.json` shape `{generatedAt, survivors, heuristicCandidates}` — written Task 4, read Task 8/9.
- Record shape `{msgid, verdict, issue, reason, next_action_update, waiting_on_update}` — Task 7 (produced) ↔ Task 6 (consumed) ✓.

---

## After all tasks complete

Hand off to `superpowers:finishing-a-development-branch`.
