/**
 * proposals.js — stage proposals from items and own their lifecycle.
 * Rails note: draft_chase proposals only ever describe DRAFTS. Nothing here
 * sends mail; execution is delegated to executors, which enforce the rails.
 */

const TRANSITIONS = {
  pending: { approve: "approved", dismiss: "dismissed", snooze: "snoozed" },
  approved: { executed: "executed", failed: "failed" },
  snoozed: { approve: "approved", dismiss: "dismissed" },
  dismissed: { reopen: "pending" },
};

export function transition(proposal, event) {
  const next = TRANSITIONS[proposal.state]?.[event];
  if (!next) throw new Error(`invalid transition: ${proposal.state} --${event}-->`);
  return { ...proposal, state: next };
}

export function buildChaseDrafts(item, account) {
  const cause = item.group.rootCause;
  return item.group.members.map(m => ({
    to: [m.from],
    subject: `Re: ${m.subject || "Payment on file"}`,
    body:
      `Hi ${m.vendor || "team"},\n\n` +
      `We saw the recent payment issue on our account (${cause}). ` +
      `We're correcting the payment method on file and will re-run the charge. ` +
      `Please hold any service interruption while we resolve this.\n\n` +
      `Thank you,\n${account.id}`,
    replyToMessageId: m.emailId,
  }));
}

/**
 * Add a pending draft_chase proposal for any item that has the action and no
 * existing proposal. Existing proposals (any state) are preserved untouched.
 */
export function stageProposals(items, queue, account) {
  const existing = new Map((queue.proposals || []).map(p => [p.id, p]));
  for (const item of items) {
    if (!item.proposedActions?.includes("draft_chase")) continue;
    const id = `${item.id}::draft_chase`;
    if (existing.has(id)) continue;
    const drafts = buildChaseDrafts(item, account);
    existing.set(id, {
      id,
      itemId: item.id,
      action: "draft_chase",
      params: { account: account.id, drafts },
      preview: { summary: item.title, drafts },
      state: "pending",
    });
  }
  return { proposals: [...existing.values()] };
}
