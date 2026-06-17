/**
 * exposed/defender-endpoint.js — pure recognizer for Microsoft Defender for
 * Endpoint vulnerability notifications. Dedupe by CVE; link to the Defender
 * portal for the full recommendation/affected-device list.
 */
import { senderMatches, severityFrom, shortHash } from "./util.js";

export function recognizeDefenderEndpoint(email, cfg) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  if (!senderMatches(email, cfg)) return null;
  if (!(cfg.subjectMarkers || []).some(m => text.toLowerCase().includes(m.toLowerCase()))) return null;
  const cve = text.match(/CVE-\d{4}-\d+/i);
  const id = cve ? cve[0].toUpperCase() : shortHash(text);
  const severity = severityFrom((text.match(/Severity\s+\w+/i) || [""])[0]) || severityFrom(text) || "High";
  return {
    source: "defender_endpoint",
    identityKey: `cve:${id}`,
    severity,
    title: `${severity} · ${cve ? cve[0].toUpperCase() : "Vulnerability"}`,
    url: cfg.portalUrl,
  };
}
