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

// Two-click confirm: a button shows "Confirm <verb>?" when `confirm` equals its
// token, and a disabled "Working…" while `busy` equals its token (the action is
// in flight — prevents a double-submit during a long batch delete).
function confirmBtn({ cls, attr, value, extra = "", token, verb, confirm, busy, disabled = false }) {
  const isBusy = busy && busy === token;
  const armed = confirm && confirm === token;
  const label = isBusy ? "Working…" : (armed ? `Confirm ${verb}?` : verb[0].toUpperCase() + verb.slice(1));
  return `<button class="${cls}${armed ? " armed" : ""}" ${attr}="${esc(value)}"${extra} data-token="${esc(token)}"${(disabled || isBusy) ? " disabled" : ""}>${esc(label)}</button>`;
}

export function renderNoticeBar(notice) {
  if (!notice) return "";
  return `<div class="notice"><span>${esc(notice)}</span></div>`;
}

function actedBadge(a) {
  if (a.deleted && a.killed) return "Deleted + kill-listed";
  if (a.deleted) return "Deleted";
  if (a.killed) return "Kill-listed";
  return "Acted";
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

export function renderItemCard(item, nowMs = Date.now(), opts = {}) {
  const d = item.display || {};
  const confirm = opts.confirm || null;
  const busy = opts.busy || null;
  const members = item.group?.members || [];
  // Tile-level acted entries (keyed by item.id) are client-session state; after a
  // reload the server-hydrated map only has per-emailId entries. Fall back: the
  // tile is acted when EVERY member emailId has an acted entry, synthesizing the
  // badge shape from the member rows.
  let acted = (opts.acted || {})[item.id];
  if (!acted && members.length) {
    const rows = members.map(m => (opts.acted || {})[m.emailId]).filter(Boolean);
    if (rows.length === members.length) {
      acted = { deleted: rows.every(r => r.deleted), killed: rows.every(r => r.killed), account: item.account, emailIds: members.map(m => m.emailId), synthesized: true };
    }
  }
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

  const ids = members.map(m => m.emailId).filter(Boolean).join(",");
  const senders = [...new Set(members.map(m => m.from).filter(Boolean))];
  const delBtn = ids
    ? confirmBtn({ cls: "del", attr: "data-delete", value: item.account, extra: ` data-ids="${esc(ids)}"`, token: `del:tile:${item.id}`, verb: "delete", confirm, busy })
    : "";
  const killBtn = confirmBtn({ cls: "kill", attr: "data-killlist", value: item.account, extra: ` data-sender="${esc(senders[0] || "")}"`, token: `kill:tile:${item.id}`, verb: "kill list", confirm, busy, disabled: senders.length !== 1 });
  const delkillBtn = confirmBtn({ cls: "delkill", attr: "data-delkill", value: item.account, extra: ` data-ids="${esc(ids)}" data-sender="${esc(senders[0] || "")}"`, token: `delkill:tile:${item.id}`, verb: "Delete and Kill", confirm, busy, disabled: !ids || senders.length !== 1 });

  const when = relativeTime(d.latestDate, nowMs);
  const count = d.messageCount ?? members.length;
  const senderSub = [
    d.primarySender ? esc(d.primarySender) : "",
    count ? `${count} message${count === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
  const subline = (item.subtitle != null && item.subtitle !== "") ? esc(item.subtitle) : senderSub;

  // A synthesized tile entry has no ui.acted[item.id] for the tile Undo to hit —
  // omit the tile-level Undo; the detail-pane rows carry their own working Undo.
  const undoBtn = acted?.synthesized ? "" : `<button class="undo" data-undo-acted="${esc(item.id)}">Undo</button>`;
  const actions = acted
    ? `<span class="actedtag">${esc(actedBadge(acted))}</span>${undoBtn}`
    : `${approveBtn}${routeBtn}${ackBtn}${detailBtn}${delBtn}${killBtn}${delkillBtn}${dismissBtn}`;

  return `<div class="card ${esc(item.status)}${acted ? " acted" : ""}" data-item="${esc(item.id)}">`
    + `<label class="sel"><input type="checkbox" data-select="${esc(item.id)}"> select</label>`
    + `<div class="cardhdr"><span class="chip">${esc(CHIP_LABELS[item.jobType] || item.jobType || "")}</span>`
    + `${when ? `<span class="when">${esc(when)}</span>` : ""}</div>`
    + `<div class="title">${esc(item.title)}</div>`
    + `${subline ? `<div class="meta">${subline}</div>` : ""}`
    + `<div class="actions">${actions}</div></div>`;
}

export function renderAccountSection(group, collapsed, nowMs = Date.now(), opts = {}) {
  const need = group.atRiskCount || 0;
  const head = `<div class="sechdr" data-collapse="${esc(group.account)}">`
    + `<span class="chev">${collapsed ? "▸" : "▾"}</span>`
    + `<span class="seclabel">${esc(group.label || group.account)}</span>`
    + `<span class="sectype">${esc(group.accountType || "")}</span>`
    + `<span class="secneed">${esc(need)} need you</span></div>`;
  const body = collapsed ? "" : `<div class="list">${group.items.map(i => renderItemCard(i, nowMs, opts)).join("")}</div>`;
  return `<section class="acct">${head}${body}</section>`;
}

export function renderDetailPanel(item, nowMs = Date.now(), opts = {}) {
  if (!item) return "";
  const d = item.display || {};
  const g = item.group || {};
  const confirm = opts.confirm || null;
  const busy = opts.busy || null;
  const acted = opts.acted || {};
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

  const rawMembers = (g.members || []).slice();
  const members = rawMembers.slice()
    .sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
  const autoBodies = members.length <= 5;
  const clustered = item.jobType === "handled" || item.jobType === "triage";

  const bodyRegionFor = (m) => m.emailId
    ? (autoBodies
        ? `<div class="msgbody" data-body-for="${esc(m.emailId)}"><span class="bodyload">Loading…</span></div>`
        : `<button class="showbody" data-loadbody="${esc(m.emailId)}">Show message</button><div class="msgbody" data-body-for="${esc(m.emailId)}" hidden></div>`)
    : "";

  let msgs;
  if (clustered) {
    // Group from original member order so ids are stable/predictable; then sort rows newest-first within each group.
    const groups = new Map();
    for (const m of rawMembers) {
      const from = (m.from || "").toLowerCase();
      const key = from || "__unknown__";
      if (!groups.has(key)) groups.set(key, { from, label: m.fromName || m.from || "(unknown sender)", members: [] });
      groups.get(key).members.push(m);
    }
    const ordered = [...groups.values()].sort((a, b) => b.members.length - a.members.length);
    msgs = ordered.map(grp => {
      const ids = grp.members.map(m => m.emailId).filter(Boolean).join(",");
      const senderKey = (grp.from || "unknown").replace(/[^a-z0-9._@-]/gi, "_");
      const delAll = confirmBtn({ cls: "del", attr: "data-delete", value: item.account, extra: ` data-ids="${esc(ids)}"`, token: `del:cluster:${item.account}:${senderKey}`, verb: "delete all", confirm, busy, disabled: !ids });
      const killAll = confirmBtn({ cls: "kill", attr: "data-killlist", value: item.account, extra: ` data-ids="${esc(ids)}" data-sender="${esc(grp.from || "")}"`, token: `kill:cluster:${item.account}:${senderKey}`, verb: "kill list", confirm, busy, disabled: !grp.from });
      const dkAll = confirmBtn({ cls: "delkill", attr: "data-delkill", value: item.account, extra: ` data-ids="${esc(ids)}" data-sender="${esc(grp.from || "")}"`, token: `delkill:cluster:${item.account}:${senderKey}`, verb: "Delete and Kill", confirm, busy, disabled: !ids || !grp.from });
      const sortedRows = grp.members.slice().sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
      const rowsHtml = sortedRows.map(m => {
        const ma = acted[m.emailId];
        const when = relativeTime(m.receivedAt, nowMs);
        const tag = ma ? `<div class="msgactions"><span class="actedtag">${esc(actedBadge(ma))}</span><button class="undo" data-undo-acted="${esc(m.emailId)}">Undo</button></div>` : "";
        return `<div class="msg${ma ? " acted" : ""}"><div class="msgsub">${esc(m.subject || "(no subject)")}</div>`
          + `<div class="msgmeta">${esc(when)}</div>${tag}${bodyRegionFor(m)}</div>`;
      }).join("");
      return `<div class="sendergrp"><div class="sghdr"><span class="sgname">${esc(grp.label)} (${grp.members.length})</span>`
        + `<span class="sgactions">${delAll}${killAll}${dkAll}</span></div>${rowsHtml}</div>`;
    }).join("");
  } else {
    msgs = members.map(m => {
      const who = m.fromName || m.from || m.vendor || "";
      const when = relativeTime(m.receivedAt, nowMs);
      const ma = acted[m.emailId];
      const rowDel = m.emailId ? confirmBtn({ cls: "del", attr: "data-delete", value: item.account, extra: ` data-ids="${esc(m.emailId)}"`, token: `del:msg:${m.emailId}`, verb: "delete", confirm, busy }) : "";
      const rowKill = m.from ? confirmBtn({ cls: "kill", attr: "data-killlist", value: item.account, extra: ` data-sender="${esc(m.from)}"`, token: `kill:msg:${m.emailId || m.from}`, verb: "kill list", confirm, busy }) : "";
      const rowDelkill = (m.emailId && m.from) ? confirmBtn({ cls: "delkill", attr: "data-delkill", value: item.account, extra: ` data-ids="${esc(m.emailId)}" data-sender="${esc(m.from)}"`, token: `delkill:msg:${m.emailId}`, verb: "Delete and Kill", confirm, busy }) : "";
      const rowActions = ma
        ? `<span class="actedtag">${esc(actedBadge(ma))}</span><button class="undo" data-undo-acted="${esc(m.emailId)}">Undo</button>`
        : `${rowDel}${rowKill}${rowDelkill}`;
      return `<div class="msg${ma ? " acted" : ""}"><div class="msgsub">${esc(m.subject || "(no subject)")}</div>`
        + `<div class="msgmeta">${esc(who)}${who && when ? " · " : ""}${esc(when)}</div>`
        + `<div class="msgactions">${rowActions}</div>${bodyRegionFor(m)}</div>`;
    }).join("");
  }
  const moreNote = g.moreCount > 0 ? `<div class="dmore">+ ${esc(g.moreCount)} more not shown</div>` : "";

  const links = (item.source || [])
    .filter(s => s.kind === "url" && safeUrl(s.url))
    .map(s => `<a class="route" target="_blank" rel="noopener" href="${esc(s.url)}">↗ Open in system of record</a>`)
    .join("");

  return `<div class="backdrop" data-detail-close></div>`
    + `<aside class="detail" role="dialog" aria-label="Item detail">`
    + `<button class="detail-close" data-detail-close aria-label="Close">✕</button>`
    + `<div class="dtitle">${esc(item.title)}</div>`
    + `<div class="dmeta">${meta}</div>`
    + `<div class="dmsgs-h">Messages</div><div class="dmsgs">${msgs}</div>${moreNote}`
    + `${links ? `<div class="dlinks">${links}</div>` : ""}`
    + `</aside>`;
}

export function renderSelectControls(selectedCount) {
  return `<div class="bulk">
    <span>${esc(selectedCount)} selected</span>
    <button class="bulk-approve" data-bulk-approve ${selectedCount ? "" : "disabled"}>✓ Approve selected</button>
  </div>`;
}

export function renderUndoBar(undo) {
  if (!undo) return "";
  return `<div class="snackbar"><span class="snacklabel">${esc(undo.label)}</span>`
    + `<button class="undo" data-undo>Undo</button></div>`;
}

export function renderRunTriage(running, triage = {}) {
  const custom = triage.mode === "custom";
  const days = triage.days ?? 10;
  const btn = `<button class="runtriage" data-run-triage ${running ? "disabled" : ""}>${running ? "Running triage…" : "Run triage"}</button>`;
  const win = `<span class="triagewin">`
    + `<label><input type="radio" name="triagewin" data-triage-mode="default"${custom ? "" : " checked"}> default</label>`
    + `<label><input type="radio" name="triagewin" data-triage-mode="custom"${custom ? " checked" : ""}> last `
    + `<input type="number" id="triagedays" class="triagedays" min="1" max="365" value="${esc(days)}"${custom ? "" : " disabled"}> days</label>`
    + `</span>`;
  return btn + win;
}
