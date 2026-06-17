/**
 * normalizers/gateway/status.js — pure ticket-status from the thread's messages.
 * v1: "resolved" if any message matches a closure marker, else "open".
 * (A finer "waiting-on-you" sub-status is a later refinement; defaulting to
 * "open" fails toward surfacing, never toward hiding a live issue.)
 */
export function gatewayStatus(members, resolvedMarkers) {
  const hay = members.map(m => `${m.subject || ""} ${m.preview || ""}`.toLowerCase());
  const resolved = (resolvedMarkers || []).some(mk => hay.some(h => h.includes(mk.toLowerCase())));
  return resolved ? "resolved" : "open";
}
