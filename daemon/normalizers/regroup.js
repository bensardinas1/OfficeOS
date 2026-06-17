/**
 * regroup.js — apply the reasoner fallback to the single "ungrouped" owed_risk
 * item. Deterministic confirmation: only split when the reasoner returns >=2
 * distinct keys covering ALL stragglers. Never throws; on any failure the
 * original deterministic items are returned.
 */
function buildItem(account, rules, rootCause, members) {
  const portal = account.links?.billing_portal || null;
  const n = members.length;
  const source = members.map(m => ({ kind: "thread", emailId: m.emailId }));
  if (portal) source.push({ kind: "url", url: portal });
  return {
    id: `${account.id}:owed_risk:${rootCause}`,
    jobType: "owed_risk",
    account: account.id,
    title: `${n} failed payment${n === 1 ? "" : "s"}${n > 1 ? " — one root cause" : ""}`,
    status: n >= (rules.threshold?.atRiskMembers ?? 1) ? "at_risk" : "ok",
    group: { rootCause, members },
    source,
    proposedActions: portal ? ["draft_chase", "route:billing_portal"] : ["draft_chase"],
    lastChanged: null,
  };
}

export async function regroupStragglers(items, account, rules, reasonerFn) {
  const ungrouped = items.find(i => i.group?.rootCause === "ungrouped");
  if (!ungrouped) return items;
  let mapping = {};
  try {
    mapping = await reasonerFn(ungrouped.group.members) || {};
  } catch {
    return items;
  }
  const members = ungrouped.group.members;
  const byKey = new Map();
  for (const m of members) {
    const key = mapping[m.emailId];
    if (!key) return items;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }
  if (byKey.size < 2) return items;
  const rest = items.filter(i => i !== ungrouped);
  for (const [rootCause, groupMembers] of byKey) rest.push(buildItem(account, rules, rootCause, groupMembers));
  return rest;
}
