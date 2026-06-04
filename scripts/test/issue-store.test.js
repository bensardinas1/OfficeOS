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
