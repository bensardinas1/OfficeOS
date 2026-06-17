/**
 * normalizers/handled.js — pure transform producing ONE per-account summary
 * item answering "is my world handled?". Derived entirely from the existing
 * triage-category buckets; needs no email-content signals.
 *
 * Summary items are always status "ok" so they never inflate the panel's
 * "N need you" count — the counts live in the title and group.counts.
 */
function actionableIds(typeConfig) {
  const flagged = (typeConfig.triageCategories || []).filter(c => c.actionable).map(c => c.id);
  if (flagged.length) return new Set(flagged);
  return new Set((typeConfig.triageCategories || []).map(c => c.id).filter(id => id === "action" || id === "respond"));
}

export function normalizeHandled(classified, account, typeConfig) {
  const actionable = actionableIds(typeConfig);
  let needsYou = 0;
  let waiting = 0;
  for (const [id, bucket] of Object.entries(classified.categories || {})) {
    if (id === "ignore") continue;
    const n = bucket.emails?.length || 0;
    if (actionable.has(id)) needsYou += n;
    else waiting += n;
  }
  const title = needsYou > 0
    ? `${needsYou} need you · ${waiting} waiting`
    : (waiting > 0 ? `${waiting} waiting · inbox clear` : "Inbox clear");
  return [{
    id: `${account.id}:handled`,
    jobType: "handled",
    account: account.id,
    title,
    status: "ok",
    group: { rootCause: "handled", members: [], counts: { needsYou, waiting } },
    source: [],
    proposedActions: [],
    lastChanged: null,
  }];
}
