/**
 * daemon.js — OfficeOS daemon entrypoint. Wires real connectors (subprocess
 * fetch/classify/save-draft, same pattern as scripts/morning-brief.js),
 * starts the localhost API, and schedules ticks. Binds 127.0.0.1 only.
 *
 * Usage: node daemon/daemon.js [--port 8138] [--once]
 *   --once   run a single tick, print summary, and exit (no server)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createStore } from "./store.js";
import { createAckStore } from "./acknowledge.js";
import { createApiServer } from "./api.js";
import { runTick } from "./scheduler.js";
import { buildCtxFor, resolvePollMs, chooseConnectors } from "./wiring.js";
import { notify } from "./notifier.js";
import { makeReasonerFn } from "./claude-reasoner.js";
import { createLogger } from "./log.js";
import { createActionLog } from "./action-log.js";
import { makeFakeConnectors } from "./fake-connectors.js";
import { fetchMail, deleteEmails, restoreEmails, fetchMessageBody, deleteBySender } from "../scripts/mail.js";
import { applyKillListAdd } from "../scripts/killlist-add.js";
import { applyKillListRemove } from "../scripts/killlist-remove.js";
import { loadCorrespondentsFile, correspondentSet } from "../scripts/correspondents.js";
import { validateConfig } from "../scripts/validate-config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 8138;
const DEFAULT_POLL_MINUTES = 15;

function loadConfig(configDir) {
  const companies = JSON.parse(readFileSync(join(configDir, "companies.json"), "utf-8"));
  const accountTypes = JSON.parse(readFileSync(join(configDir, "account-types.json"), "utf-8"));
  return { companies, accountTypes };
}

/**
 * Async subprocess runner — replaces spawnSync so a tick never blocks the HTTP
 * event loop (keeps the panel responsive during fetches/drafts/reasoner calls).
 * Resolves { status, stdout, stderr }; never blocks; enforces optional timeout
 * and maxBuffer (kills + rejects on overflow).
 */
function runProcess(cmd, args, { input = null, timeoutMs = 0, maxBuffer = 50 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out = [], err = [];
    let outLen = 0, settled = false, timer = null;
    const fail = (e) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); try { child.kill(); } catch {} reject(e); };
    if (timeoutMs > 0) timer = setTimeout(() => fail(new Error(`${cmd} timed out after ${timeoutMs}ms`)), timeoutMs);
    child.stdout.on("data", (d) => { outLen += d.length; if (outLen > maxBuffer) fail(new Error(`${cmd} exceeded maxBuffer`)); else out.push(d); });
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return; settled = true; if (timer) clearTimeout(timer);
      resolve({ status: code, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8") });
    });
    if (input != null) { child.stdin.write(input); child.stdin.end(); }
  });
}

async function runClaude(prompt) {
  // timeout bounds the blast radius if `claude` hangs (e.g. waiting on auth);
  // the timeout kills + rejects → makeReasonerFn catches it → regroup keeps
  // deterministic grouping.
  const r = await runProcess("claude", ["-p", prompt], { timeoutMs: 30000, maxBuffer: 10 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr || "claude invocation failed");
  return r.stdout;
}

function makeSaveDraftFn(account) {
  // Gmail vs Outlook draft scripts mirror the morning-brief delete dispatch.
  const script = account.provider === "gmail" ? "save-gmail-draft.js" : "save-draft.js";
  return async (accountId, draft) => {
    const r = await runProcess("node", [join(root, "scripts", script), accountId], { input: JSON.stringify(draft) });
    if (r.status !== 0) throw new Error(r.stderr || `save-draft failed for ${accountId}`);
    return JSON.parse(r.stdout);
  };
}

function getPendingDeletions(dataDir) {
  try { return JSON.parse(readFileSync(join(dataDir, "pending-deletions.json"), "utf-8")); }
  catch { return null; }
}

async function runTriageFn(accountId, lookbackHours) {
  const args = [join(root, "scripts", "triage.js"), accountId || "all"];
  if (lookbackHours) args.push(String(lookbackHours)); // positional: <accounts> <hours>
  const r = await runProcess("node", args, { timeoutMs: 120000 });
  if (r.status !== 0) throw new Error(r.stderr || "triage failed");
  return { ok: true };
}

async function main() {
  const args = process.argv.slice(2);
  const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : DEFAULT_PORT;
  const once = args.includes("--once");
  const dataDir = args.includes("--data-dir") ? args[args.indexOf("--data-dir") + 1] : join(root, "data");
  const configDir = args.includes("--config-dir") ? args[args.indexOf("--config-dir") + 1] : join(root, "config");

  const logger = createLogger(dataDir);
  const startedAt = new Date().toISOString();
  process.on("uncaughtException", (err) => { logger.log("error", "fatal", { stack: String(err.stack || err) }); process.exit(1); });
  process.on("unhandledRejection", (err) => { logger.log("error", "fatal", { stack: String(err?.stack || err) }); process.exit(1); });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { logger.log("info", "shutdown", { signal: sig }); process.exit(0); });

  let companies, accountTypes;
  try {
    ({ companies, accountTypes } = loadConfig(configDir));
  } catch (err) {
    logger.log("error", "fatal", { stack: String(err.stack || err) });
    process.exit(1);
    return;
  }

  const store = createStore(dataDir);
  const ackStore = createAckStore(dataDir);
  const actionLog = createActionLog(dataDir);
  let lastTickAt = null;

  // Config findings: revalidated every tick (kill-list writes mutate
  // companies.json at runtime), logged only when the finding set changes.
  let configFindings = [];
  let lastFindingsKey = null;
  function refreshConfigFindings() {
    try {
      const cfg = loadConfig(configDir);
      configFindings = validateConfig(cfg.companies, cfg.accountTypes);
    } catch (e) {
      configFindings = [{ level: "error", path: "config", message: `config unreadable: ${e.message}` }];
    }
    const key = JSON.stringify(configFindings);
    const prevKey = lastFindingsKey;
    lastFindingsKey = key;
    if (key !== prevKey && (configFindings.length || prevKey !== null)) {
      logger.log(configFindings.length ? "warn" : "info", "config-findings",
        { count: configFindings.length, findings: configFindings });
    }
  }
  refreshConfigFindings();

  const { classify } = await import("../scripts/classify-emails.js");

  const acctById = new Map(companies.companies.map(a => [a.id, a]));
  const acct = (id) => { const a = acctById.get(id); if (!a) throw new Error(`unknown account: ${id}`); return a; };
  const correspondentsFor = (id) => {
    try { return correspondentSet(loadCorrespondentsFile(join(dataDir, "correspondents.json")), id); }
    catch { return undefined; }
  };
  const real = {
    fetchFn: (accountId, folder, hours) => {
      const a = acct(accountId);
      return a.provider === "gmail"
        ? fetchMail(a, { hours, max: 100 })
        : fetchMail(a, { hours, folder, max: 500, bodyChars: 4000 });
    },
    deleteFn: (accountId, ids) => deleteEmails(acct(accountId), ids),
    restoreFn: (accountId, ids) => restoreEmails(acct(accountId), ids),
    fetchBodyFn: (accountId, emailId) => fetchMessageBody(acct(accountId), emailId),
    deleteBySenderFn: (accountId, sender, opts = {}) =>
      deleteBySender(acct(accountId), sender, { ...opts, correspondents: correspondentsFor(accountId) }),
    killlistFn: async (accountId, sender) => applyKillListAdd(configDir, accountId, sender, { correspondentsPath: join(dataDir, "correspondents.json") }),
    killlistRemoveFn: async (accountId, sender) => applyKillListRemove(configDir, accountId, sender),
    runTriageFn,
  };
  const conn = chooseConnectors(process.env, real, makeFakeConnectors());

  const deps = (emit) => ({
    accounts: companies.companies,
    typeConfigs: accountTypes,
    store,
    fetchFn: conn.fetchFn,
    classifyFn: (emails, account) => classify(emails, account.id),
    clock: { now: new Date().toISOString() },
    emit,
    reasonerFn: makeReasonerFn(runClaude),
    getAcks: () => ackStore.getAcks(),
    getPendingDeletions: () => getPendingDeletions(dataDir),
    getConfigFindings: () => configFindings,
  });

  if (once) {
    const t0 = Date.now();
    try {
      refreshConfigFindings();
      const summary = await runTick(deps(() => {}));
      logger.log("info", "tick-end", { ms: Date.now() - t0, items: summary.itemCount, changed: summary.changed, warnings: summary.warnings });
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    } catch (err) {
      logger.log("error", "tick-error", { stack: String(err.stack || err) });
      throw err;
    }
    return;
  }

  const ctxFor = buildCtxFor(companies.companies, makeSaveDraftFn);
  const server = createApiServer({
    store, ctxFor, getLastTickAt: () => lastTickAt, ackStore,
    clock: { now: () => new Date().toISOString() }, accounts: companies.companies,
    fetchBodyFn: conn.fetchBodyFn, deleteFn: conn.deleteFn, killlistFn: conn.killlistFn,
    runTriageFn: conn.runTriageFn, onTriage: () => tick(), restoreFn: conn.restoreFn,
    killlistRemoveFn: conn.killlistRemoveFn, deleteBySenderFn: conn.deleteBySenderFn,
    actionLog, startedAt,
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") { logger.log("info", "already-running", { port }); process.exit(0); }
    logger.log("error", "fatal", { stack: String(err.stack || err) }); process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    logger.log("info", "daemon-started", { pid: process.pid, port });
  });

  async function tick() {
    const t0 = Date.now();
    try {
      refreshConfigFindings();
      const summary = await runTick(deps((e) => {
        server.broadcastUpdate(e);
        if (e?.notify && process.env.OFFICEOS_FAKE_CONNECTORS !== "1") notify(e.notify); // fire-and-forget; never throws; suppressed in fake mode
      }));
      lastTickAt = new Date().toISOString();
      logger.log("info", "tick-end", { ms: Date.now() - t0, items: summary.itemCount, changed: summary.changed, warnings: summary.warnings });
    } catch (err) {
      logger.log("error", "tick-error", { stack: String(err.stack || err) });
    }
  }
  await tick(); // immediate first tick
  // Per-account intervals collapse to the smallest configured interval for the shared loop.
  const minMs = Math.min(...companies.companies.map(a => resolvePollMs(a, DEFAULT_POLL_MINUTES)));
  setInterval(tick, minMs);
}

if (process.argv[1] && process.argv[1].endsWith("daemon.js")) {
  main().catch(err => { process.stderr.write(String(err.stack || err) + "\n"); process.exit(1); });
}
