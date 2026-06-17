/**
 * exposed/defender-cloud.js — pure recognizer for Microsoft Defender for Cloud
 * "attack path" emails. Dedupe by attack-path ID; link out to the Azure portal
 * (the exact resource names live there — never reconstructed here).
 */
import { senderMatches, severityFrom, shortHash } from "./util.js";

export function recognizeDefenderCloud(email, cfg) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  if (!senderMatches(email, cfg)) return null;
  if (!(cfg.subjectMarkers || []).some(m => text.toLowerCase().includes(m.toLowerCase()))) return null;
  const idm = text.match(/Attack path ID\s*([a-f0-9-]{8,})/i);
  const id = idm ? idm[1] : shortHash(text);
  const severity = severityFrom(text) || "High";
  return {
    source: "defender_cloud",
    identityKey: `attackpath:${id}`,
    severity,
    title: `${severity} · Attack path`,
    url: cfg.portalUrl,
  };
}
