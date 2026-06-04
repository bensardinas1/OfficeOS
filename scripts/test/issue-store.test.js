import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  slugify, parseIssueFile, serializeIssue,
  loadIssues, loadProvisional, findByAlias, listByStatus,
  createIssue, saveIssue, markDone, snoozeIssue, mergeIssues, graduateProvisional,
  loadAssignmentState, saveAssignmentState,
} from "../issue-store.js";
import { existsSync, readFileSync } from "node:fs";

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
  it("parses frontmatter even with CRLF line endings", () => {
    const crlf = "---\r\nid: pp\r\ntitle: PP\r\nstatus: open\r\n---\r\nbody text";
    const parsed = parseIssueFile(crlf);
    assert.equal(parsed.id, "pp");
    assert.equal(parsed.status, "open");
    assert.equal(parsed.body, "body text");
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
    const msgids = (merged.body.match(/msgid:\S+/g) || []);
    assert.equal(new Set(msgids).size, msgids.length, "no duplicate msgids");
    assert.ok(msgids.includes("msgid:c"));
    assert.equal(existsSync(source._path), false, "source file removed");
  });
});

describe("mergeIssues — full DEFAULT_BODY with blank-line-separated sections", () => {
  it("merges linked messages without eating the next section", () => {
    const target = createIssue(issuesDir, { title: "Alpha", aliases: ["al"] }, { now: "2026-05-27" });
    // Simulate a real issue body: messages already under Linked messages, Log section after a blank line.
    target.body = "## Decisions made\n\n## Open questions\n\n## Linked messages\n- msgid:AAMk111 — Neal 5/26 — hi\n\n## Log\n- 5/26 note";
    saveIssue(target);
    const source = createIssue(issuesDir, { title: "Beta", aliases: ["be"] }, { now: "2026-05-27" });
    source.body = "## Linked messages\n- msgid:AAMk222 — Brad 5/27 — yo";
    saveIssue(source);

    const merged = mergeIssues(target, source);
    assert.match(merged.body, /msgid:AAMk111/);
    assert.match(merged.body, /msgid:AAMk222/);
    assert.match(merged.body, /## Log/, "Log section preserved");
    // The two long msgids are distinct under full-token matching
    const ids = merged.body.match(/msgid:\S+/g) || [];
    assert.equal(new Set(ids).size, 2);
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
  it("returns default on corrupt JSON", () => {
    const p = join(tmpDir, "state.json");
    writeFileSync(p, "{ not valid json");
    assert.deepEqual(loadAssignmentState(p), { lastAssignedAt: {} });
  });
});
