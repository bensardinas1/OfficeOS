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

// Human labels for raw internal ids. Approve falls back to "Approve <action>"
// for any future action; the chip falls back to the raw jobType.
const ACTION_LABELS = { draft_chase: "Draft a follow-up email" };
const CHIP_LABELS = { handled: "summary" };

export function renderItemCard(item, nowMs = Date.now()) {
  const d = item.display || {};
  const pending = (item.proposals || []).find(p => p.state === "pending");
  const routeUrl = safeUrl((item.source || []).find(s => s.kind === "url")?.url);
  const approveBtn = pending
    ? `<button class="approve" data-approve="${esc(pending.id)}">✓ ${esc(ACTION_LABELS[pending.action] || `Approve ${pending.action}`)}</button>` : "";
  const dismissBtn = pending
    ? `<button class="dismiss" data-dismiss="${esc(pending.id)}">dismiss</button>` : "";
  const routeBtn = routeUrl
    ? `<a class="route" target="_blank" rel="noopener" href="${esc(routeUrl)}" data-route="${esc(routeUrl)}">↗ Open</a>` : "";
  const ackBtn = (item.acknowledgeable && !item.acknowledged)
    ? `<button class="ack" data-ack="${esc(item.id)}" data-fp="${esc(item.fingerprint || "")}">Acknowledge</button>` : "";
  const detailBtn = `<button class="detail" data-detail="${esc(item.id)}">Details</button>`;

  const when = relativeTime(d.latestDate, nowMs);
  const count = d.messageCount ?? (item.group?.members || []).length;
  const senderSub = [
    d.primarySender ? esc(d.primarySender) : "",
    count ? `${count} message${count === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
  // A normalizer may supply an explicit subtitle (e.g. the handled summary's
  // secondary count); otherwise fall back to the sender · count line.
  const subline = (item.subtitle != null && item.subtitle !== "") ? esc(item.subtitle) : senderSub;

  return `<div class="card ${esc(item.status)}" data-item="${esc(item.id)}">`
    + `<label class="sel"><input type="checkbox" data-select="${esc(item.id)}"> select</label>`
    + `<div class="cardhdr"><span class="chip">${esc(CHIP_LABELS[item.jobType] || item.jobType || "")}</span>`
    + `${when ? `<span class="when">${esc(when)}</span>` : ""}</div>`
    + `<div class="title">${esc(item.title)}</div>`
    + `${subline ? `<div class="meta">${subline}</div>` : ""}`
    + `<div class="actions">${approveBtn}${routeBtn}${ackBtn}${detailBtn}${dismissBtn}</div></div>`;
}

export function renderAccountSection(group, collapsed, nowMs = Date.now()) {
  const need = group.atRiskCount || 0;
  const head = `<div class="sechdr" data-collapse="${esc(group.account)}">`
    + `<span class="chev">${collapsed ? "▸" : "▾"}</span>`
    + `<span class="seclabel">${esc(group.label || group.account)}</span>`
    + `<span class="sectype">${esc(group.accountType || "")}</span>`
    + `<span class="secneed">${esc(need)} need you</span></div>`;
  const body = collapsed ? "" : `<div class="list">${group.items.map(i => renderItemCard(i, nowMs)).join("")}</div>`;
  return `<section class="acct">${head}${body}</section>`;
}

export function renderDetailPanel(item, nowMs = Date.now()) {
  if (!item) return "";
  const d = item.display || {};
  const g = item.group || {};
  const statusLabel = item.status === "at_risk" ? "at risk" : (item.acknowledged ? "acknowledged" : "ok");
  const rows = [
    ["Inbox", d.accountLabel || item.account],
    ["Root cause", g.rootCause || ""],
    ["Status", statusLabel],
  ];
  if (g.merchant) rows.push(["Merchant", g.merchant]);
  if (g.gwId) rows.push(["Gateway ID", g.gwId]);
  if (g.severity) rows.push(["Severity", g.severity]);
  const meta = rows.map(([k, v]) =>
    `<div class="drow"><span class="dk">${esc(k)}</span><span class="dv">${esc(v)}</span></div>`).join("");

  const members = (g.members || []).slice()
    .sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
  const msgs = members.map(m => {
    const who = m.fromName || m.from || m.vendor || "";
    const when = relativeTime(m.receivedAt, nowMs);
    const bodySlot = m.emailId
      ? `<div class="msgbody" data-body-for="${esc(m.emailId)}"><span class="bodyload">Loading…</span></div>`
      : "";
    return `<div class="msg"><div class="msgsub">${esc(m.subject || "(no subject)")}</div>`
      + `<div class="msgmeta">${esc(who)}${who && when ? " · " : ""}${esc(when)}</div>`
      + `${bodySlot}</div>`;
  }).join("");

  const links = (item.source || [])
    .filter(s => s.kind === "url" && safeUrl(s.url))
    .map(s => `<a class="route" target="_blank" rel="noopener" href="${esc(s.url)}">↗ Open in system of record</a>`)
    .join("");

  return `<div class="backdrop" data-detail-close></div>`
    + `<aside class="detail" role="dialog" aria-label="Item detail">`
    + `<button class="detail-close" data-detail-close aria-label="Close">✕</button>`
    + `<div class="dtitle">${esc(item.title)}</div>`
    + `<div class="dmeta">${meta}</div>`
    + `<div class="dmsgs-h">Messages</div><div class="dmsgs">${msgs}</div>`
    + `${links ? `<div class="dlinks">${links}</div>` : ""}`
    + `</aside>`;
}

export function renderSelectControls(selectedCount) {
  return `<div class="bulk">
    <span>${esc(selectedCount)} selected</span>
    <button class="bulk-approve" data-bulk-approve ${selectedCount ? "" : "disabled"}>✓ Approve selected</button>
  </div>`;
}
