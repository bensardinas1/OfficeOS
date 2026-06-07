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

if (process.argv[1] && process.argv[1].endsWith("tier-audit.js")) {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { atomicWrite } = await import("./fs-utils.js");

  const args = process.argv.slice(2);
  const flags = { applyDemote: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bundle") flags.bundle = args[++i];
    else if (args[i] === "--records") flags.records = args[++i];
    else if (args[i] === "--threshold") flags.threshold = Number(args[++i]);
    else if (args[i] === "--apply-demote") flags.applyDemote = true;
  }
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = join(__dirname, "..");
  const bundleObj = JSON.parse(readFileSync(flags.bundle || join(root, "data/.last-run-bundle.json"), "utf-8"));
  const records = JSON.parse(readFileSync(flags.records, "utf-8"));
  const result = auditTier(bundleObj.bundle, records, { demoteThresholdPercent: flags.threshold ?? 0 });

  if (flags.applyDemote) {
    const cfgPath = join(root, "config/companies.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const demoted = [];
    for (const [acct, r] of Object.entries(result.perAccount)) {
      if (!r.demoteRecommended) continue;
      const c = cfg.companies.find(x => x.id === acct);
      if (c && c.candidateTier && c.candidateTier.mode === "active") {
        c.candidateTier.mode = "shadow";
        demoted.push(acct);
      }
    }
    if (demoted.length) {
      atomicWrite(cfgPath, JSON.stringify(cfg, null, 2));
      process.stderr.write(`tier-audit: DEMOTED to shadow (drift): ${demoted.join(", ")}\n`);
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
