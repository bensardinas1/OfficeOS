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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { atomicWrite } from "./fs-utils.js";
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
    if (!match) throw new Error(`Invalid --window: ${flags.window} (expected form like "24h" or "14d")`);
    const hours = Number(match[1]) * (match[2].toLowerCase() === "d" ? 24 : 1);
    if (hours === 0) throw new Error(`--window "${flags.window}" produces an empty range; minimum is 1h`);
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

function itemMatchesSender(email, sender) {
  const from = (email.from || "").toLowerCase();
  const name = (email.fromName || "").toLowerCase();
  if (sender.type === "email") return from === sender.value.toLowerCase();
  if (sender.type === "domain") return from.endsWith("@" + sender.value.toLowerCase()) || from.endsWith("." + sender.value.toLowerCase());
  if (sender.type === "name") return name.includes(sender.value.toLowerCase());
  return false;
}

function priorityRank(item, account) {
  let score = 0;
  if (item.email.urgent) score += 10;
  if ((account.prioritySenders || []).some(s => itemMatchesSender(item.email, s))) score += 20;
  if ((item.classification === "action" || item.classification === "respond")) score += 5;
  return score;
}

function actionableCategoryIds(typeConfig) {
  // TODO(v2): drive this from a per-category `actionable: true` flag in
  // config/account-types.json rather than hardcoding category IDs.
  // See CLAUDE.md Golden Rule. For v1, the two actionable categories
  // are "action" (business) and "respond" (personal); no other config
  // currently defines actionable categories.
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
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { proposals: [] };
  }
}

export async function runMorningBrief({ flags, deps }) {
  const { paths, accounts, typeConfigs, fetchFn, classifyFn, deleteFn, clock } = deps;
  const now = clock.now;
  const dryRun = !!flags.dryRun;
  const draftOnly = !!flags.draftOnly;

  const lastRunState = existsSync(paths.lastRunStatePath)
    ? JSON.parse(readFileSync(paths.lastRunStatePath, "utf-8"))
    : { lastRunAt: null };
  const window = determineWindow(flags, { now, lastRun: lastRunState.lastRunAt });

  const history = loadHistory(paths.senderHistoryPath);
  const proposalsObj = loadProposals(paths.proposedRulesPath);

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

    if (!dryRun && !draftOnly && autoDeleteIds.length > 0) {
      try {
        await deleteFn(account.id, autoDeleteIds);
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

    if (!dryRun) {
      // Reset consecutive-delete counters for senders whose emails were kept this run.
      // This is what makes auto-trash discovery actually "consecutive" rather than "cumulative".
      const deletedIds = new Set(autoDeleteIds);
      for (const [catId, bucket] of Object.entries(result.categories)) {
        if (catId === "ignore") continue;
        for (const e of bucket.emails) {
          if (deletedIds.has(e.id)) continue;
          if (e.from) recordKeep(history, account.id, e.from);
        }
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

    fyiCounts[account.id] = Object.entries(result.categories)
      .filter(([id]) => !actionableIds.has(id) && id !== "ignore")
      .reduce((sum, [, b]) => sum + b.emails.length, 0);

    let tasksCaptured = 0;
    if (!dryRun && typeConfig.taskCapture !== "manual") {
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

    // Travel scan excludes the ignore bucket (those emails were auto-deleted this run).
    for (const [catId, bucket] of Object.entries(result.categories)) {
      if (catId === "ignore") continue;
      for (const e of bucket.emails) {
        const text = `${e.subject || ""} ${e.preview || ""}`.toLowerCase();
        if (/\b(itinerary|booking|reservation|boarding|hotel|flight|rail|train|öbb|car rental|avis|noleggiare)\b/.test(text)) {
          travelEmails.push({ accountId: account.id, subject: e.subject, from: e.fromName || e.from, receivedAt: e.receivedAt });
        }
      }
    }
  }

  // Catch-up caps — globally sort by priorityRank before slicing so
  // high-priority items from low-volume accounts aren't displaced by
  // routine items from high-volume accounts.
  let needsDecision = needsDecisionAll;
  let deferred = [];
  let draftCandidates = draftCandidatesAll;
  if (window.catchUp) {
    const accountsById = new Map(accounts.map(a => [a.id, a]));
    const globalSort = (a, b) =>
      priorityRank(b, accountsById.get(b.accountId) || {}) -
      priorityRank(a, accountsById.get(a.accountId) || {});
    const sortedAll = [...needsDecisionAll].sort(globalSort);
    needsDecision = sortedAll.slice(0, CATCH_UP_DECISION_CAP);
    deferred = sortedAll.slice(CATCH_UP_DECISION_CAP);
    draftCandidates = [...draftCandidatesAll].sort(globalSort).slice(0, CATCH_UP_DRAFT_CAP);
  }

  // Pattern discovery — accumulator pattern: each call sees prior outputs
  const newProposals = [];
  if (!dryRun && !draftOnly) {
    let pending = [...proposalsObj.proposals];
    const autoTrash = discoverAutoTrash(history, accounts, pending, { now });
    pending = [...pending, ...autoTrash];
    const scam = discoverScamPatterns(recentDeletionsForScam, accounts, pending, { now });
    pending = [...pending, ...scam];
    const backfill = window.catchUp
      ? discoverMemoryBackfill(paths.memoryDir, accounts, pending, { now })
      : [];
    newProposals.push(...autoTrash, ...scam, ...backfill);

    // Backfill proposalsAdded per account so the brief's summary and the
    // triage-log capture per-account proposal counts. Target shape is
    // "companies.<accountId>.<field>".
    for (const p of newProposals) {
      const m = p.target.match(/^companies\.([^.]+)\./);
      const acctId = m ? m[1] : null;
      if (acctId && perAccountStats[acctId]) {
        perAccountStats[acctId].proposalsAdded = (perAccountStats[acctId].proposalsAdded || 0) + 1;
      }
      if (acctId && summary[acctId]) {
        summary[acctId].proposalsAdded = (summary[acctId].proposalsAdded || 0) + 1;
      }
    }

    proposalsObj.proposals.push(...newProposals);

    // Persist state
    atomicWrite(paths.proposedRulesPath, JSON.stringify(proposalsObj, null, 2));
    saveHistory(paths.senderHistoryPath, history);

    appendTriageLog(paths.triageLogPath, {
      timestamp: now,
      window,
      perAccount: perAccountStats
    });
    atomicWrite(paths.lastRunStatePath, JSON.stringify({ lastRunAt: now }, null, 2));
  }

  return {
    timestamp: now,
    window,
    dryRun,
    draftOnly,
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

// CLI entrypoint — Windows-safe guard (NOT import.meta.url === file://${argv[1]})
if (process.argv[1] && process.argv[1].endsWith("morning-brief.js")) {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") flags.dryRun = true;
    else if (args[i] === "--draft-only") flags.draftOnly = true;
    else if (args[i] === "--since") flags.since = args[++i];
    else if (args[i] === "--window") flags.window = args[++i];
  }
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = join(__dirname, "..");
  const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
  const accountTypes = JSON.parse(readFileSync(join(root, "config/account-types.json"), "utf-8"));
  const { classify } = await import("./classify-emails.js");

  function fetchSubprocess(accountId, sinceIso) {
    const account = companies.companies.find(c => c.id === accountId);
    const script = account.provider === "gmail" ? "fetch-gmail.js" : "fetch-emails.js";
    const hours = Math.ceil((Date.now() - new Date(sinceIso).getTime()) / 3600000);
    const child = spawnSync("node", [join(root, "scripts", script), accountId, String(hours), "inbox"], {
      encoding: "utf-8", maxBuffer: 50 * 1024 * 1024
    });
    if (child.status !== 0) throw new Error(child.stderr || `fetch failed for ${accountId}`);
    return JSON.parse(child.stdout);
  }
  function deleteSubprocess(accountId, ids) {
    if (ids.length === 0) return { trashed: 0, failed: 0 };
    const account = companies.companies.find(c => c.id === accountId);
    const script = account.provider === "gmail" ? "delete-gmail-emails.js" : "delete-emails.js";
    const child = spawnSync("node", [join(root, "scripts", script), accountId, ...ids], { encoding: "utf-8" });
    if (child.status !== 0) throw new Error(child.stderr || `delete failed for ${accountId}`);
    return { trashed: ids.length, failed: 0 };
  }

  // NOTE: The CLI classifyFn adapter ignores the `account` and `typeConfig`
  // parameters because classify(emails, accountId) loads its own config.
  // The injected typeConfigs are populated for the test contract; the CLI
  // path uses the on-disk config directly. This double-load is intentional
  // — keeping the test surface and CLI surface in sync would require
  // exposing a classifyWithContext export; deferred to v2.
  const result = await runMorningBrief({
    flags,
    deps: {
      paths: {
        dataDir: join(root, "data"),
        memoryDir: join(root, "memory"),
        senderHistoryPath: join(root, "data/sender-history.json"),
        proposedRulesPath: join(root, "data/proposed-rules.json"),
        tasksPath: join(root, "data/tasks.md"),
        triageLogPath: join(root, "data/triage-log.md"),
        lastRunStatePath: join(root, "data/last-run-state.json")
      },
      accounts: companies.companies,
      typeConfigs: accountTypes,
      fetchFn: async (accountId, sinceIso) => fetchSubprocess(accountId, sinceIso),
      classifyFn: (emails, account) => classify(emails, account.id),
      deleteFn: async (accountId, ids) => deleteSubprocess(accountId, ids),
      clock: { now: new Date().toISOString() }
    }
  });
  process.stdout.write(JSON.stringify(result, null, 2));
}
