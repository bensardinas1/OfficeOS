/**
 * app.js — thin DOM glue. Fetches /model, renders via render.js, live-reloads
 * on SSE /events, and posts approve/dismiss. No business logic lives here.
 */
import { toPanelView, filterItems } from "./view-model.js";
import { renderHeader, renderItemCard, renderSelectControls, esc } from "./render.js";
import { toggle, pendingApprovalsFor } from "./selection.js";

const appEl = document.getElementById("app");
let lastModel = null;
const ui = { account: "", query: "" };
let selected = new Set();

async function load() {
  const model = await (await fetch("/model")).json();
  lastModel = model;
  draw();
}

function draw() {
  if (!lastModel) return;
  const view = toPanelView(lastModel);
  const items = filterItems(view, ui);
  appEl.innerHTML =
    renderHeader(view)
    + `<div class="filters"><input id="q" placeholder="filter…" value="${esc(ui.query)}"></div>`
    + renderSelectControls(selected.size)
    + `<div class="list">${items.map(renderItemCard).join("") || '<div class="empty">All clear.</div>'}</div>`;
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

const es = new EventSource("/events");
es.onmessage = () => load();
es.onerror = () => {};

load();
