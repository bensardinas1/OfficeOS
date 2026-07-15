/**
 * classify-emails.js
 *
 * Processor: classifies a raw email array for a given account.
 *
 * CLI usage:
 *   node scripts/fetch-emails.js <accountId> 24 inbox | node scripts/classify-emails.js <accountId>
 *
 * Exports:
 *   classify(emails, accountId) → ClassificationResult
 *   resolveCategories(typeConfig, account) → Category[]
 *   resolveDownrank(typeConfig, account) → string[]
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorrespondentsFile, correspondentSet } from "./correspondents.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configRoot = join(__dirname, "../config");
  const companies = JSON.parse(
    readFileSync(join(configRoot, "companies.json"), "utf-8")
  );
  const accountTypes = JSON.parse(
    readFileSync(join(configRoot, "account-types.json"), "utf-8")
  );
  return { companies, accountTypes };
}

export function resolveCategories(typeConfig, account) {
  let categories = [...typeConfig.triageCategories];
  for (const override of (account.categoryOverrides || [])) {
    const idx = categories.findIndex(c => c.id === override.id);
    if (idx >= 0) {
      categories[idx] = override;
    } else {
      categories.push(override);
    }
  }
  return categories;
}

export function resolveDownrank(typeConfig, account) {
  return [
    ...(typeConfig.downrankDefaults || []),
    ...(account.downrank || []),
  ];
}

export function matchesSender(email, senders) {
  const fromEmail = (email.from || "").toLowerCase();
  const fromName = (email.fromName || "").toLowerCase();
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();

  for (const sender of senders) {
    if (sender.type === "domain") {
      const domain = fromEmail.split("@")[1];
      if (domain === sender.value.toLowerCase()) return true;
    } else if (sender.type === "name") {
      if (fromName.includes(sender.value.toLowerCase())) return true;
    } else if (sender.type === "email") {
      if (fromEmail === sender.value.toLowerCase()) return true;
    } else if (sender.type === "keyword") {
      if (text.includes(sender.value.toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * Returns true if `rule` matches `email` (using same logic as matchesSender for a single sender)
 * AND the rule's `unless` clause (if present) does NOT match.
 *
 * Used for alwaysDelete entries to support conditional senders like:
 *   { type: "name", value: "eBay", unless: { subjectContains: ["delivered", "order"] } }
 *
 * Note: only email.subject is tested — preview is intentionally excluded.
 */
export function senderRuleApplies(email, rule) {
  if (!matchesSender(email, [rule])) return false;
  if (!rule.unless) return true;
  const subject = (email.subject || "").toLowerCase();
  const unlessSubject = rule.unless.subjectContains || [];
  for (const term of unlessSubject) {
    if (subject.includes(term.toLowerCase())) return false;
  }
  return true;
}

/**
 * Returns true if the email matches the scamPattern:
 *   - subject contains ALL of pattern.subjectAll (case-insensitive)
 *   - sender's domain is NOT in pattern.senderAllowlist (case-insensitive)
 *
 * Empty subjectAll never matches (defensive). Used to catch recurring scams
 * that arrive from rotating third-party domains (e.g., Annual Report filing scam).
 */
export function matchesScamPattern(email, pattern) {
  const subjectAll = pattern.subjectAll || [];
  if (subjectAll.length === 0) return false;
  const subject = (email.subject || "").toLowerCase();
  for (const term of subjectAll) {
    if (!subject.includes(term.toLowerCase())) return false;
  }
  const fromDomain = ((email.from || "").split("@")[1] || "").toLowerCase();
  const allowlist = (pattern.senderAllowlist || []).map(d => d.toLowerCase());
  if (allowlist.includes(fromDomain)) return false;
  return true;
}

export function matchesDownrank(email, downrankList) {
  const text = `${email.subject || ""} ${email.fromName || ""} ${email.from || ""} ${email.preview || ""}`.toLowerCase();
  return downrankList.some(term => text.includes(term.toLowerCase()));
}

export function matchesDeletionPattern(email, patterns) {
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();
  return patterns.some(pattern => text.includes(pattern.toLowerCase()));
}

// A flag matches as a whole word/phrase: "need" fires on "we need this" and
// "need-by date" but not "needed" or "kneading"; multi-word flags match as
// phrases across any whitespace run. Boundary = anything that isn't [a-z0-9].
const FLAG_REGEX_CACHE = new Map();
function urgencyFlagRegex(flag) {
  if (FLAG_REGEX_CACHE.has(flag)) return FLAG_REGEX_CACHE.get(flag);
  const words = String(flag).trim().split(/\s+/).filter(Boolean)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = words.length
    ? new RegExp(`(?<![a-z0-9])(?:${words.join("\\s+")})(?![a-z0-9])`, "i")
    : null; // empty/whitespace flag matches nothing
  FLAG_REGEX_CACHE.set(flag, re);
  return re;
}

export function matchesUrgencyFlags(email, flags) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  return flags.some(flag => {
    const re = urgencyFlagRegex(flag);
    return re ? re.test(text) : false;
  });
}

const MARKETING_SUBDOMAINS = ["mail.", "email.", "news.", "marketing.", "updates.", "info.", "noreply."];

export function detectBulkSignals(email, userEmail) {
  const signals = [];

  // 1. List-Unsubscribe header
  if (email.hasListUnsubscribe) {
    signals.push("list-unsubscribe");
  }

  // 2. Precedence header
  const prec = (email.precedence || "").toLowerCase();
  if (prec === "bulk" || prec === "list") {
    signals.push("precedence");
  }

  // 3. Gmail category labels
  const cats = email.gmailCategories || [];
  if (cats.includes("CATEGORY_PROMOTIONS") || cats.includes("CATEGORY_FORUMS")) {
    signals.push("gmail-category");
  }

  // 4. BCC detection — user's email not in To or CC (only when To/CC data is present)
  if (userEmail) {
    const to = (email.toRecipients || "").toLowerCase();
    const cc = (email.ccRecipients || "").toLowerCase();
    const me = userEmail.toLowerCase();
    const hasRecipientData = to.length > 0 || cc.length > 0;
    if (hasRecipientData && !to.includes(me) && !cc.includes(me)) {
      signals.push("bcc");
    }
  }

  // 5. Marketing subdomain
  const fromDomain = (email.from || "").split("@")[1] || "";
  if (MARKETING_SUBDOMAINS.some(prefix => fromDomain.startsWith(prefix))) {
    signals.push("marketing-subdomain");
  }

  return { score: signals.length, signals };
}

export function classifyEmail(email, account, typeConfig, categories, downrankList) {
  // 1. Downrank check (type defaults + account-level) → IGNORE
  if (matchesDownrank(email, downrankList)) return "ignore";

  // 2. Check if sender is protected (prioritySenders or neverDelete)
  const allPrioritySenders = [
    ...(account.prioritySenders || []),
    ...(account.neverDelete || []),
  ];
  const isProtected = allPrioritySenders.length > 0 && matchesSender(email, allPrioritySenders);

  // 3. Bulk signal check (skip for protected senders)
  if (!isProtected) {
    const threshold = account.bulkSignalThreshold ?? typeConfig.bulkSignalThreshold ?? 2;
    const { score } = detectBulkSignals(email, account.myEmail);
    if (score >= threshold) return "ignore";
  }

  // 4. Rich category overrides — check each for its own senders, urgency flags, and downrank
  for (const cat of categories) {
    if (cat.hidden) continue;
    if (cat.downrank && matchesDownrank(email, cat.downrank)) return "ignore";
    if (cat.prioritySenders?.length && matchesSender(email, cat.prioritySenders)) return cat.id;
    if (cat.urgencyRules?.flags?.length && matchesUrgencyFlags(email, cat.urgencyRules.flags)) return cat.id;
  }

  // 3. Account-level priority senders → action / respond
  if (account.prioritySenders?.length && matchesSender(email, account.prioritySenders)) {
    const actionCat = categories.find(c => c.id === "action" || c.id === "respond");
    if (actionCat) return actionCat.id;
  }

  // 4. Account-level urgency flags → action / respond
  if (account.urgencyRules?.flags?.length && matchesUrgencyFlags(email, account.urgencyRules.flags)) {
    const actionCat = categories.find(c => c.id === "action" || c.id === "respond");
    if (actionCat) return actionCat.id;
  }

  // 5. Default by account type
  if (account.accountType === "personal") {
    if (typeConfig.noiseFilters && applyNoiseFilter(email, typeConfig.noiseFilters)) return "ignore";
    return classifyPersonalEmail(email, categories);
  }
  return "fyi";
}

export function applyNoiseFilter(email, noiseFilters) {
  if (!noiseFilters) return false;
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();
  const matchesReject = (noiseFilters.signals_reject || []).some(s => text.includes(s));
  const matchesKeep = (noiseFilters.signals_keep || []).some(s => text.includes(s));
  if (matchesReject && !matchesKeep) return true;
  return false;
}

export function classify(emails, accountId, opts = {}) {
  const { companies, accountTypes } = opts.config ?? loadConfig();
  // Sent-mail-derived protection: addresses the user has written to are never
  // heuristically deleted. Explicit alwaysDelete/scam rules still win.
  const correspondents = opts.correspondents
    ?? correspondentSet(loadCorrespondentsFile(join(__dirname, "../data/correspondents.json")), accountId);
  const account = companies.companies.find(c => c.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const typeKey = account.accountType || "business";
  const typeConfig = accountTypes[typeKey];
  if (!typeConfig) throw new Error(`Account type not found: ${typeKey}`);

  const categories = resolveCategories(typeConfig, account);
  const downrankList = resolveDownrank(typeConfig, account);

  const result = {
    accountId,
    accountName: account.name,
    accountType: typeKey,
    categories: {},
    deletionCandidates: [],
    explicitDeletions: [],
    heuristicDeletions: [],
  };

  for (const cat of categories) {
    result.categories[cat.id] = { label: cat.label, hidden: cat.hidden || false, emails: [] };
  }

  // Merge neverDelete and alwaysDelete from type defaults + account overrides
  const policy = typeConfig.deletionPolicy || { categories: ["ignore"], patterns: [] };
  const neverDeleteList = [
    ...(policy.neverDelete || []),
    ...(account.neverDelete || []),
  ];
  const alwaysDeleteList = [
    ...(policy.alwaysDelete || []),
    ...(account.alwaysDelete || []),
  ];
  const scamPatterns = account.scamPatterns || [];
  const deletionCategoryIds = new Set(policy.categories);

  for (const email of emails) {
    let categoryId = classifyEmail(email, account, typeConfig, categories, downrankList);

    const isCorrespondent = correspondents.has((email.from || "").toLowerCase());
    const alwaysDeleteApplies = alwaysDeleteList.some(r => senderRuleApplies(email, r));
    // Subject-based scam patterns never fire on correspondents — a known contact
    // forwarding a scam-shaped subject is a person, not the scam. Sender-specific
    // alwaysDelete rules are deliberate config and still win over correspondence.
    const scamApplies = !isCorrespondent && scamPatterns.some(p => matchesScamPattern(email, p));
    const isProtected = matchesSender(email, neverDeleteList);
    const forceDelete = (alwaysDeleteApplies || scamApplies) && !isProtected;

    // alwaysDelete / scamPatterns override category — reclassify to ignore
    if (forceDelete) {
      categoryId = "ignore";
    }

    if (!result.categories[categoryId]) {
      result.categories[categoryId] = { label: categoryId, hidden: false, emails: [] };
    }
    result.categories[categoryId].emails.push(email);

    // Force into deletion candidates — explicit (deliberate config rule)
    if (forceDelete) {
      result.deletionCandidates.push(email);
      result.explicitDeletions.push(email);
    }
    // neverDelete protects against pattern/category-based deletion;
    // correspondents (user has emailed this address) protect the heuristic path too
    else if (isProtected || isCorrespondent) {
      // skip — protected sender
    }
    // Standard category/pattern-based deletion — heuristic (guessed)
    else if (deletionCategoryIds.has(categoryId) || matchesDeletionPattern(email, policy.patterns || [])) {
      result.deletionCandidates.push(email);
      result.heuristicDeletions.push(email);
    }
  }

  return result;
}

function classifyPersonalEmail(email, categories) {
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();

  if (/statement|bill|invoice|payment.due|balance.due|autopay|account.alert|due.date/.test(text)) return "bills";
  if (/appointment|your.visit|check.?up|scheduled|reminder|seeing.you/.test(text)) return "appointments";
  if (/order|shipped|delivered|tracking|\breturn\b|refund|receipt/.test(text)) return "shopping";
  if (/subscription|renewal|renew|expires|membership|plan.change/.test(text)) return "subscriptions";

  // Default personal fallback — newsletters if available, otherwise first non-hidden category
  const newsletterCat = categories.find(c => c.id === "newsletters");
  return newsletterCat ? "newsletters" : (categories.find(c => !c.hidden)?.id ?? "ignore");
}

// CLI entrypoint — only runs when executed directly, not when imported
if (process.argv[1] && process.argv[1].endsWith("classify-emails.js")) {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error("Usage: node scripts/fetch-emails.js <accountId> 24 inbox | node scripts/classify-emails.js <accountId>");
    process.exit(1);
  }

  let raw = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", chunk => { raw += chunk; });
  process.stdin.on("end", () => {
    try {
      const emailList = JSON.parse(raw);
      const result = classify(emailList, accountId);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("Error:", err.message);
      process.exit(1);
    }
  });
}
