/**
 * view-model.js — pure transforms from /model JSON into a render-ready view.
 * Imported by both the Node tests and the browser panel, so it must not use
 * any node: APIs.
 */

/** Per-tile display fields derived purely from an item's members + account meta. */
function deriveDisplay(item, accounts) {
  const members = item.group?.members || [];
  let latestDate = null;
  const counts = new Map();
  let primarySender = null, top = 0;
  for (const m of members) {
    if (m.receivedAt && (!latestDate || m.receivedAt > latestDate)) latestDate = m.receivedAt;
    const name = (item.jobType === "owed_risk" ? (m.vendor || m.fromName || m.from) : (m.fromName || m.from)) || null;
    if (name) {
      const n = (counts.get(name) || 0) + 1;
      counts.set(name, n);
      if (n > top) { top = n; primarySender = name; } // strict > keeps the first on ties
    }
  }
  const acct = accounts?.[item.account] || {};
  return {
    primarySender,
    latestDate,
    messageCount: members.length,
    accountLabel: acct.label || item.account,
    accountType: acct.accountType || null,
  };
}

export function toPanelView(model) {
  const proposalsByItem = new Map();
  for (const p of model.proposals || []) {
    if (!proposalsByItem.has(p.itemId)) proposalsByItem.set(p.itemId, []);
    proposalsByItem.get(p.itemId).push(p);
  }
  const items = (model.items || []).map(i => ({
    ...i,
    proposals: proposalsByItem.get(i.id) || [],
    display: deriveDisplay(i, model.accounts),
  }));

  const byAccount = new Map();
  for (const it of items) {
    if (!byAccount.has(it.account)) byAccount.set(it.account, []);
    byAccount.get(it.account).push(it);
  }
  const groups = [...byAccount.entries()].map(([account, accountItems]) => {
    const acct = model.accounts?.[account] || {};
    return {
      account,
      label: acct.label || account,
      accountType: acct.accountType || null,
      status: acct.status || "ok",
      atRiskCount: accountItems.filter(i => i.status === "at_risk").length,
      items: accountItems,
    };
  });
  groups.sort((a, b) =>
    b.atRiskCount - a.atRiskCount ||
    (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));

  const staleAccounts = Object.entries(model.accounts || {})
    .filter(([, s]) => s.status === "stale").map(([id]) => id);

  return {
    generatedAt: model.generatedAt || null,
    needsYouCount: items.filter(i => i.status === "at_risk").length,
    pendingCount: (model.proposals || []).filter(p => p.state === "pending").length,
    groups,
    staleAccounts,
  };
}

/** Predicate shared by filterGroups/filterItems so a new axis is added in one place. */
function matchesFilter(item, opts, q) {
  return (!opts.account || item.account === opts.account) &&
    (!opts.jobType || item.jobType === opts.jobType) &&
    (!q || `${item.title} ${item.group?.rootCause || ""}`.toLowerCase().includes(q));
}

/** Groups with items filtered; groups left empty are dropped. */
export function filterGroups(view, opts = {}) {
  const q = (opts.query || "").toLowerCase();
  return view.groups
    .map(g => ({ ...g, items: g.items.filter(i => matchesFilter(i, opts, q)) }))
    .filter(g => g.items.length > 0);
}

/** Flat list of matching items — used by bulk-approve selection. */
export function filterItems(view, opts = {}) {
  return filterGroups(view, opts).flatMap(g => g.items);
}

/** Locate an item (with its derived display) across all groups by id. */
export function findItem(view, id) {
  for (const g of view.groups) {
    const hit = g.items.find(i => i.id === id);
    if (hit) return hit;
  }
  return null;
}
