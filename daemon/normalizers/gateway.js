/**
 * normalizers/gateway.js — pure transform from classified emails to grouped
 * gateway (processing-incident) items. Iterates a recognizers registry so a
 * new processor is a recognizer module + a config block (mirrors exposed.js).
 * Each recognizer: (email, cfg) => { ticket, issueType, gwId?, merchant?, url } | null.
 */
import { recognizeNmiTicket } from "./gateway/nmi.js";
import { gatewayStatus } from "./gateway/status.js";

const DEFAULT_RECOGNIZERS = [["nmi", recognizeNmiTicket]];

export function normalizeGateway(emails, account, rules, recognizers = DEFAULT_RECOGNIZERS) {
  const groups = new Map(); // `${name}:${ticket}` -> { name, cfg, rec, members }
  for (const e of emails) {
    for (const [name, fn] of recognizers) {
      const cfg = rules.recognizers?.[name];
      if (!cfg) continue;
      const rec = fn(e, cfg);
      if (!rec) continue;
      const key = `${name}:${rec.ticket}`;
      if (!groups.has(key)) groups.set(key, { name, cfg, rec, members: [] });
      const g = groups.get(key);
      g.members.push(e);
      if (rec.merchant || rec.gwId) g.rec = rec; // keep the richest recognizer result
      break;
    }
  }

  const items = [];
  for (const [key, { name, cfg, rec, members }] of groups) {
    const state = gatewayStatus(members, cfg.resolvedMarkers);
    const who = rec.merchant || (rec.gwId ? `GW ${rec.gwId}` : "");
    items.push({
      id: `${account.id}:gateway:${key}`,
      jobType: "gateway",
      account: account.id,
      title: `${name.toUpperCase()} #${rec.ticket} · ${rec.issueType}${who ? ` · ${who}` : ""}`,
      status: state === "resolved" ? "ok" : "at_risk",
      group: {
        rootCause: key,
        state,
        processor: name,
        merchant: rec.merchant ?? null,
        gwId: rec.gwId ?? null,
        members: members.map(m => ({ subject: m.subject, emailId: m.id, receivedAt: m.receivedAt, from: m.from, fromName: m.fromName })),
      },
      source: [{ kind: "url", url: rec.url }, ...members.map(m => ({ kind: "thread", emailId: m.id }))],
      proposedActions: [],
      acknowledgeable: true,
      lastChanged: null,
    });
  }
  return items;
}
