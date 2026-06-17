/**
 * exposed/entra.js — pure recognizer for Microsoft Entra ID Protection digests.
 * Suppresses clean digests (0 risky users AND 0 risky sign-ins) by returning
 * null. Surfaces non-zero digests as a High finding linking to the Entra portal.
 */
import { senderMatches } from "./util.js";

export function recognizeEntra(email, cfg) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  if (!senderMatches(email, cfg)) return null;
  if (!(cfg.subjectMarkers || []).some(m => text.toLowerCase().includes(m.toLowerCase()))) return null;
  const users = Number((text.match(/risky users detected\D*(\d+)/i) || [])[1] || 0);
  const signins = Number((text.match(/risky sign-?ins detected\D*(\d+)/i) || [])[1] || 0);
  if (users === 0 && signins === 0) return null; // clean digest → suppress
  return {
    source: "entra",
    identityKey: `entra:${users}u-${signins}s`,
    severity: "High",
    title: `High · Entra: ${users} risky users, ${signins} risky sign-ins`,
    url: cfg.portalUrl || "https://entra.microsoft.com",
  };
}
