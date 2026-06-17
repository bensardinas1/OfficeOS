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
import { spawnSync } from "node:child_process";
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

function fetchSubprocess(accountId) {
  const { companies } = loadConfig();
  const account = companies.companies.find(c => c.id === accountId);
  const script = account.provider === "gmail" ? "fetch-gmail.js" : "fetch-emails.js";
  // owed_risk scans a wide window; 168h (7d) is a reasonable default for failed-payment recency.
  const child = spawnSync("node", [join(root, "scripts", script), accountId, "168", "inbox"], {
    encoding: "utf-8", maxBuffer: 50 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr || `fetch failed for ${accountId}`);
  return JSON.parse(child.stdout);
}

function runClaude(prompt) {
  // timeout bounds the blast radius if `claude` hangs (e.g. waiting on auth);
  // a timed-out spawn sets child.error, which the caller turns into a throw →
  // makeReasonerFn catches it → regroup keeps deterministic grouping.
  const child = spawnSync("claude", ["-p", prompt], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30000 });
  if (child.error || child.status !== 0) throw new Error(child.stderr || "claude invocation failed");
  return child.stdout;
}

function makeSaveDraftFn(account) {
  // Gmail vs Outlook draft scripts mirror the morning-brief delete dispatch.
  const script = account.provider === "gmail" ? "save-gmail-draft.js" : "save-draft.js";
  return async (accountId, draft) => {
    const child = spawnSync("node", [join(root, "scripts", script), accountId], {
      input: JSON.stringify(draft), encoding: "utf-8",
    });
    if (child.status !== 0) throw new Error(child.stderr || `save-draft failed for ${accountId}`);
    return JSON.parse(child.stdout);
  };
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
    fetchFn: async (accountId) => fetchSubprocess(accountId),
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
  const server = createApiServer({ store, ctxFor, getLastTickAt: () => lastTickAt, ackStore, clock: { now: () => new Date().toISOString() } });
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
