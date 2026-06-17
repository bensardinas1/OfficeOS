/**
 * view-model.js — pure transforms from /model JSON into a render-ready view.
 * Imported by both the Node tests and the browser panel, so it must not use
 * any node: APIs.
 */
export function toPanelView(model) {
  const proposalsByItem = new Map();
  for (const p of model.proposals || []) {
    if (!proposalsByItem.has(p.itemId)) proposalsByItem.set(p.itemId, []);
    proposalsByItem.get(p.itemId).push(p);
  }
  const items = (model.items || []).map(i => ({ ...i, proposals: proposalsByItem.get(i.id) || [] }));

  const byAccount = new Map();
  for (const it of items) {
    if (!byAccount.has(it.account)) byAccount.set(it.account, []);
    byAccount.get(it.account).push(it);
  }
  const groups = [...byAccount.entries()].map(([account, accountItems]) => ({
    account,
    status: model.accounts?.[account]?.status || "ok",
    items: accountItems,
  }));

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

/**
 * Flatten + filter the view's items for the workbench.
 * @param {object} view  output of toPanelView
 * @param {object} opts  { account?, jobType?, query? }
 */
export function filterItems(view, opts = {}) {
  const all = view.groups.flatMap(g => g.items);
  const q = (opts.query || "").toLowerCase();
  return all.filter(i =>
    (!opts.account || i.account === opts.account) &&
    (!opts.jobType || i.jobType === opts.jobType) &&
    (!q || `${i.title} ${i.group?.rootCause || ""}`.toLowerCase().includes(q))
  );
}
