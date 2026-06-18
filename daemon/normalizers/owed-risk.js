/**
 * normalizers/owed-risk.js — pure transform from classified emails to
 * grouped owed_risk items. Deterministic-only in this plan.
 */
import { groupKey } from "../grouping.js";

function isPaymentFailure(email, failureSignals) {
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();
  return failureSignals.some(sig => text.includes(sig.toLowerCase()));
}

/**
 * @param {object[]} emails  flat list of classified emails for one account
 * @param {object} account   { id, links }
 * @param {object} rules     account-type jobTypes.owed_risk config
 * @returns {object[]} items
 */
export function normalizeOwedRisk(emails, account, rules) {
  const failures = emails.filter(e => isPaymentFailure(e, rules.failureSignals));
  const order = rules.grouping?.order || ["card", "vendorDomain"];
  const groups = new Map();
  for (const e of failures) {
    const key = groupKey(e, order);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const portal = account.links?.billing_portal || null;
  const atRiskMin = rules.threshold?.atRiskMembers ?? 1;
  const items = [];
  for (const [rootCause, members] of groups) {
    const n = members.length;
    const source = members.map(m => ({ kind: "thread", emailId: m.id }));
    if (portal) source.push({ kind: "url", url: portal });
    items.push({
      id: `${account.id}:owed_risk:${rootCause}`,
      jobType: "owed_risk",
      account: account.id,
      title: `${n} failed payment${n === 1 ? "" : "s"}${n > 1 ? " — one root cause" : ""}`,
      status: n >= atRiskMin ? "at_risk" : "ok",
      group: {
        rootCause,
        members: members.map(m => ({ vendor: m.fromName || m.from, from: m.from, fromName: m.fromName, subject: m.subject, emailId: m.id, receivedAt: m.receivedAt })),
      },
      source,
      proposedActions: portal ? ["draft_chase", "route:billing_portal"] : ["draft_chase"],
      lastChanged: null, // stamped by the scheduler on a real diff
    });
  }
  return items;
}
