/**
 * api.js — localhost REST + SSE for the daemon. Binds 127.0.0.1 only.
 *
 * Routes:
 *   GET  /health                     -> { ok, lastTickAt, pid, startedAt }
 *   GET  /model                      -> { ...model, proposals }
 *   GET  /actions?days=7             -> { acted: <derived map>, entries: [...] } from the action audit log
 *   GET  /events                     -> SSE stream; emits "update" on tick diffs
 *   POST /proposals/:id/approve      -> transition->approved, run executor, ->executed/failed
 *   POST /proposals/:id/dismiss      -> transition->dismissed
 *   POST /senders/delete-all         -> soft-delete all messages from a sender (bounded by sinceHours)
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
import { deriveActed } from "./action-log.js";

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

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

// entryId is only surfaced when the audit line actually hit disk — otherwise
// the client treats the action as session-only instead of server-backed
// (prevents acted state vanishing on the next /actions reconcile).
function entryIdOf(entry) {
  return entry && entry.persisted !== false ? { entryId: entry.id } : {};
}

export function createApiServer(deps) {
  const { store, ctxFor, getLastTickAt, webDir = DEFAULT_WEB_DIR, ackStore, clock, accounts = [], fetchBodyFn, deleteFn, killlistFn, runTriageFn, onTriage, restoreFn, killlistRemoveFn, deleteBySenderFn, actionLog, startedAt } = deps;
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

  // One shape for mutate→audit→respond. See entryIdOf() above for why entryId
  // can be omitted.
  async function withAudit(res, base, exec) {
    try {
      const result = await exec();
      const entryBase = (!base.emailIds && Array.isArray(result?.emailIds)) ? { ...base, emailIds: result.emailIds } : base;
      const entry = actionLog?.append({ ...entryBase, result });
      return send(res, 200, { ...result, ...entryIdOf(entry) });
    } catch (err) {
      const entry = actionLog?.append({ ...base, result: { error: err.message } });
      return send(res, 200, { ok: false, error: err.message, ...entryIdOf(entry) });
    }
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
      return send(res, 200, { ok: true, lastTickAt: getLastTickAt?.() ?? null, pid: process.pid, startedAt: startedAt ?? null });
    }
    if (req.method === "GET" && path === "/model") {
      const model = store.getModel();
      return send(res, 200, { ...model, proposals: store.getQueue().proposals });
    }
    if (req.method === "GET" && path === "/actions") {
      const days = Number(url.searchParams.get("days")) || 7;
      const entries = actionLog?.recent({ days }) ?? [];
      return send(res, 200, { acted: deriveActed(entries), entries });
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

    if (req.method === "POST" && path === "/messages/delete") {
      const body = await readJson(req);
      const account = body?.account, ids = body?.emailIds;
      if (!accounts.some(a => a.id === account) || !Array.isArray(ids) || ids.length === 0) return send(res, 400, { error: "account and non-empty emailIds required" });
      const base = { action: "delete", account, emailIds: ids, ...(body?.undoOf ? { undoOf: body.undoOf } : {}) };
      return withAudit(res, base, () => deleteFn(account, ids));
    }
    if (req.method === "POST" && path === "/senders/killlist") {
      const body = await readJson(req);
      const account = body?.account, sender = body?.sender;
      if (!accounts.some(a => a.id === account) || !sender) return send(res, 400, { error: "account and sender required" });
      const base = { action: "killlist_add", account, sender, emailIds: body?.emailIds || [], ...(body?.undoOf ? { undoOf: body.undoOf } : {}) };
      return withAudit(res, base, () => killlistFn(account, sender));
    }
    if (req.method === "POST" && path === "/senders/delete-all") {
      const body = await readJson(req);
      const account = body?.account, sender = body?.sender;
      if (!accounts.some(a => a.id === account) || !sender) return send(res, 400, { error: "account and sender required" });
      const raw = Number(body?.sinceHours);
      const sinceHours = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 8760) : 720;
      const base = { action: "delete", account, bySender: sender, ...(body?.undoOf ? { undoOf: body.undoOf } : {}) };
      return withAudit(res, base, () => deleteBySenderFn(account, sender, { sinceHours }));
    }
    if (req.method === "POST" && path === "/actions/triage") {
      const body = await readJson(req);
      // Optional lookback override (hours). Clamp to a sane range so the UI can't
      // request an absurd window; falsy → connector default.
      const rawHours = Number(body?.lookbackHours);
      const lookbackHours = Number.isFinite(rawHours) && rawHours > 0 ? Math.min(rawHours, 8760) : null;
      try {
        const r = await runTriageFn(body?.account || null, lookbackHours);
        if (onTriage) await onTriage();
        const entry = actionLog?.append({ action: "triage", account: body?.account || null, result: { ok: true, lookbackHours } });
        return send(res, 200, { ok: true, ...r, ...entryIdOf(entry) });
      } catch (err) {
        const entry = actionLog?.append({ action: "triage", account: body?.account || null, result: { error: err.message } });
        return send(res, 200, { ok: false, error: err.message, ...entryIdOf(entry) });
      }
    }
    if (req.method === "POST" && path === "/messages/restore") {
      const body = await readJson(req);
      const account = body?.account, ids = body?.emailIds;
      if (!accounts.some(a => a.id === account) || !Array.isArray(ids) || ids.length === 0) return send(res, 400, { error: "account and non-empty emailIds required" });
      const base = { action: "restore", account, emailIds: ids, ...(body?.undoOf ? { undoOf: body.undoOf } : {}) };
      return withAudit(res, base, () => restoreFn(account, ids));
    }
    if (req.method === "POST" && path === "/senders/killlist/remove") {
      const body = await readJson(req);
      const account = body?.account, sender = body?.sender;
      if (!accounts.some(a => a.id === account) || !sender) return send(res, 400, { error: "account and sender required" });
      const base = { action: "killlist_remove", account, sender, ...(body?.undoOf ? { undoOf: body.undoOf } : {}) };
      return withAudit(res, base, () => killlistRemoveFn(account, sender));
    }

    if (req.method === "GET") return serveStatic(path, res);
    return send(res, 404, { error: "not found" });
  });

  server.broadcastUpdate = (event) => broadcast(event ?? { type: "update" });
  return server;
}
