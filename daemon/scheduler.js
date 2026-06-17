/**
 * scheduler.js — one daemon tick. Pure orchestration over injected deps so it
 * tests without real connectors (mirrors scripts/morning-brief.js).
 *
 * deps: { accounts, typeConfigs, store, fetchFn(accountId), classifyFn(emails, account),
 *         clock:{now}, emit(event) }
 */
import { normalizeOwedRisk } from "./normalizers/owed-risk.js";
import { stageProposals } from "./proposals.js";

function flattenSourceEmails(classified, sourceCategories) {
  const out = [];
  for (const cat of sourceCategories) {
    const bucket = classified.categories?.[cat];
    if (bucket?.emails) out.push(...bucket.emails);
  }
  return out;
}

export async function runTick(deps) {
  const { accounts, typeConfigs, store, fetchFn, classifyFn, clock, emit } = deps;
  const prev = store.getModel();
  const prevItemsById = new Map(prev.items.map(i => [i.id, i]));
  const accountsState = { ...prev.accounts };
  const warnings = [];
  let nextItems = [];

  for (const account of accounts) {
    const jobRules = typeConfigs[account.accountType]?.jobTypes?.owed_risk;
    if (!jobRules) continue;
    let emails;
    try {
      emails = await fetchFn(account.id);
    } catch (err) {
      warnings.push(`[${account.id}] fetch failed: ${err.message}`);
      accountsState[account.id] = { status: "stale", lastTickAt: clock.now };
      // retain last-good items for this account
      nextItems.push(...prev.items.filter(i => i.account === account.id));
      continue;
    }
    const classified = classifyFn(emails, account);
    const sourceEmails = flattenSourceEmails(classified, jobRules.sourceCategories);
    const items = normalizeOwedRisk(sourceEmails, account, jobRules);
    // stamp lastChanged: keep prior timestamp if the item is unchanged
    for (const item of items) {
      const before = prevItemsById.get(item.id);
      const sameShape = before && JSON.stringify({ ...before, lastChanged: null }) === JSON.stringify({ ...item, lastChanged: null });
      item.lastChanged = sameShape ? before.lastChanged : clock.now;
    }
    nextItems.push(...items);
    accountsState[account.id] = { status: "ok", lastTickAt: clock.now };
  }

  const nextModel = { generatedAt: clock.now, accounts: accountsState, items: nextItems };

  // stage proposals for all items (per their account)
  let queue = store.getQueue();
  for (const account of accounts) {
    const accountItems = nextItems.filter(i => i.account === account.id);
    queue = stageProposals(accountItems, queue, account);
  }

  // diff: compare item sets ignoring lastChanged timestamps
  const norm = (m) => JSON.stringify(m.items.map(i => ({ ...i, lastChanged: null })));
  const changed = norm(prev) !== norm(nextModel);

  store.saveModel(nextModel);
  store.saveQueue(queue);
  if (changed) emit({ type: "update", at: clock.now });

  return { changed, warnings, itemCount: nextItems.length };
}
