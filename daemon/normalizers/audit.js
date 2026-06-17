/**
 * normalizers/audit.js — pure transform from classified emails to grouped audit
 * items (compliance fieldwork). v1 recognizer: Secureframe, grouped by test.
 * An item is at_risk when any of its emails requests action/comment; resolved
 * markers (and only resolved markers) make it ok.
 */
import { recognizeSecureframe } from "./audit/secureframe.js";

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "test";
}

export function normalizeAudit(emails, account, rules) {
  const sfCfg = rules.recognizers?.secureframe;
  if (!sfCfg) return [];
  const groups = new Map();
  for (const e of emails) {
    const rec = recognizeSecureframe(e, sfCfg);
    if (!rec) continue;
    if (!groups.has(rec.testName)) groups.set(rec.testName, { recs: [], members: [] });
    const g = groups.get(rec.testName);
    g.recs.push(rec);
    g.members.push(e);
  }

  const items = [];
  for (const [testName, { recs, members }] of groups) {
    const needsAction = recs.some(r => r.subType === "action_required" || r.subType === "comment");
    const allResolved = recs.every(r => r.subType === "resolved");
    const status = needsAction || !allResolved ? "at_risk" : "ok";
    const what = recs.some(r => r.subType === "comment") ? "comment: upload requested"
      : recs.some(r => r.subType === "action_required") ? "action required" : "update";
    const url = recs.map(r => r.url).find(u => /\/tests?\//.test(u)) || recs[0].url;
    items.push({
      id: `${account.id}:audit:${slug(testName)}`,
      jobType: "audit",
      account: account.id,
      title: `${testName} — ${what}`,
      status,
      group: {
        rootCause: testName,
        members: members.map(m => ({ subject: m.subject, emailId: m.id, receivedAt: m.receivedAt })),
      },
      source: [{ kind: "url", url }, ...members.map(m => ({ kind: "thread", emailId: m.id }))],
      acknowledgeable: true,
      proposedActions: [],
      lastChanged: null,
    });
  }
  return items;
}
