/**
 * promote-senders.js
 *
 * Auto-promotes repeat-junk senders to the permanent kill-list (alwaysDelete),
 * so the clean path stops re-judging the same noise — the system gets cheaper
 * and more deterministic over time. Rules are EMAIL-EXACT (can't over-match a
 * dual-use domain), and gated against:
 *   - threshold deletions (default 5; lower for the agent-reviewed backfill)
 *   - list-unsubscribe present (default; relaxed for agent-reviewed backfill)
 *   - protected senders (neverDelete / prioritySenders / own domain)
 *   - senders already on the kill-list
 *   - correspondents (anyone the user has emailed) — never auto-kill
 *   - dual-use / transactional senders (riskyPattern, e.g. uber.com/paypal/ebay)
 *
 * Pure selection + config mutation; CLI applies it to config/companies.json.
 */

import { isProtectedSender } from "./sender-guards.js";
import { splitKey } from "./sender-history.js";

// Dual-use / transactional senders that must never become a blanket kill rule
// (they send receipts/statements/security as well as promos). Mirrors the
// guarded kill-list senders.
export const DEFAULT_RISKY =
  /uber\.com|ebay|paypal|cash\.app|@cash|equifax|samsung|expedia|walgreens|costco|homedepot|wholefoods|hertz|coinbase|aeromexico|@td|tdbank|chase|citi|capitalone|amazon\.com|@square|squareup|lyft|brightline|hilton|marriott|americanair|\.aa\.com|anthropic|openai|microsoft|google\.com|apple\.com|plaid|intuit|docusign/i;

function alreadyHasRule(account, senderEmail) {
  const email = senderEmail.toLowerCase();
  const domain = email.split("@")[1] || "";
  for (const rule of account.alwaysDelete || []) {
    if (rule.type === "email" && (rule.value || "").toLowerCase() === email) return true;
    if (rule.type === "domain" && (rule.value || "").toLowerCase() === domain) return true;
  }
  return false;
}

export function selectAutoPromotions(history, accounts, {
  threshold = 5, requireListUnsub = true, correspondentsByAccount = {}, riskyPattern = DEFAULT_RISKY,
} = {}) {
  const byAccount = {};
  const acctById = new Map(accounts.map(a => [a.id, a]));
  for (const [key, entry] of Object.entries(history || {})) {
    const { accountId, senderEmail } = splitKey(key);
    if (!senderEmail) continue;
    const account = acctById.get(accountId);
    if (!account) continue;
    if (requireListUnsub && !entry.hasListUnsubscribe) continue;
    if ((entry.deletedCount || 0) < threshold) continue;
    if (riskyPattern && riskyPattern.test(senderEmail)) continue;
    if (isProtectedSender(account, senderEmail)) continue;
    if (alreadyHasRule(account, senderEmail)) continue;
    const corr = correspondentsByAccount[accountId];
    if (corr && corr.has(senderEmail.toLowerCase())) continue;
    (byAccount[accountId] ||= []).push({
      type: "email",
      value: senderEmail,
      label: `auto-promoted: ${entry.deletedCount} deletions`,
    });
  }
  return byAccount;
}

export function applyPromotions(cfg, promotionsByAccount) {
  const added = [];
  for (const company of cfg.companies || []) {
    const rules = promotionsByAccount[company.id];
    if (!rules || !rules.length) continue;
    company.alwaysDelete ||= [];
    const have = new Set(company.alwaysDelete
      .filter(r => r.type === "email").map(r => (r.value || "").toLowerCase()));
    const haveDomains = new Set(company.alwaysDelete
      .filter(r => r.type === "domain").map(r => (r.value || "").toLowerCase()));
    for (const rule of rules) {
      const v = (rule.value || "").toLowerCase();
      if (have.has(v) || haveDomains.has(v.split("@")[1] || "")) continue;
      company.alwaysDelete.push({ ...rule, value: v });
      have.add(v);
      added.push({ account: company.id, value: v });
    }
  }
  return added;
}

// CLI: select promotions from data/sender-history.json + config and apply them.
//   node scripts/promote-senders.js --apply [--threshold N] [--no-listunsub] [--dry]
if (process.argv[1] && process.argv[1].endsWith("promote-senders.js")) {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { atomicWrite } = await import("./fs-utils.js");
  const { loadCorrespondentsFile, correspondentSet } = await import("./correspondents.js");

  const args = process.argv.slice(2);
  const flags = {
    threshold: 5, requireListUnsub: !args.includes("--no-listunsub"),
    apply: args.includes("--apply"), dry: args.includes("--dry"),
  };
  const ti = args.indexOf("--threshold");
  if (ti >= 0) flags.threshold = Number(args[ti + 1]);

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cfgPath = join(root, "config/companies.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  const history = JSON.parse(readFileSync(join(root, "data/sender-history.json"), "utf-8"));
  const corrFile = loadCorrespondentsFile(join(root, "data/correspondents.json"));
  const correspondentsByAccount = {};
  for (const c of cfg.companies) correspondentsByAccount[c.id] = correspondentSet(corrFile, c.id);

  const promotions = selectAutoPromotions(history, cfg.companies, {
    threshold: flags.threshold, requireListUnsub: flags.requireListUnsub, correspondentsByAccount,
  });
  const counts = Object.fromEntries(Object.entries(promotions).map(([a, r]) => [a, r.length]));
  if (flags.apply && !flags.dry) {
    const added = applyPromotions(cfg, promotions);
    atomicWrite(cfgPath, JSON.stringify(cfg, null, 2));
    process.stdout.write(JSON.stringify({ applied: added.length, byAccount: counts }, null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ wouldPromote: counts, dry: true }, null, 2) + "\n");
  }
}
