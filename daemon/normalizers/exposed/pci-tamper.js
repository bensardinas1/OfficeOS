/**
 * exposed/pci-tamper.js — pure recognizer for BrickellPay PCI tamper alerts.
 * The real email body is a JSON payload ({severity, changes:[{type,key,...}],
 * compromiseIndicators:[...]}) plus a labeled URL. Dedupe by the affected URL +
 * the set of changed keys, so identical re-alerts merge but distinct tampers
 * stay separate. Surfaces from the sandbox host (the monitored environment).
 */
import { senderMatches, shortHash } from "./util.js";

function titleCase(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s; }

export function recognizePciTamper(email, cfg) {
  if (!senderMatches(email, cfg)) return null;
  const text = `${email.subject || ""} ${email.preview || ""}`;
  if (!(cfg.subjectMarkers || []).some(m => text.toLowerCase().includes(m.toLowerCase()))) return null;

  const sevJson = text.match(/"severity"\s*:\s*"(HIGH|CRITICAL|MEDIUM|LOW)"/i);
  const sevSub = (email.subject || "").match(/-\s*(HIGH|CRITICAL|MEDIUM|LOW)\b/i);
  const severity = titleCase(sevJson?.[1] || sevSub?.[1] || "HIGH");

  const changeKeys = [...text.matchAll(/"key"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
  const indMatch = text.match(/"compromiseIndicators"\s*:\s*\[([^\]]*)\]/i);
  const indicators = indMatch ? [...indMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : [];

  const urlm = text.match(/\bURL\s+(https?:\/\/\S+)/i) || text.match(/https?:\/\/\S*brickellpay\.com\S*/i);
  const url = urlm ? (urlm[1] || urlm[0]).replace(/[).,]+$/, "") : cfg.portalUrl;

  const what = indicators.join(", ") || changeKeys.join(", ") || "content modification";
  return {
    source: "pci_tamper",
    identityKey: `pci:${shortHash(url + "|" + [...changeKeys].sort().join(","))}`,
    severity,
    title: `${severity} · PCI tamper: ${what}`,
    url: cfg.portalUrl,
  };
}
