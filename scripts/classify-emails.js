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
