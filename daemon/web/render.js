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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Deterministic relative-time label. nowMs is injected so tests don't depend on the clock. */
export function relativeTime(iso, nowMs) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(then);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
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
  const ackBtn = (item.acknowledgeable && !item.acknowledged)
    ? `<button class="ack" data-ack="${esc(item.id)}" data-fp="${esc(item.fingerprint || "")}">Acknowledge</button>` : "";
  // members differ by job: owed_risk has `vendor`, gateway has `subject`. Fall back so
  // the meta line is never a row of empty commas.
  const members = (item.group?.members || []).map(m => esc(m.vendor || m.subject || "")).filter(Boolean).join(", ");
  return `<div class="card ${esc(item.status)}" data-item="${esc(item.id)}">`
    + `<label class="sel"><input type="checkbox" data-select="${esc(item.id)}"> select</label>`
    + `<div class="title">${esc(item.title)}</div>`
    + `<div class="meta">${esc(item.group?.rootCause || "")} · ${members}</div>`
    + `<div class="actions">${approveBtn}${routeBtn}${ackBtn}${dismissBtn}</div></div>`;
}

export function renderSelectControls(selectedCount) {
  return `<div class="bulk">
    <span>${esc(selectedCount)} selected</span>
    <button class="bulk-approve" data-bulk-approve ${selectedCount ? "" : "disabled"}>✓ Approve selected</button>
  </div>`;
}
