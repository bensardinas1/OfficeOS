/**
 * normalizers/exposed.js — pure transform from classified emails to deduped
 * security-finding items. Runs every configured recognizer; dedupes by the
 * finding's identityKey; maps severity → status. Link-out only — exact resource
 * names live in the system of record (Azure portal / PCI dashboard), never here.
 */
import { recognizeDefenderCloud } from "./exposed/defender-cloud.js";
import { recognizeDefenderEndpoint } from "./exposed/defender-endpoint.js";
import { recognizePciTamper } from "./exposed/pci-tamper.js";
import { recognizeEntra } from "./exposed/entra.js";

const RECOGNIZERS = [
  ["defenderCloud", recognizeDefenderCloud],
  ["defenderEndpoint", recognizeDefenderEndpoint],
  ["pciTamper", recognizePciTamper],
  ["entra", recognizeEntra],
];

export function normalizeExposed(emails, account, rules) {
  const atRisk = new Set((rules.atRiskSeverities || ["Critical", "High"]).map(s => s.toLowerCase()));
  const byKey = new Map();
  for (const email of emails) {
    for (const [name, fn] of RECOGNIZERS) {
      const cfg = rules.recognizers?.[name];
      if (!cfg) continue;
      const finding = fn(email, cfg);
      if (!finding) continue;
      if (!byKey.has(finding.identityKey)) byKey.set(finding.identityKey, { finding, members: [] });
      byKey.get(finding.identityKey).members.push(email);
      break; // one finding per email
    }
  }

  const items = [];
  for (const [identityKey, { finding, members }] of byKey) {
    items.push({
      id: `${account.id}:exposed:${identityKey}`,
      jobType: "exposed",
      account: account.id,
      title: finding.title,
      status: atRisk.has((finding.severity || "").toLowerCase()) ? "at_risk" : "ok",
      group: {
        rootCause: identityKey,
        severity: finding.severity,
        source: finding.source,
        members: members.map(m => ({ subject: m.subject, emailId: m.id, receivedAt: m.receivedAt, from: m.from, fromName: m.fromName })),
      },
      source: [{ kind: "url", url: finding.url }, ...members.map(m => ({ kind: "thread", emailId: m.id }))],
      proposedActions: [],
      acknowledgeable: true,
      lastChanged: null,
    });
  }
  return items;
}
