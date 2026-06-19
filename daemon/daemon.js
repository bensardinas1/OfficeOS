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
import { buildCtxFor, resolvePollMs } from "./wiring.js";
import { notify } from "./notifier.js";
import { makeReasonerFn } from "./claude-reasoner.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 8138;
const DEFAULT_POLL_MINUTES = 15;

function loadConfig() {
  const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
  const accountTypes = JSON.parse(readFileSync(join(root, "config/account-types.json"), "utf-8"));
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

async function fetchSubprocess(accountId, folder, hours) {
  const { companies } = loadConfig();
  const account = companies.companies.find(c => c.id === accountId);
  const script = account.provider === "gmail" ? "fetch-gmail.js" : "fetch-emails.js";
  const base = [join(root, "scripts", script), accountId, String(hours), folder];
  const args = account.provider === "gmail" ? base : [...base, "500", "4000"];
  const r = await runProcess("node", args);
  if (r.status !== 0) throw new Error(r.stderr || `fetch failed for ${accountId}/${folder}`);
  return JSON.parse(r.stdout);
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

async function fetchBody(accountId, emailId) {
  const r = await runProcess("node", [join(root, "scripts", "fetch-message.js"), accountId, emailId], { timeoutMs: 20000 });
  if (r.status !== 0) throw new Error(r.stderr || `fetch-message failed for ${accountId}`);
  return JSON.parse(r.stdout);
}

function makeDeleteFn() {
  const { companies } = loadConfig();
  // Chunk ids so argv never overflows on Windows (~8k char limit); sum results.
  return async (accountId, ids) => {
    const account = companies.companies.find(c => c.id === accountId);
    const script = account?.provider === "gmail" ? "delete-gmail-emails.js" : "delete-emails.js";
    let trashed = 0, failed = 0;
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const r = await runProcess("node", [join(root, "scripts", script), accountId, ...chunk]);
      if (r.status !== 0) throw new Error(r.stderr || `delete failed for ${accountId}`);
      const m = /Done:\s*(\d+) trashed(?:,\s*(\d+) failed)?/.exec(r.stdout);
      trashed += m ? Number(m[1]) : 0;
      failed += m && m[2] ? Number(m[2]) : 0;
    }
    return { trashed, failed };
  };
}

async function killlistFn(accountId, sender) {
  const r = await runProcess("node", [join(root, "scripts", "killlist-add.js"), accountId], { input: JSON.stringify({ sender }) });
  if (r.status !== 0) throw new Error(r.stderr || `killlist-add failed for ${accountId}`);
  return JSON.parse(r.stdout);
}

async function main() {
  const args = process.argv.slice(2);
  const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : DEFAULT_PORT;
  const once = args.includes("--once");

  const { companies, accountTypes } = loadConfig();
  const store = createStore(join(root, "data"));
  const ackStore = createAckStore(join(root, "data"));
  let lastTickAt = null;

  const { classify } = await import("../scripts/classify-emails.js");
  const deps = (emit) => ({
    accounts: companies.companies,
    typeConfigs: accountTypes,
    store,
    fetchFn: async (accountId, folder, hours) => fetchSubprocess(accountId, folder, hours),
    classifyFn: (emails, account) => classify(emails, account.id),
    clock: { now: new Date().toISOString() },
    emit,
    reasonerFn: makeReasonerFn(runClaude),
    getAcks: () => ackStore.getAcks(),
  });

  if (once) {
    const summary = await runTick(deps(() => {}));
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

  const ctxFor = buildCtxFor(companies.companies, makeSaveDraftFn);
  const server = createApiServer({ store, ctxFor, getLastTickAt: () => lastTickAt, ackStore, clock: { now: () => new Date().toISOString() }, accounts: companies.companies, fetchBodyFn: fetchBody, deleteFn: makeDeleteFn(), killlistFn });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(JSON.stringify({ type: "daemon-started", url: `http://localhost:${port}`, panel: `http://localhost:${port}/` }) + "\n");
  });

  async function tick() {
    try {
      await runTick(deps((e) => {
        server.broadcastUpdate(e);
        if (e?.notify) notify(e.notify); // fire-and-forget; never throws
      }));
      lastTickAt = new Date().toISOString();
    } catch (err) {
      process.stderr.write(`tick error: ${err.message}\n`);
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
