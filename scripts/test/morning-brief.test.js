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
