/**
 * grouping.js — deterministic root-cause grouping keys for owed_risk items.
 * Deterministic-first per the design; the reasoner fallback for stragglers
 * is added in a later plan and only runs on emails that return "ungrouped".
 */

const CARD_RX = /(?:card|ending|acct|account)\D{0,12}(\d{4})\b/i;

export function extractCardToken(text) {
  if (!text) return null;
  const m = String(text).match(CARD_RX);
  return m ? `card_${m[1]}` : null;
}

export function vendorDomain(from) {
  if (!from || typeof from !== "string") return null;
  const at = from.lastIndexOf("@");
  if (at < 0) return null;
  const domain = from.slice(at + 1).trim().toLowerCase();
  return domain.includes(".") ? domain : null;
}

/**
 * Resolve the first grouping rule that produces a key, in config order.
 * @param {object} email  { from, subject, preview }
 * @param {string[]} order  e.g. ["card", "vendorDomain"]
 */
export function groupKey(email, order) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  for (const rule of order) {
    if (rule === "card") {
      const t = extractCardToken(text);
      if (t) return t;
    } else if (rule === "vendorDomain") {
      const d = vendorDomain(email.from);
      if (d) return `vendor:${d}`;
    }
  }
  return "ungrouped";
}
