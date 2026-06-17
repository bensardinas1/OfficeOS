/**
 * exposed/util.js — shared pure helpers for the security recognizers.
 */
import { createHash } from "node:crypto";

export function senderMatches(email, cfg) {
  const f = (email.from || "").toLowerCase();
  const domainOk = (cfg.senderDomains || []).some(d => f.endsWith("@" + d.toLowerCase()) || f.endsWith("." + d.toLowerCase()));
  if (!domainOk) return false;
  if (!cfg.senderHints || cfg.senderHints.length === 0) return true;
  return cfg.senderHints.some(h => f.includes(h.toLowerCase()));
}

export function severityFrom(text) {
  const rl = text.match(/Risk level:?\s*(Critical|High|Medium|Low)/i);
  const m = rl || text.match(/\b(Critical|High|Medium|Low)\b/i);
  if (!m) return null;
  const s = m[1].toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function shortHash(s) {
  return createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
}
