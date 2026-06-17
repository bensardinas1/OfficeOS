/**
 * reasoner.js — deterministic-first grouping fallback. Pure prompt-build +
 * response-parse; the model call is injected (the daemon shells `claude`).
 * RAILS: reasoning only — proposes grouping keys, never sends or deletes mail.
 */
export function buildGroupingPrompt(stragglers) {
  const lines = stragglers.map(e => `- id=${e.id ?? e.emailId ?? ""} | from=${e.from || ""} | subject=${(e.subject || "").replace(/\n/g, " ")}`);
  return [
    "You are grouping failed-payment emails by their underlying root cause",
    "(e.g. the same vendor/account behind multiple notices).",
    "Return ONLY a JSON object mapping each email id to a short stable group key",
    'like "acct:<vendor>" — no prose. Emails:',
    ...lines,
  ].join("\n");
}

export function parseGroupingResponse(text) {
  if (!text) return {};
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const obj = candidate.match(/\{[\s\S]*\}/);
  if (!obj) return {};
  try {
    const parsed = JSON.parse(obj[0]);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch {
    return {};
  }
}
