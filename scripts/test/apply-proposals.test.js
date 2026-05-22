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
    const companies = JSON.parse(readFileSync(companiesPath, "utf-8"));
    const personal = companies.companies.find(c => c.id === "personal");
    assert.equal(personal.neverDelete.length, 1);
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
