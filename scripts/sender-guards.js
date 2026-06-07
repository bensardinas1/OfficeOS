/**
 * sender-guards.js
 *
 * Pure sender-classification helpers shared by build-bundle's alert-batch
 * proposal guard and the confidence tier. NO I/O.
 *
 *   looksAutomated(senderEmail, hasListUnsubscribe) -> bool
 *   findAccount(accounts, accountId) -> account | undefined
 *   isProtectedSender(account, senderEmail) -> bool
 */

// Local-part patterns that mark a sender as a machine, not a person. Anchored to
// a word boundary (start, or a . _ + - separator) so "salesnoreply" stays human
// while "billing.noreply" / "alerts+sec" register as automated.
const AUTOMATED_LOCALPART =
  /(?:^|[._+-])(?:no-?reply|do-?not-?reply|notifications?|alerts?|mailer-daemon)(?:$|[._+-])/i;

export function looksAutomated(senderEmail, hasListUnsubscribe) {
  if (hasListUnsubscribe) return true;
  const local = (String(senderEmail || "").split("@")[0] || "").toLowerCase();
  return AUTOMATED_LOCALPART.test(local);
}

export function findAccount(accounts, accountId) {
  return (accounts || []).find(a => a.id === accountId);
}

export function isProtectedSender(account, senderEmail) {
  if (!account) return false;
  const email = String(senderEmail || "").toLowerCase();
  const domain = email.split("@")[1] || "";
  const myDomain = ((account.myEmail || "").split("@")[1] || "").toLowerCase();
  if (myDomain && domain === myDomain) return true;
  const lists = [...(account.prioritySenders || []), ...(account.neverDelete || [])];
  for (const rule of lists) {
    if (rule.type === "email" && (rule.value || "").toLowerCase() === email) return true;
    if (rule.type === "domain" && (rule.value || "").toLowerCase() === domain) return true;
  }
  return false;
}
