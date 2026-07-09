/**
 * app.js — thin DOM glue. Fetches /model, renders inbox-grouped sections via
 * render.js, live-reloads on SSE /events, posts actions, and drives the collapse,
 * slide-in detail, undo, two-click-confirm, and notice UI. No business logic here.
 */
import { toPanelView, filterItems, filterGroups, findItem } from "./view-model.js";
import { renderHeader, renderAccountSection, renderDetailPanel, renderSelectControls, renderUndoBar, renderNoticeBar, renderRunTriage, esc } from "./render.js";
import { toggle, pendingApprovalsFor } from "./selection.js";

const appEl = document.getElementById("app");
let lastModel = null;
const ui = { account: "", query: "", collapsed: new Set(), detailItemId: null, undo: null, confirm: null, busy: null, notice: null, triaging: false, triageMode: "default", triageDays: "10", acted: {} };
let selected = new Set();
const bodyCache = new Map(); // emailId -> { text } | { error }
let desiredDetailScroll = 0; // detail-pane scroll to preserve across re-renders + async body fills

function restoreDetailScroll() {
  const dp = appEl.querySelector("aside.detail");
  if (dp) dp.scrollTop = desiredDetailScroll;
}

async function load() {
  const model = await (await fetch("/model")).json();
  lastModel = model;
  draw();
}

function draw() {
  if (!lastModel) return;
  const now = Date.now();
  const view = toPanelView(lastModel);
  if (ui.detailItemId && !findItem(view, ui.detailItemId)) ui.detailItemId = null;

  const opts = { confirm: ui.confirm, busy: ui.busy, acted: ui.acted };
  const groups = filterGroups(view, ui);
  const sections = groups.map(g => renderAccountSection(g, ui.collapsed.has(g.account), now, opts)).join("");
  const detail = ui.detailItemId ? renderDetailPanel(findItem(view, ui.detailItemId), now, opts) : "";

  // Preserve the detail pane's internal scroll across re-renders. The bodies
  // that give the pane its height are filled by loadBodies (cached fills are
  // synchronous), so restore AFTER loadBodies — and loadBodies re-applies it
  // again once any async body fetch lands and the pane grows.
  desiredDetailScroll = appEl.querySelector("aside.detail")?.scrollTop || 0;

  appEl.innerHTML =
    renderHeader(view)
    + `<div class="filters"><input id="q" placeholder="filter…" value="${esc(ui.query)}">${renderRunTriage(ui.triaging, { mode: ui.triageMode, days: ui.triageDays })}</div>`
    + renderSelectControls(selected.size)
    + (sections || '<div class="empty">All clear.</div>')
    + detail
    + renderUndoBar(ui.undo)
    + renderNoticeBar(ui.notice);

  for (const id of selected) {
    const cb = appEl.querySelector(`[data-select="${CSS.escape(id)}"]`);
    if (cb) cb.checked = true;
  }
  if (ui.detailItemId) loadBodies(findItem(view, ui.detailItemId));
  restoreDetailScroll();
}

async function post(url) {
  await fetch(url, { method: "POST" });
  await load();
}

async function postJson(url, payload) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  return res.json();
}

function actThenOfferUndo(actionUrl, undo) {
  ui.undo = null;
  fetch(actionUrl, { method: "POST" })
    .then(() => load())
    .then(() => { ui.undo = undo; draw(); });
}

// Two-click confirm: first click arms (shows "Confirm …?"), second runs `go`.
// If `go` rejects (e.g. the daemon is down / a POST fails), reset the button and
// surface a notice instead of leaving it wedged on "Confirm?".
async function confirmThen(token, go) {
  if (ui.confirm === token) {
    // Second click: disarm, mark the action in flight, and repaint immediately so
    // the button shows a disabled "Working…" for the whole (possibly long, e.g. a
    // multi-batch delete) operation instead of appearing stuck on "Confirm …?".
    ui.confirm = null;
    ui.busy = token;
    draw();
    try { await go(); }
    catch (err) { ui.notice = `Action failed: ${err?.message || err}`; }
    finally { ui.busy = null; draw(); }
  } else {
    ui.confirm = token;
    draw();
  }
}

// Record an acted result. Cluster tokens (*:cluster:*) mark every member emailId
// so each row in the sender group dims; tile/msg tokens key by their single id.
function markActed(token, key, ids, patch) {
  if (token.includes(":cluster:")) {
    for (const id of ids) ui.acted[id] = { ...(ui.acted[id] || {}), ...patch, emailIds: [id] };
  } else {
    ui.acted[key] = { ...(ui.acted[key] || {}), ...patch };
  }
}

function fillBody(el, v) {
  el.textContent = v.error ? `⚠ ${v.error}` : (v.text || "(empty)");
}

function loadBodies(item) {
  if (!item) return;
  const members = item.group?.members || [];
  if (members.length > 5) return; // large tiles use click-to-expand (data-loadbody)
  for (const m of members) {
    const id = m.emailId;
    if (!id) continue;
    const el = appEl.querySelector(`[data-body-for="${CSS.escape(id)}"]`);
    if (!el) continue;
    if (bodyCache.has(id)) { fillBody(el, bodyCache.get(id)); continue; }
    fetch(`/messages/${encodeURIComponent(id)}/body?account=${encodeURIComponent(item.account)}`)
      .then(r => r.json())
      .then(d => { const v = d.ok === false ? { error: d.error || "error" } : { text: d.body || "" }; bodyCache.set(id, v); fillBody(el, v); restoreDetailScroll(); })
      .catch(() => { fillBody(el, { error: "Couldn't load body" }); restoreDetailScroll(); });
  }
}

appEl.addEventListener("click", (e) => {
  const u = e.target.closest("[data-undo]");
  if (u) { ui.confirm = null; ui.notice = null; if (ui.undo) { const url = ui.undo.undoUrl; ui.undo = null; post(url); } return; }
  const ua = e.target.closest("[data-undo-acted]");
  if (ua) {
    const key = ua.dataset.undoActed, a = ui.acted[key];
    if (!a) return;
    return void (async () => {
      ui.notice = null;
      try {
        if (a.deleted) { const r = await postJson("/messages/restore", { account: a.account, emailIds: a.emailIds }); if (r.ok === false) throw new Error(r.error); }
        if (a.killed) { const r = await postJson("/senders/killlist/remove", { account: a.account, sender: a.sender }); if (r.ok === false) throw new Error(r.error); }
        delete ui.acted[key]; ui.notice = "Undone"; await load();
      } catch (err) { ui.notice = `Undo failed: ${err.message}`; draw(); }
    })();
  }
  const del = e.target.closest("[data-delete]");
  if (del) {
    const token = del.dataset.token, account = del.dataset.delete, ids = (del.dataset.ids || "").split(",").filter(Boolean);
    const key = token.split(":").slice(2).join(":");
    return void confirmThen(token, async () => { ui.undo = null; ui.notice = null; const r = await postJson("/messages/delete", { account, emailIds: ids }); if (r.ok !== false) markActed(token, key, ids, { deleted: true, account, emailIds: ids }); ui.notice = r.ok === false ? `Delete failed: ${r.error}` : `Moved ${r.trashed} to Trash`; await load(); });
  }
  const kill = e.target.closest("[data-killlist]");
  if (kill) {
    const token = kill.dataset.token, account = kill.dataset.killlist, sender = kill.dataset.sender, ids = (kill.dataset.ids || "").split(",").filter(Boolean);
    const key = token.split(":").slice(2).join(":");
    return void confirmThen(token, async () => { ui.undo = null; ui.notice = null; const r = await postJson("/senders/killlist", { account, sender }); if (r.added) markActed(token, key, ids, { killed: true, account, sender }); ui.notice = r.added ? `Kill-listed ${sender}` : `Not kill-listed: ${r.reason || r.error}`; await load(); });
  }
  const dk = e.target.closest("[data-delkill]");
  if (dk) {
    const token = dk.dataset.token, account = dk.dataset.delkill, ids = (dk.dataset.ids || "").split(",").filter(Boolean), sender = dk.dataset.sender;
    const key = token.split(":").slice(2).join(":");
    return void confirmThen(token, async () => {
      ui.undo = null; ui.notice = null;
      const dr = await postJson("/messages/delete", { account, emailIds: ids });
      const kr = await postJson("/senders/killlist", { account, sender });
      const deleted = dr.ok !== false, killed = !!kr.added;
      if (deleted || killed) markActed(token, key, ids, { deleted, killed, account, emailIds: ids, sender });
      ui.notice = `Deleted ${dr.trashed ?? 0} · ${kr.added ? "kill-listed" : "kill-list: " + (kr.reason || kr.error)}`;
      await load();
    });
  }
  const lb = e.target.closest("[data-loadbody]");
  if (lb) {
    const id = lb.dataset.loadbody;
    const v = toPanelView(lastModel);
    const item = ui.detailItemId ? findItem(v, ui.detailItemId) : null;
    const account = item?.account;
    const el = appEl.querySelector(`[data-body-for="${CSS.escape(id)}"]`);
    if (el && account) {
      el.hidden = false;
      lb.remove();
      if (bodyCache.has(id)) { fillBody(el, bodyCache.get(id)); }
      else {
        el.textContent = "Loading…";
        fetch(`/messages/${encodeURIComponent(id)}/body?account=${encodeURIComponent(account)}`)
          .then(r => r.json())
          .then(d => { const val = d.ok === false ? { error: d.error || "error" } : { text: d.body || "" }; bodyCache.set(id, val); fillBody(el, val); })
          .catch(() => fillBody(el, { error: "Couldn't load body" }));
      }
    }
    return;
  }
  const tm = e.target.closest("[data-triage-mode]");
  if (tm) { ui.triageMode = tm.dataset.triageMode; draw(); return; }
  const rt = e.target.closest("[data-run-triage]");
  if (rt) {
    if (ui.triaging) return;
    ui.confirm = null; ui.undo = null;
    const days = ui.triageMode === "custom" ? Math.max(1, parseInt(ui.triageDays, 10) || 1) : null;
    const payload = days ? { lookbackHours: days * 24 } : {};
    ui.triaging = true; ui.notice = days ? `Running triage (last ${days}d)…` : "Running triage…"; draw();
    postJson("/actions/triage", payload).then(r => {
      ui.triaging = false;
      ui.notice = r.ok === false ? `Triage failed: ${r.error}` : "Triage complete";
      return load();
    }).catch(() => { ui.triaging = false; ui.notice = "Triage failed"; draw(); });
    return;
  }
  // any other action cancels an armed confirm + clears the notice
  ui.confirm = null; ui.notice = null;
  const a = e.target.closest("[data-approve]");
  if (a) { ui.undo = null; return void post(`/proposals/${encodeURIComponent(a.dataset.approve)}/approve`); }
  const d = e.target.closest("[data-dismiss]");
  if (d) { const id = d.dataset.dismiss; return void actThenOfferUndo(`/proposals/${encodeURIComponent(id)}/dismiss`, { label: "Dismissed", undoUrl: `/proposals/${encodeURIComponent(id)}/reopen` }); }
  const ack = e.target.closest("[data-ack]");
  if (ack) { const id = ack.dataset.ack; return void actThenOfferUndo(`/items/${encodeURIComponent(id)}/acknowledge?fp=${encodeURIComponent(ack.dataset.fp || "")}`, { label: "Acknowledged", undoUrl: `/items/${encodeURIComponent(id)}/unacknowledge` }); }
  const close = e.target.closest("[data-detail-close]");
  if (close) { ui.undo = null; ui.detailItemId = null; draw(); return; }
  const det = e.target.closest("[data-detail]");
  if (det) { ui.undo = null; ui.detailItemId = det.dataset.detail; draw(); return; }
  const col = e.target.closest("[data-collapse]");
  if (col) { ui.undo = null; ui.collapsed = toggle(ui.collapsed, col.dataset.collapse); draw(); return; }
  const s = e.target.closest("[data-select]");
  if (s) { ui.undo = null; selected = toggle(selected, s.dataset.select); draw(); return; }
  const bulk = e.target.closest("[data-bulk-approve]");
  if (bulk) {
    ui.undo = null;
    const view = toPanelView(lastModel);
    const ids = pendingApprovalsFor(filterItems(view, ui), selected);
    selected = new Set();
    return void (async () => { for (const id of ids) await fetch(`/proposals/${encodeURIComponent(id)}/approve`, { method: "POST" }); await load(); })();
  }
});

appEl.addEventListener("input", (e) => {
  if (e.target.id === "q") { ui.query = e.target.value; draw(); }
  // Store without redrawing so the field keeps focus while the user types.
  else if (e.target.id === "triagedays") { ui.triageDays = e.target.value; }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.detailItemId) { ui.detailItemId = null; draw(); }
});

const es = new EventSource("/events");
es.onmessage = () => load();
es.onerror = () => {};

load();
