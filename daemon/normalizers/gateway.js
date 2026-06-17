/**
 * normalizers/gateway.js — pure transform from classified emails to grouped
 * gateway (processing-incident) items. v1 recognizer: NMI support tickets,
 * grouped by ticket #. Resolved tickets are status "ok"; open ones "at_risk".
 */
import { recognizeNmiTicket } from "./gateway/nmi.js";
import { gatewayStatus } from "./gateway/status.js";

export function normalizeGateway(emails, account, rules) {
  const nmiCfg = rules.recognizers?.nmi;
  if (!nmiCfg) return [];
  const groups = new Map();
  for (const e of emails) {
    const rec = recognizeNmiTicket(e, nmiCfg);
    if (!rec) continue;
    if (!groups.has(rec.ticket)) groups.set(rec.ticket, { rec, members: [] });
    const g = groups.get(rec.ticket);
    g.members.push(e);
    if (rec.merchant || rec.gwId) g.rec = rec;
  }

  const items = [];
  for (const [ticket, { rec, members }] of groups) {
    const state = gatewayStatus(members, nmiCfg.resolvedMarkers);
    const who = rec.merchant || (rec.gwId ? `GW ${rec.gwId}` : "");
    items.push({
      id: `${account.id}:gateway:nmi:${ticket}`,
      jobType: "gateway",
      account: account.id,
      title: `NMI #${ticket} · ${rec.issueType}${who ? ` · ${who}` : ""}`,
      status: state === "resolved" ? "ok" : "at_risk",
      group: {
        rootCause: `nmi:${ticket}`,
        state,
        merchant: rec.merchant,
        gwId: rec.gwId,
        members: members.map(m => ({ subject: m.subject, emailId: m.id, receivedAt: m.receivedAt })),
      },
      source: [{ kind: "url", url: rec.url }, ...members.map(m => ({ kind: "thread", emailId: m.id }))],
      acknowledgeable: true,
      proposedActions: [],
      lastChanged: null,
    });
  }
  return items;
}
