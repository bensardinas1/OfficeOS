/**
 * normalizers/audit/secureframe.js — pure recognizer for Secureframe auditor
 * emails. Detection is by sender domain; the test name comes from the body
 * preview ("...the test <name> to Action required." / "on the test <name>.").
 * Returns null for non-Secureframe mail.
 */
function senderMatches(from, domains) {
  const f = (from || "").toLowerCase();
  return (domains || []).some(d => f.endsWith("@" + d.toLowerCase()) || f.endsWith("." + d.toLowerCase()));
}

function anyMarker(text, markers) {
  const t = text.toLowerCase();
  return (markers || []).some(m => t.includes(m.toLowerCase()));
}

export function recognizeSecureframe(email, cfg) {
  if (!senderMatches(email.from, cfg.senderDomains)) return null;
  const text = `${email.subject || ""} ${email.preview || ""}`;
  const nameMatch = (email.preview || "").match(/\bthe test\s+(.+?)(?:\s+to\s+Action required\b|\s*\.|\s*$)/i);
  const testName = nameMatch ? nameMatch[1].trim() : "Secureframe test";
  let subType = "update";
  if (anyMarker(text, cfg.actionRequiredMarkers)) subType = "action_required";
  else if (anyMarker(text, cfg.commentMarkers)) subType = "comment";
  else if (anyMarker(text, cfg.resolvedMarkers)) subType = "resolved";
  const urlMatch = (email.preview || "").match(/https?:\/\/\S*secureframe\.com\S*/i);
  const url = urlMatch ? urlMatch[0].replace(/[).,]+$/, "") : cfg.baseUrl;
  return { testName, subType, url };
}
