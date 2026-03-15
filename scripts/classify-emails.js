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

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const companies = JSON.parse(
    readFileSync(join(__dirname, "../config/companies.json"), "utf-8")
  );
  const accountTypes = JSON.parse(
    readFileSync(join(__dirname, "../config/account-types.json"), "utf-8")
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

export function matchesDownrank(email, downrankList) {
  const text = `${email.subject || ""} ${email.fromName || ""} ${email.from || ""} ${email.preview || ""}`.toLowerCase();
  return downrankList.some(term => text.includes(term.toLowerCase()));
}

export function matchesUrgencyFlags(email, flags) {
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();
  return flags.some(flag => text.includes(flag.toLowerCase()));
}

export function classifyEmail(email, account, typeConfig, categories, downrankList) {
  // 1. Downrank check (type defaults + account-level) → IGNORE
  if (matchesDownrank(email, downrankList)) return "ignore";

  // 2. Rich category overrides — check each for its own senders, urgency flags, and downrank
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
    return classifyPersonalEmail(email, categories);
  }
  return "fyi";
}

function classifyPersonalEmail(email, categories) {
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();

  if (/statement|bill|invoice|payment.due|balance.due|autopay|account.alert|due.date/.test(text)) return "bills";
  if (/appointment|your.visit|check.?up|scheduled|reminder|seeing.you/.test(text)) return "appointments";
  if (/booking|itinerary|flight|hotel|reservation|check.?in|boarding|gate.change/.test(text)) return "travel";
  if (/order|shipped|delivered|tracking|return|refund|receipt/.test(text)) return "shopping";
  if (/subscription|renewal|renew|expires|membership|plan.change/.test(text)) return "subscriptions";
  if (/gym|workout|fitness|class|wellness/.test(text)) return "fitness";
  if (/invited|invitation|rsvp|party|gathering/.test(text)) return "social";

  // Default personal fallback
  const newsletterCat = categories.find(c => c.id === "newsletters");
  return newsletterCat ? "newsletters" : (categories.find(c => !c.hidden)?.id ?? "ignore");
}
