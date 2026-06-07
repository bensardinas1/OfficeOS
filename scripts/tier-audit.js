/**
 * tier-audit.js
 *
 * Pure. Compares confidence-tier verdicts (stamped on bundle representatives)
 * against reasoner verdicts to detect FALSE-TRASH — tier=trash where the reasoner
 * would KEEP. False-trash is the silent-loss harm; this is the metric the
 * graduation gate (must be zero) and the live drift guard watch.
 *
 * Only items that carry a tier verdict AND were judged by the reasoner are
 * comparable — active non-audited groups are skipped by the reasoner, so they are
 * (correctly) absent from this comparison.
 *
 * auditTier(bundle, reasonerRecords, { demoteThresholdPercent })
 *   -> { agree, falseTrash, falseTrashRate, falseTrashList, demoteRecommended, perAccount }
 */

export function auditTier(bundle, reasonerRecords, { demoteThresholdPercent = 0 } = {}) {
  const verdictByMsgid = {};
  for (const r of reasonerRecords || []) if (r && r.msgid) verdictByMsgid[r.msgid] = r.verdict;

  let agree = 0, falseTrash = 0;
  const falseTrashList = [];
  const per = {};
  const rate = (ft, ag) => (ft + ag) === 0 ? 0 : (ft / (ft + ag)) * 100;

  for (const it of bundle || []) {
    if (!it.tier || it.tier.verdict !== "trash") continue;
    const reasoner = verdictByMsgid[it.msgid];
    if (reasoner === undefined) continue; // reasoner didn't judge it — nothing to compare
    const p = (per[it.account] ||= { agree: 0, falseTrash: 0 });
    if (reasoner === "keep") {
      falseTrash++; p.falseTrash++;
      falseTrashList.push({ msgid: it.msgid, account: it.account, sender: it.from, subject: it.subject });
    } else {
      agree++; p.agree++;
    }
  }

  const perAccount = {};
  for (const [acct, c] of Object.entries(per)) {
    const r = rate(c.falseTrash, c.agree);
    perAccount[acct] = { agree: c.agree, falseTrash: c.falseTrash, falseTrashRate: r, demoteRecommended: r > demoteThresholdPercent };
  }
  const falseTrashRate = rate(falseTrash, agree);
  return { agree, falseTrash, falseTrashRate, falseTrashList, demoteRecommended: falseTrashRate > demoteThresholdPercent, perAccount };
}
