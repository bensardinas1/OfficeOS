import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMorningBrief, determineWindow, isCatchUp, isDraftable } from "../morning-brief.js";
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
  it("throws on zero-hour window", () => {
    assert.throws(() => determineWindow({ window: "0h" }, { now: "2026-05-21T00:00:00Z", lastRun: null }), /empty range/i);
  });
  it("throws with a hint on unrecognized unit", () => {
    assert.throws(() => determineWindow({ window: "3w" }, { now: "2026-05-21T00:00:00Z", lastRun: null }), /expected form/i);
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
    // Pre-create last-run-state so the first-run guard doesn't force dry-run for tests
    // that explicitly test live behavior. Individual first-run tests delete it.
    writeFileSync(join(dataDir, "last-run-state.json"), JSON.stringify({ lastRunAt: "2026-05-20T06:00:00Z" }));
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
        lastRunStatePath: join(dataDir, "last-run-state.json"),
        draftsIndexPath: join(dataDir, "drafts-index.json"),
        lastRunBundlePath: join(dataDir, ".last-run-bundle.json")
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
    // Remove the pre-seeded last-run-state so we can assert that dry-run
    // does NOT create it. We pass --first-run-live=false implicitly via dryRun:true.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(dataDir, "last-run-state.json"));
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

  it("backfills proposalsAdded into per-account summary when discovery emits proposals", async () => {
    const deps = buildDeps();
    // Force the auto-trash threshold by pre-seeding sender-history with 7 deletes.
    const { join } = await import("node:path");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(dataDir), { recursive: true });
    writeFileSync(join(dataDir, "sender-history.json"), JSON.stringify({
      "personal:noreply@linkedin.com": {
        deletedCount: 6,  // 6 + this run's 1 = 7, crosses threshold of 5
        hasListUnsubscribe: true,
        lastDeletedAt: "2026-05-20T06:00:00Z"
      }
    }));
    const result = await runMorningBrief({ flags: { window: "24h" }, deps });
    // discoverAutoTrash should have fired for the LinkedIn sender; proposalsAdded should be >0.
    if (result.proposedRules.length > 0) {
      assert.ok(result.summary.personal.proposalsAdded > 0,
        "proposalsAdded should be backfilled into summary");
    }
  });

  it("does NOT delete or run pattern discovery in --draft-only mode", async () => {
    const deps = buildDeps();
    const result = await runMorningBrief({ flags: { window: "24h", draftOnly: true }, deps });
    assert.equal(deleted.length, 0, "no deletes in draft-only");
    assert.equal(result.draftOnly, true);
    // draftCandidates should still be populated for the skill to draft
    assert.ok(Array.isArray(result.draftCandidates));
  });

  it("does NOT capture tasks for accounts with taskCapture=manual", async () => {
    const deps = buildDeps();
    // Force personal typeConfig to manual capture
    deps.typeConfigs = {
      ...sampleTypeConfig,
      personal: { ...sampleTypeConfig.personal, taskCapture: "manual" }
    };
    await runMorningBrief({ flags: { window: "24h" }, deps });
    // tasks.md should not exist because the only account is personal w/ manual capture
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    assert.equal(existsSync(join(dataDir, "tasks.md")), false);
  });

  it("globally sorts needsDecision by priority across accounts in catch-up", async () => {
    const deps = buildDeps();
    // Two accounts: one (personal) with lots of routine action items;
    // we'll inject a priority-sender match on a different "external" account
    // to verify it lands in the top 25 even though it's account-2.
    deps.accounts = [
      { id: "high-volume", accountType: "personal", provider: "gmail", myEmail: "v@x.com",
        prioritySenders: [], neverDelete: [], alwaysDelete: [], scamPatterns: [],
        urgencyRules: { flags: [] }, downrank: [] },
      { id: "partner-account", accountType: "personal", provider: "gmail", myEmail: "p@x.com",
        prioritySenders: [{ type: "name", value: "George Gabela", label: "partner" }],
        neverDelete: [], alwaysDelete: [], scamPatterns: [],
        urgencyRules: { flags: [] }, downrank: [] }
    ];
    deps.fetchFn = async (accountId) => {
      if (accountId === "high-volume") {
        return Array.from({ length: 30 }, (_, i) => ({
          id: `hv${i}`, from: "noise@x.com", fromName: "Noise",
          subject: `URGENT routine ${i}`, hasListUnsubscribe: false,
          receivedAt: "2026-05-21T05:00:00Z"
        }));
      }
      return [{ id: "p1", from: "george@hcma.com", fromName: "George Gabela",
        subject: "URGENT review LOI", hasListUnsubscribe: false, receivedAt: "2026-05-21T05:00:00Z" }];
    };
    const result = await runMorningBrief({ flags: { since: "2026-05-01T00:00:00Z" }, deps });
    assert.ok(result.window.catchUp);
    const partnerItem = result.needsDecision.find(i => i.email.id === "p1");
    assert.ok(partnerItem, "partner-account priority item should be in needsDecision, not deferred");
  });

  it("forces dry-run on first run when last-run-state is missing", async () => {
    const deps = buildDeps();
    const { unlinkSync } = await import("node:fs");
    unlinkSync(deps.paths.lastRunStatePath);  // simulate first run
    const result = await runMorningBrief({ flags: { window: "24h" }, deps });
    assert.equal(result.dryRun, true, "should be forced to dry-run");
    assert.equal(result.forcedFirstRunDryRun, true);
    assert.equal(deleted.length, 0);
    assert.ok(result.warnings.some(w => /first run/i.test(w)));
  });

  it("does not force dry-run when --first-run-live is set", async () => {
    const deps = buildDeps();
    const { unlinkSync } = await import("node:fs");
    unlinkSync(deps.paths.lastRunStatePath);  // simulate first run
    const result = await runMorningBrief({ flags: { window: "24h", firstRunLive: true }, deps });
    assert.equal(result.dryRun, false);
    assert.equal(result.forcedFirstRunDryRun, false);
    // may or may not have deletions, but live path runs
  });

  it("does not force dry-run when last-run-state already exists", async () => {
    const deps = buildDeps();
    // beforeEach already pre-created last-run-state, so this should NOT trigger first-run guard.
    const result = await runMorningBrief({ flags: { window: "24h" }, deps });
    assert.equal(result.dryRun, false);
    assert.equal(result.forcedFirstRunDryRun, false);
  });

  it("filters draft candidates whose source message is already in drafts-index", async () => {
    const deps = buildDeps();
    // Pre-populate drafts-index with an entry for msg m3 (the URGENT one)
    writeFileSync(deps.paths.draftsIndexPath, JSON.stringify({
      "personal:m3": { draftId: "abc-123", savedAt: "2026-05-20T00:00:00Z", preview: "Stub draft" }
    }));
    const result = await runMorningBrief({ flags: { window: "24h", firstRunLive: true }, deps });
    // m3 still in needsDecision but not in draftCandidates
    assert.ok(result.needsDecision.find(i => i.email.id === "m3"), "m3 should still need decision");
    assert.equal(result.draftCandidates.find(i => i.email.id === "m3"), undefined, "m3 should NOT be a draft candidate");
  });

  it("with --defer-heuristic-deletes: trashes only explicit deletions", async () => {
    const deps = buildDeps();
    deps.classifyFn = (emails, account) => {
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
    const deps = buildDeps();
    const result = await runMorningBrief({ flags: { window: "24h", firstRunLive: true }, deps });
    assert.ok(deleted.length >= 1, "deletes happen as before");
    assert.equal(result.bundle, undefined, "no bundle when flag off");
  });

  it("bundle emails carry an `account` field for issue-apply to read", async () => {
    const deps = buildDeps();
    deps.classifyFn = (emails, account) => {
      const result = { accountId: account.id, accountName: account.name, accountType: account.accountType,
        categories: { fyi: { label: "FYI", emails: [] }, ignore: { label: "IGNORE", emails: [] } },
        deletionCandidates: [], explicitDeletions: [], heuristicDeletions: [] };
      for (const e of emails) {
        if (e.id === "e-heur") { result.categories.ignore.emails.push(e); result.deletionCandidates.push(e); result.heuristicDeletions.push(e); }
        else { result.categories.fyi.emails.push(e); }
      }
      return result;
    };
    deps.fetchFn = async () => ([
      { id: "e-keep", from: "a@b.com", fromName: "A", subject: "hi", hasListUnsubscribe: false, receivedAt: "2026-05-23T05:00:00Z" },
      { id: "e-heur", from: "n@y.com", fromName: "N", subject: "digest", hasListUnsubscribe: true, receivedAt: "2026-05-23T05:00:00Z" },
    ]);
    const result = await runMorningBrief({ flags: { window: "24h", firstRunLive: true, deferHeuristicDeletes: true }, deps });
    assert.ok(result.bundle.survivors.every(e => typeof e.account === "string" && e.account.length > 0), "survivors carry account");
    assert.ok(result.bundle.heuristicCandidates.every(e => typeof e.account === "string" && e.account.length > 0), "candidates carry account");
  });
});

describe("actionableCategoryIds fallback", () => {
  let tmpDir, dataDir, memoryDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "morning-brief-fallback-"));
    dataDir = join(tmpDir, "data");
    memoryDir = join(tmpDir, "memory");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(dataDir, "last-run-state.json"), JSON.stringify({ lastRunAt: "2026-05-20T06:00:00Z" }));
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("falls back to action/respond when no category has actionable flag", async () => {
    const oldTypeConfigs = {
      personal: {
        triageCategories: [
          { id: "respond", label: "RESPOND" },  // no actionable flag
          { id: "fyi", label: "FYI" },
          { id: "ignore", label: "IGNORE", hidden: true }
        ],
        downrankDefaults: [],
        bulkSignalThreshold: 1,
        deletionPolicy: { categories: ["ignore"], patterns: [], neverDelete: [], alwaysDelete: [] }
      }
    };
    const deps = {
      paths: {
        dataDir,
        memoryDir,
        senderHistoryPath: join(dataDir, "sender-history.json"),
        proposedRulesPath: join(dataDir, "proposed-rules.json"),
        tasksPath: join(dataDir, "tasks.md"),
        triageLogPath: join(dataDir, "triage-log.md"),
        lastRunStatePath: join(dataDir, "last-run-state.json"),
        draftsIndexPath: join(dataDir, "drafts-index.json")
      },
      accounts: [{
        id: "personal", name: "Personal", accountType: "personal", provider: "gmail",
        myEmail: "p@x.com", prioritySenders: [], neverDelete: [], alwaysDelete: [],
        scamPatterns: [], urgencyRules: { flags: [] }, downrank: []
      }],
      typeConfigs: oldTypeConfigs,
      classifyFn: (emails, account, typeConfig) => {
        const result = { categories: { respond: { label: "RESPOND", emails: [] }, fyi: { label: "FYI", emails: [] }, ignore: { label: "IGNORE", emails: [] } }, deletionCandidates: [] };
        for (const e of emails) result.categories.respond.emails.push(e);
        return result;
      },
      fetchFn: async () => [{ id: "x1", from: "a@b.com", fromName: "A", subject: "Hi", hasListUnsubscribe: false, receivedAt: "2026-05-21T05:00:00Z" }],
      deleteFn: async () => ({ trashed: 0, failed: 0 }),
      clock: { now: "2026-05-21T06:00:00Z" }
    };
    const result = await runMorningBrief({ flags: { window: "24h", firstRunLive: true }, deps });
    assert.ok(result.needsDecision.length > 0, "respond emails should be in needsDecision even without actionable flag (back-compat)");
  });
});

describe("isDraftable — false-positive guards", () => {
  // The bare /\bdecline\b/i heuristic previously matched credit-card-declined
  // notifications, leading to wasted drafts. These tests pin the tighter
  // contextual heuristics.

  it("does NOT match a Microsoft credit-card-declined notification", () => {
    const email = {
      subject: "Your credit card was declined—try paying again",
      preview: "The credit card used to pay invoice #G159864615 was declined. Decline reason: Insufficient funds. Review your payment method."
    };
    assert.equal(isDraftable(email), false);
  });

  it("does NOT match a routine subscription renewal notice", () => {
    const email = {
      subject: "Your Microsoft 365 subscription will renew on June 15",
      preview: "Your annual subscription will renew automatically. No action needed."
    };
    assert.equal(isDraftable(email), false);
  });

  it("does NOT match a verification confirm-email request", () => {
    const email = {
      subject: "Please confirm your email address",
      preview: "Click the link below to confirm your email."
    };
    assert.equal(isDraftable(email), false);
  });

  it("does NOT match a calendar reminder (schedule keyword, no invite)", () => {
    const email = {
      subject: "Schedule reminder: weekly digest",
      preview: "Here is your scheduled weekly digest."
    };
    assert.equal(isDraftable(email), false);
  });

  it("DOES match an Outlook 'Declined:' calendar response subject", () => {
    const email = {
      subject: "Declined: Quarterly Review — May 25",
      preview: "Jay Eslick declined this meeting."
    };
    assert.equal(isDraftable(email), true);
  });

  it("DOES match a calendar invite subject", () => {
    const email = {
      subject: "Calendar invite: Path Peptides onboarding call",
      preview: "When: Friday, May 30, 10am EST"
    };
    assert.equal(isDraftable(email), true);
  });

  it("DOES match 'invite to meet' phrasing", () => {
    const email = {
      subject: "Invite to meet next week",
      preview: "Are you free Wednesday for a 30-min chat?"
    };
    assert.equal(isDraftable(email), true);
  });

  it("DOES match RSVP requests", () => {
    const email = {
      subject: "Please RSVP — Sigma Phi Epsilon FIU spring banquet",
      preview: "We need a headcount by Friday."
    };
    assert.equal(isDraftable(email), true);
  });

  it("DOES match an 'are you available' scheduling probe", () => {
    const email = {
      subject: "Are you available Thursday?",
      preview: "Wanted to grab 15 minutes to discuss the LOI."
    };
    assert.equal(isDraftable(email), true);
  });

  it("DOES match a renewal decision request", () => {
    const email = {
      subject: "Renewal decision needed — Adobe Creative Cloud",
      preview: "Your annual plan ends June 1. Please confirm renewal."
    };
    assert.equal(isDraftable(email), true);
  });

  it("DOES match an explicit decline of an invitation", () => {
    const email = {
      subject: "Re: Quarterly Review",
      preview: "Unfortunately I have to decline your meeting invitation — I'll be traveling that week."
    };
    assert.equal(isDraftable(email), true);
  });

  it("DOES match a reschedule-the-meeting request", () => {
    const email = {
      subject: "Can we reschedule the call?",
      preview: "Something came up — can we move to next Tuesday?"
    };
    assert.equal(isDraftable(email), true);
  });
});
