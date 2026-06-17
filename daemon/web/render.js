/**
 * render.js — pure HTML-string builders for the panel. No DOM, no node APIs.
 * app.js injects these strings and wires events via data- attributes.
 */
export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function safeUrl(url) {
  return /^https?:\/\//i.test(String(url || "")) ? url : null;
}

export function renderHeader(view) {
  const stale = view.staleAccounts?.length
    ? `<div class="stale">⚠ couldn't refresh: ${view.staleAccounts.map(esc).join(", ")}</div>`
    : "";
  return `<div class="hdr"><span class="count">${esc(view.needsYouCount)}</span> need you`
    + ` <span class="sub">· ${esc(view.pendingCount)} pending</span>${stale}</div>`;
}

export function renderItemCard(item) {
  const pending = (item.proposals || []).find(p => p.state === "pending");
  const routeUrl = safeUrl((item.source || []).find(s => s.kind === "url")?.url);
  const approveBtn = pending
    ? `<button class="approve" data-approve="${esc(pending.id)}">✓ Approve ${esc(pending.action)}</button>`
    : "";
  const dismissBtn = pending
    ? `<button class="dismiss" data-dismiss="${esc(pending.id)}">dismiss</button>` : "";
  const routeBtn = routeUrl
    ? `<a class="route" target="_blank" rel="noopener" href="${esc(routeUrl)}" data-route="${esc(routeUrl)}">↗ Open</a>` : "";
  const members = (item.group?.members || []).map(m => esc(m.vendor)).join(", ");
  return `<div class="card ${esc(item.status)}" data-item="${esc(item.id)}">`
    + `<label class="sel"><input type="checkbox" data-select="${esc(item.id)}"> select</label>`
    + `<div class="title">${esc(item.title)}</div>`
    + `<div class="meta">${esc(item.group?.rootCause || "")} · ${members}</div>`
    + `<div class="actions">${approveBtn}${routeBtn}${dismissBtn}</div></div>`;
}

export function renderSelectControls(selectedCount) {
  return `<div class="bulk">
    <span>${esc(selectedCount)} selected</span>
    <button class="bulk-approve" data-bulk-approve ${selectedCount ? "" : "disabled"}>✓ Approve selected</button>
  </div>`;
}
