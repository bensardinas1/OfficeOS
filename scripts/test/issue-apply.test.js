import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join as joinPath } from "node:path";
import { applyReasonerOutput } from "../issue-apply.js";
import { loadIssues, loadProvisional, createIssue, saveIssue } from "../issue-store.js";
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
    const real = loadIssues(issuesDir);
    const seaa = real.find(i => i.id === "seaa-partner-meetings");
    assert.ok(seaa, "SEAA Partner Meetings issue created at top level");
    const msgids = seaa.body.match(/msgid:m-\w+/g) || [];
    assert.ok(msgids.includes("msgid:m-neal") && msgids.includes("msgid:m-brad"));
    assert.deepEqual(out.toTrash.sort(), ["m-promo1", "m-promo2"]);
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

describe("applyReasonerOutput — re-run idempotency (C1)", () => {
  it("does not overwrite an existing NEW: issue on re-run; appends instead", () => {
    // First run creates the issue (2 emails → real).
    applyReasonerOutput(seaaReasonerOutput, sampleEmailsById, { issuesDir, now: "2026-05-27" });
    const before = loadIssues(issuesDir).find(i => i.id === "seaa-partner-meetings");
    // Simulate a decision written into the issue between runs.
    before.body = before.body.replace("## Decisions made", "## Decisions made\n- 2026-05-27: meet Neal at booth");
    saveIssue(before);
    // Second run with the same records.
    applyReasonerOutput(seaaReasonerOutput, sampleEmailsById, { issuesDir, now: "2026-05-28" });
    const after = loadIssues(issuesDir).find(i => i.id === "seaa-partner-meetings");
    assert.match(after.body, /meet Neal at booth/, "prior decision preserved across re-run");
    // No duplicate msgid lines.
    const neal = (after.body.match(/msgid:m-neal/g) || []);
    assert.equal(neal.length, 1, "no duplicate linked-message line");
  });
});

describe("applyReasonerOutput — toTrash dedup (I1)", () => {
  it("dedupes repeated trash msgids", () => {
    const records = [
      { msgid: "m-promo1", verdict: "trash", issue: null, reason: "x" },
      { msgid: "m-promo1", verdict: "trash", issue: null, reason: "x again" },
    ];
    const out = applyReasonerOutput(records, sampleEmailsById, { issuesDir, now: "2026-05-27" });
    assert.deepEqual(out.toTrash, ["m-promo1"]);
  });
});

describe("applyReasonerOutput — rescued (I3)", () => {
  it("marks kept heuristic candidates as rescued", () => {
    const records = [
      { msgid: "m-neal", verdict: "keep", issue: "NEW:SEAA Partner Meetings", reason: "x", next_action_update: "reply", waiting_on_update: "you" },
      { msgid: "m-brad", verdict: "keep", issue: "NEW:SEAA Partner Meetings", reason: "y", next_action_update: "reply", waiting_on_update: "you" },
    ];
    const out = applyReasonerOutput(records, sampleEmailsById, { issuesDir, now: "2026-05-27", heuristicMsgids: ["m-neal"] });
    assert.deepEqual(out.rescued, ["m-neal"]);
  });
});

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

describe("issue-apply CLI entrypoint", () => {
  it("reads stdin JSON and prints a report, creating issues on disk", () => {
    const payload = JSON.stringify({
      records: [{ msgid: "m-oneoff", verdict: "keep", issue: "NEW:Cli Smoke Topic", reason: "x", next_action_update: "", waiting_on_update: "you" }],
      emailsById: { "m-oneoff": sampleEmailsById["m-oneoff"] },
      heuristicMsgids: [],
      now: "2026-05-27",
    });
    // Resolve the real script path relative to repo root (cwd during npm test is repo root).
    const scriptPath = joinPath(process.cwd(), "scripts", "issue-apply.js");
    const out = execFileSync("node", [scriptPath, issuesDir], { input: payload, encoding: "utf-8" });
    const report = JSON.parse(out);
    assert.ok(Array.isArray(report.quarantined));
    // single-message NEW with empty next_action → provisional
    assert.ok(report.quarantined.includes("cli-smoke-topic"));
    assert.ok(loadProvisional(issuesDir).find(i => i.id === "cli-smoke-topic"));
  });
});
