/**
 * normalizers/handled.js — pure transform producing ONE per-account summary
 * item answering "is my world handled?". Derived entirely from the existing
 * triage-category buckets; needs no email-content signals.
 *
 * Summary items are always status "ok" so they never inflate the panel's
 * "N need you" count — the counts live in the title and group.counts.
 */
import { withinLookback } from "./prepare.js";
import { looksAutomated } from "../../scripts/sender-guards.js";

function actionableIds(typeConfig) {
  const flagged = (typeConfig.triageCategories || []).filter(c => c.actionable).map(c => c.id);
  if (flagged.length) return new Set(flagged);
  return new Set((typeConfig.triageCategories || []).map(c => c.id).filter(id => id === "action" || id === "respond"));
}

export function normalizeHandled(classified, account, typeConfig, opts = {}) {
  const actionable = actionableIds(typeConfig);
  const { lookbackHours, nowMs = Date.now() } = opts;
  let needsYou = 0;
  let waiting = 0;
  const all = [];
  for (const [id, bucket] of Object.entries(classified.categories || {})) {
    if (id === "ignore") continue;
    const emails = (bucket.emails || []).filter(e => !lookbackHours || withinLookback(e, lookbackHours, nowMs));
    if (actionable.has(id)) {
      for (const e of emails) {
        if (looksAutomated(e.from, e.hasListUnsubscribe)) waiting++; else needsYou++;
      }
    } else {
      waiting += emails.length;
    }
    for (const e of emails) all.push({ subject: e.subject, from: e.from, fromName: e.fromName, receivedAt: e.receivedAt || e.received, emailId: e.id });
  }
  all.sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
  const CAP = 50;
  const members = all.slice(0, CAP);
  const moreCount = Math.max(0, all.length - CAP);

  // Lead with the one number that requires the user (a reply or decision);
  // demote the heterogeneous "everything else" pile to a quiet subtitle.
  const title = needsYou > 0
    ? `${needsYou} ${needsYou === 1 ? "needs" : "need"} a reply or decision`
    : (waiting > 0 ? "Nothing needs a reply" : "Inbox clear");
  const subtitle = waiting > 0 ? `+ ${waiting} informational` : "";
  return [{
    id: `${account.id}:handled`,
    jobType: "handled",
    account: account.id,
    title,
    subtitle,
    status: "ok",
    group: { rootCause: "handled", members, moreCount, counts: { needsYou, waiting } },
    source: [],
    proposedActions: [],
    lastChanged: null,
  }];
}
