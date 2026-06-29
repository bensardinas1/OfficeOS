/**
 * exposed/pci-tamper.js — pure recognizer for BrickellPay PCI tamper alerts.
 * The monitored environment (the sandbox host) emits a tamper alert per affected
 * URL, so per-incident dedupe floods the panel with near-identical cards. We roll
 * all tamper alerts of the same severity into ONE finding (identityKey
 * pci:tamper:<severity>); the exposed normalizer keeps every individual alert as a
 * member, so the drill-in still shows each one. The real per-URL detail lives in
 * the PCI dashboard (link-out), never here.
 */
import { senderMatches } from "./util.js";

function titleCase(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s; }

export function recognizePciTamper(email, cfg) {
  if (!senderMatches(email, cfg)) return null;
  const text = `${email.subject || ""} ${email.preview || ""}`;
  if (!(cfg.subjectMarkers || []).some(m => text.toLowerCase().includes(m.toLowerCase()))) return null;

  const sevJson = text.match(/"severity"\s*:\s*"(HIGH|CRITICAL|MEDIUM|LOW)"/i);
  const sevSub = (email.subject || "").match(/-\s*(HIGH|CRITICAL|MEDIUM|LOW)\b/i);
  const severity = titleCase(sevJson?.[1] || sevSub?.[1] || "HIGH");

  return {
    source: "pci_tamper",
    identityKey: `pci:tamper:${severity.toLowerCase()}`,
    severity,
    title: `${severity} · PCI tamper`,
    url: cfg.portalUrl,
  };
}
