/**
 * normalizers/gateway/nmi.js — pure recognizer for NMI support-ticket emails.
 * Detection is by the ticket marker in the subject (present on every thread
 * reply), so it captures NMI replies AND the merchant/Brickell replies in the
 * same thread. Returns null for non-NMI mail.
 */
export function recognizeNmiTicket(email, cfg) {
  const subject = email.subject || "";
  const m = subject.match(new RegExp(cfg.subjectPattern));
  if (!m) return null;
  const ticket = m[1];
  const text = `${subject} ${email.preview || ""}`;
  const issueType = (cfg.issueKeywords || []).find(k => text.toLowerCase().includes(k.toLowerCase())) || "Gateway issue";
  const gw = text.match(/GW ID\s*(\d+)/i);
  const merch = (email.preview || "").match(/customer,?\s+([A-Za-z0-9][\w .&'-]+?)\s*\(GW ID/i);
  return {
    ticket,
    issueType,
    gwId: gw ? gw[1] : null,
    merchant: merch ? merch[1].trim() : null,
    url: cfg.ticketUrlTemplate.replace("{ticket}", ticket),
  };
}
