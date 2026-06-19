/**
 * normalizers/triage.js — pure transform from the triage connector's
 * pending-deletions list into ONE per-account "Cleanup" item (status "ok").
 * Members are the deletion candidates for this account, newest-first, capped.
 * Returns [] when the account has no candidates (no empty tile).
 */
export function normalizeTriage(pendingDeletions, account, opts = {}) {
  const CAP = opts.cap ?? 50;
  const mine = (pendingDeletions || []).filter(c => c.accountId === account.id);
  if (!mine.length) return [];
  const sorted = mine.slice().sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
  const members = sorted.slice(0, CAP).map(c => ({
    subject: c.subject, from: c.from, fromName: c.sender, receivedAt: c.receivedAt, emailId: c.id,
  }));
  return [{
    id: `${account.id}:triage`,
    jobType: "triage",
    account: account.id,
    title: `${mine.length} to clean up`,
    status: "ok",
    group: { rootCause: "cleanup", members, moreCount: Math.max(0, mine.length - CAP), counts: { candidates: mine.length } },
    source: [],
    proposedActions: [],
    lastChanged: null,
  }];
}
