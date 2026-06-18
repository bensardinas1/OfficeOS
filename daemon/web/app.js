/**
 * app.js — thin DOM glue. Fetches /model, renders inbox-grouped sections via
 * render.js, live-reloads on SSE /events, posts approve/dismiss/ack, and drives
 * the collapse + slide-in detail UI. No business logic lives here.
 */
import { toPanelView, filterItems, filterGroups, findItem } from "./view-model.js";
import { renderHeader, renderAccountSection, renderDetailPanel, renderSelectControls, esc } from "./render.js";
import { toggle, pendingApprovalsFor } from "./selection.js";

const appEl = document.getElementById("app");
let lastModel = null;
const ui = { account: "", query: "", collapsed: new Set(), detailItemId: null };
let selected = new Set();

async function load() {
  const model = await (await fetch("/model")).json();
  lastModel = model;
  draw();
}

function draw() {
  if (!lastModel) return;
  const now = Date.now();
  const view = toPanelView(lastModel);

  // auto-close the detail panel if its item vanished (resolved/acked away)
  if (ui.detailItemId && !findItem(view, ui.detailItemId)) ui.detailItemId = null;

  const groups = filterGroups(view, ui);
  const sections = groups.map(g => renderAccountSection(g, ui.collapsed.has(g.account), now)).join("");
  const detail = ui.detailItemId ? renderDetailPanel(findItem(view, ui.detailItemId), now) : "";

  appEl.innerHTML =
    renderHeader(view)
    + `<div class="filters"><input id="q" placeholder="filter…" value="${esc(ui.query)}"></div>`
    + renderSelectControls(selected.size)
    + (sections || '<div class="empty">All clear.</div>')
    + detail;

  for (const id of selected) {
    const cb = appEl.querySelector(`[data-select="${CSS.escape(id)}"]`);
    if (cb) cb.checked = true;
  }
}

async function post(url) {
  await fetch(url, { method: "POST" });
  await load();
}

appEl.addEventListener("click", (e) => {
  const a = e.target.closest("[data-approve]");
  if (a) return void post(`/proposals/${encodeURIComponent(a.dataset.approve)}/approve`);
  const d = e.target.closest("[data-dismiss]");
  if (d) return void post(`/proposals/${encodeURIComponent(d.dataset.dismiss)}/dismiss`);
  const ack = e.target.closest("[data-ack]");
  if (ack) return void post(`/items/${encodeURIComponent(ack.dataset.ack)}/acknowledge?fp=${encodeURIComponent(ack.dataset.fp || "")}`);
  const close = e.target.closest("[data-detail-close]");
  if (close) { ui.detailItemId = null; draw(); return; }
  const det = e.target.closest("[data-detail]");
  if (det) { ui.detailItemId = det.dataset.detail; draw(); return; }
  const col = e.target.closest("[data-collapse]");
  if (col) { ui.collapsed = toggle(ui.collapsed, col.dataset.collapse); draw(); return; }
  const s = e.target.closest("[data-select]");
  if (s) { selected = toggle(selected, s.dataset.select); draw(); return; }
  const bulk = e.target.closest("[data-bulk-approve]");
  if (bulk) {
    const view = toPanelView(lastModel);
    const ids = pendingApprovalsFor(filterItems(view, ui), selected);
    selected = new Set();
    return void (async () => { for (const id of ids) await fetch(`/proposals/${encodeURIComponent(id)}/approve`, { method: "POST" }); await load(); })();
  }
});

appEl.addEventListener("input", (e) => {
  if (e.target.id === "q") { ui.query = e.target.value; draw(); }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.detailItemId) { ui.detailItemId = null; draw(); }
});

const es = new EventSource("/events");
es.onmessage = () => load();
es.onerror = () => {};

load();
