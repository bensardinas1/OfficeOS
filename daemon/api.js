/**
 * api.js — localhost REST + SSE for the daemon. Binds 127.0.0.1 only.
 *
 * Routes:
 *   GET  /health                     -> { ok, lastTickAt }
 *   GET  /model                      -> { ...model, proposals }
 *   GET  /events                     -> SSE stream; emits "update" on tick diffs
 *   POST /proposals/:id/approve      -> transition->approved, run executor, ->executed/failed
 *   POST /proposals/:id/dismiss      -> transition->dismissed
 *
 * Dependencies are injected:
 *   store        createStore(dataDir)
 *   ctxFor(p)    -> executor context { account, saveDraftFn } for a proposal
 *   getLastTickAt() -> ISO string | null
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutor } from "./executors/index.js";
import { transition } from "./proposals.js";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
const DEFAULT_WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function createApiServer(deps) {
  const { store, ctxFor, getLastTickAt, webDir = DEFAULT_WEB_DIR, ackStore, clock, accounts = [], fetchBodyFn } = deps;
  const sseClients = new Set();

  async function approve(id, res) {
    const queue = store.getQueue();
    const proposal = queue.proposals.find(p => p.id === id);
    if (!proposal) return send(res, 404, { error: "proposal not found" });
    let updated;
    try {
      const approved = transition(proposal, "approve");
      const exec = resolveExecutor(approved.action);
      const result = await exec(approved, ctxFor(approved));
      updated = transition(approved, "executed");
      persist(queue, id, updated);
      return send(res, 200, { proposal: updated, result });
    } catch (err) {
      updated = { ...proposal, state: "failed", error: err.message };
      persist(queue, id, updated);
      return send(res, 200, { proposal: updated, error: err.message });
    }
  }

  function dismiss(id, res) {
    const queue = store.getQueue();
    const proposal = queue.proposals.find(p => p.id === id);
    if (!proposal) return send(res, 404, { error: "proposal not found" });
    const updated = transition(proposal, "dismiss");
    persist(queue, id, updated);
    return send(res, 200, { proposal: updated });
  }

  function reopen(id, res) {
    const queue = store.getQueue();
    const proposal = queue.proposals.find(p => p.id === id);
    if (!proposal) return send(res, 404, { error: "proposal not found" });
    const updated = transition(proposal, "reopen");
    persist(queue, id, updated);
    return send(res, 200, { proposal: updated });
  }

  function persist(queue, id, updated) {
    queue.proposals = queue.proposals.map(p => (p.id === id ? updated : p));
    store.saveQueue(queue);
  }

  function broadcast(event) {
    for (const res of sseClients) res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  function serveStatic(pathname, res) {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const full = normalize(join(webDir, rel));
    const root = normalize(webDir);
    if (full !== root && !full.startsWith(root + sep)) return send(res, 404, { error: "not found" });
    if (!existsSync(full) || !statSync(full).isFile()) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[extname(full).toLowerCase()] || "application/octet-stream" });
    res.end(readFileSync(full));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      return send(res, 200, { ok: true, lastTickAt: getLastTickAt?.() ?? null });
    }
    if (req.method === "GET" && path === "/model") {
      const model = store.getModel();
      return send(res, 200, { ...model, proposals: store.getQueue().proposals });
    }
    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    const bodyMatch = path.match(/^\/messages\/([^/]+)\/body$/);
    if (req.method === "GET" && bodyMatch) {
      const emailId = decodeURIComponent(bodyMatch[1]);
      const account = url.searchParams.get("account") || "";
      if (!accounts.some(a => a.id === account)) return send(res, 400, { error: "unknown or missing account" });
      try {
        const out = await fetchBodyFn(account, emailId);
        return send(res, 200, { id: emailId, body: out.body || "" });
      } catch (err) {
        return send(res, 200, { ok: false, error: err.message });
      }
    }
    const approveMatch = path.match(/^\/proposals\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) return approve(decodeURIComponent(approveMatch[1]), res);
    const dismissMatch = path.match(/^\/proposals\/([^/]+)\/dismiss$/);
    if (req.method === "POST" && dismissMatch) return dismiss(decodeURIComponent(dismissMatch[1]), res);
    const reopenMatch = path.match(/^\/proposals\/([^/]+)\/reopen$/);
    if (req.method === "POST" && reopenMatch) return reopen(decodeURIComponent(reopenMatch[1]), res);

    const ackMatch = path.match(/^\/items\/([^/]+)\/acknowledge$/);
    if (req.method === "POST" && ackMatch) {
      const id = decodeURIComponent(ackMatch[1]);
      const fp = url.searchParams.get("fp") || "";
      ackStore?.recordAck(id, fp, clock?.now ? clock.now() : new Date().toISOString());
      return send(res, 200, { ok: true, itemId: id });
    }
    const unackMatch = path.match(/^\/items\/([^/]+)\/unacknowledge$/);
    if (req.method === "POST" && unackMatch) {
      const id = decodeURIComponent(unackMatch[1]);
      ackStore?.removeAck(id);
      return send(res, 200, { ok: true, itemId: id });
    }

    if (req.method === "GET") return serveStatic(path, res);
    return send(res, 404, { error: "not found" });
  });

  server.broadcastUpdate = (event) => broadcast(event ?? { type: "update" });
  return server;
}
