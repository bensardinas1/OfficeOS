/**
 * scheduler.js — one daemon tick. Pure orchestration over injected deps so it
 * tests without real connectors (mirrors scripts/morning-brief.js).
 *
 * deps: { accounts, typeConfigs, store, fetchFn(accountId), classifyFn(emails, account),
 *         clock:{now}, emit(event) }
 */
import { runNormalizers } from "./normalizers/index.js";
import { stageProposals } from "./proposals.js";
import { fingerprint, applyAcks } from "./acknowledge.js";

export async function runTick(deps) {
  const { accounts, typeConfigs, store, fetchFn, classifyFn, clock, emit } = deps;
  const prev = store.getModel();
  const prevItemsById = new Map(prev.items.map(i => [i.id, i]));
  const accountsState = { ...prev.accounts };
  const warnings = [];
  const staleFlips = [];
  let nextItems = [];

  for (const account of accounts) {
    const typeConfig = typeConfigs[account.accountType];
    const acctMeta = { label: account.label || account.name || account.id, accountType: account.accountType };
    if (!typeConfig?.jobTypes) continue;

    // folder -> max lookbackHours across jobs using it
    const folderHours = {};
    for (const jcfg of Object.values(typeConfig.jobTypes)) {
      const lb = jcfg.lookbackHours || 168;
      for (const f of (jcfg.folders || ["inbox"])) folderHours[f] = Math.max(folderHours[f] || 168, lb);
    }

    const classifiedByFolder = {};
    let inboxFailed = false;
    for (const [folder, hrs] of Object.entries(folderHours)) {
      try {
        const emails = await fetchFn(account.id, folder, hrs);
        classifiedByFolder[folder] = classifyFn(emails, account);
      } catch (err) {
        warnings.push(`[${account.id}/${folder}] fetch failed: ${err.message}`);
        classifiedByFolder[folder] = { categories: {} };
        if (folder === "inbox") inboxFailed = true;
      }
    }

    if (inboxFailed) {
      const wasStale = prev.accounts?.[account.id]?.status === "stale";
      if (!wasStale) staleFlips.push(account.id);
      accountsState[account.id] = { status: "stale", lastTickAt: clock.now, ...acctMeta };
      // retain last-good items for this account
      nextItems.push(...prev.items.filter(i => i.account === account.id));
      continue;
    }

    const items = await runNormalizers(classifiedByFolder, account, typeConfig, { reasonerFn: deps.reasonerFn, nowMs: Date.parse(clock.now), pendingDeletions: deps.getPendingDeletions ? deps.getPendingDeletions() : null });
    // stamp lastChanged: keep prior timestamp if the item is unchanged
    for (const item of items) {
      const before = prevItemsById.get(item.id);
      const sameShape = before && JSON.stringify({ ...before, lastChanged: null }) === JSON.stringify({ ...item, lastChanged: null });
      item.lastChanged = sameShape ? before.lastChanged : clock.now;
    }
    nextItems.push(...items);
    accountsState[account.id] = { status: "ok", lastTickAt: clock.now, ...acctMeta };
  }

  for (const item of nextItems) item.fingerprint = fingerprint(item);
  const acks = deps.getAcks ? deps.getAcks() : {};
  nextItems = applyAcks(nextItems, acks);

  const configFindings = deps.getConfigFindings ? deps.getConfigFindings() : [];
  const nextModel = { generatedAt: clock.now, accounts: accountsState, items: nextItems, configFindings };

  // newAtRisk: items at_risk now that were absent or not-at_risk before
  const newAtRisk = nextItems.filter(i =>
    i.status === "at_risk" && prevItemsById.get(i.id)?.status !== "at_risk"
  );

  // stage proposals for all items (per their account)
  let queue = store.getQueue();
  for (const account of accounts) {
    const accountItems = nextItems.filter(i => i.account === account.id);
    queue = stageProposals(accountItems, queue, account);
  }

  // diff: compare item sets ignoring lastChanged timestamps
  const norm = (m) => JSON.stringify(m.items.map(i => ({ ...i, lastChanged: null })));
  const changed = norm(prev) !== norm(nextModel)
    || JSON.stringify(prev.configFindings || []) !== JSON.stringify(configFindings);

  store.saveModel(nextModel);
  store.saveQueue(queue);

  const notify = { newAtRisk, staleFlips };
  if (changed || staleFlips.length) emit({ type: "update", at: clock.now, notify });

  return { changed, warnings, itemCount: nextItems.length, notify };
}
