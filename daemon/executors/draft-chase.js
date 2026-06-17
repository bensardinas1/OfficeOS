/**
 * draft-chase.js — creates DRAFT emails only. RAILS: this executor must never
 * send mail and never delete mail. It delegates to an injected saveDraftFn
 * (wired to scripts/save-draft.js in daemon.js), which writes to a Drafts
 * folder. Sending remains the user's manual action in their mail client.
 */
export async function draftChaseExecutor(proposal, ctx) {
  const { account, saveDraftFn } = ctx;
  const drafts = proposal.params?.drafts || [];
  const draftIds = [];
  for (const draft of drafts) {
    const { draftId } = await saveDraftFn(account.id, draft);
    draftIds.push(draftId);
  }
  return { kind: "execute", result: { draftIds } };
}
