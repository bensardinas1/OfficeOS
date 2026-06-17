/**
 * exposed/pci-tamper.js — pure recognizer for BrickellPay PCI tamper alerts.
 * Dedupe by change-type + affected URL. Surfaces even from the sandbox host
 * (that is the monitored environment). Links to the PCI dashboard.
 */
import { senderMatches, shortHash } from "./util.js";

export function recognizePciTamper(email, cfg) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  if (!senderMatches(email, cfg)) return null;
  if (!(cfg.subjectMarkers || []).some(m => text.toLowerCase().includes(m.toLowerCase()))) return null;
  const sevm = text.match(/SEVERITY\s*[:\s]\s*(HIGH|CRITICAL|MEDIUM|LOW)/i) || text.match(/-\s*(HIGH|CRITICAL|MEDIUM|LOW)\b/i);
  const sevRaw = sevm ? sevm[1] : "HIGH";
  const severity = sevRaw.charAt(0).toUpperCase() + sevRaw.slice(1).toLowerCase();
  const typem = text.match(/TYPE\s*[:\s]\s*([A-Z_]{4,})/);
  const type = typem ? typem[1] : "TAMPER";
  const urlm = text.match(/URL\s*[:\s]\s*(https?:\/\/\S+)/i) || text.match(/https?:\/\/\S*brickellpay\.com\S*/i);
  const url = urlm ? (urlm[1] || urlm[0]).replace(/[).,]+$/, "") : cfg.portalUrl;
  return {
    source: "pci_tamper",
    identityKey: `pci:${type}:${shortHash(url)}`,
    severity,
    title: `${severity} · PCI tamper: ${type.toLowerCase()}`,
    url: cfg.portalUrl,
  };
}
