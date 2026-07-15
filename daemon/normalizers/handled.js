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

/**
 * Conversation-aware counting: the honest "needs a reply" number is distinct
 * THREADS awaiting the user, not messages. A thread where the user's own mail
 * is the newest human message is handled; automated messages never decide.
 */
export function countConversations(actionableEmails, myEmail) {
  const me = String(myEmail || "").toLowerCase();
  const byConv = new Map();
  for (const e of actionableEmails) {
    const key = e.conversationId || `solo:${e.id}`;
    if (!byConv.has(key)) byConv.set(key, []);
    byConv.get(key).push(e);
  }
  let needsYou = 0, waiting = 0;
  for (const msgs of byConv.values()) {
    const humans = msgs.filter(x => !looksAutomated(x.from, x.hasListUnsubscribe));
    if (!humans.length) { waiting++; continue; }
    humans.sort((a, b) => String(a.receivedAt || a.received || "").localeCompare(String(b.receivedAt || b.received || "")));
    const newest = humans[humans.length - 1];
    if (me && (newest.from || "").toLowerCase() === me) waiting++;
    else needsYou++;
  }
  return { needsYou, waiting };
}

export function normalizeHandled(classified, account, typeConfig, opts = {}) {
  const actionable = actionableIds(typeConfig);
  const { lookbackHours, nowMs = Date.now() } = opts;
  let waiting = 0;
  const actionableEmails = [];
  const all = [];
  for (const [id, bucket] of Object.entries(classified.categories || {})) {
    if (id === "ignore") continue;
    const emails = (bucket.emails || []).filter(e => !lookbackHours || withinLookback(e, lookbackHours, nowMs));
    if (actionable.has(id)) actionableEmails.push(...emails);
    else waiting += emails.length;
    for (const e of emails) all.push({
      subject: e.subject, from: e.from, fromName: e.fromName,
      receivedAt: e.receivedAt || e.received, emailId: e.id,
      conversationId: e.conversationId || null,
      automated: looksAutomated(e.from, e.hasListUnsubscribe),
    });
  }
  const conv = countConversations(actionableEmails, account.myEmail);
  const needsYou = conv.needsYou;
  waiting += conv.waiting;
  all.sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
  const CAP = 50;
  const members = all.slice(0, CAP);
  const moreCount = Math.max(0, all.length - CAP);

  // Lead with the one number that requires the user (a reply or decision);
  // demote the heterogeneous "everything else" pile to a quiet subtitle.
  const title = needsYou > 0
    ? `${needsYou} conversation${needsYou === 1 ? "" : "s"} need${needsYou === 1 ? "s" : ""} a reply`
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
