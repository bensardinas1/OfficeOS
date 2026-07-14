/**
 * fetch-gmail.js <accountId> <hours> <folder>
 *
 * Fetches recent Gmail messages. Thin shim over scripts/mail.js fetchMail,
 * whose Gmail client factory verifies the authenticated session matches the
 * configured account (verifyGmailAccount) before any operation runs.
 *
 * Args:
 *   accountId — account id from config/companies.json (informational; Gmail client
 *               authenticates via stored OAuth tokens, not per-account credentials).
 *   hours     — lookback window in hours (default 24).
 *   folder    — ignored for Gmail; included for interface parity with fetch-emails.js.
 *
 * Output: JSON array of email objects matching the shape produced by fetch-emails.js
 *         (id, threadId, subject, from, fromName, received, receivedAt, isRead,
 *          importance, hasAttachments, preview, hasListUnsubscribe, precedence,
 *          toRecipients, ccRecipients, gmailCategories).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMail } from "./mail.js";
import "dotenv/config";

const accountId = process.argv[2] || "personal";
const hours = parseInt(process.argv[3] || "24", 10);
// const folder = process.argv[4] || "inbox"; // unused — Gmail uses labels, not folders

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
  const account = companies.companies.find((c) => c.id === accountId) || { id: accountId, provider: "gmail" };

  // Preserve today's 100-message cap.
  const messages = await fetchMail(account, { hours, max: 100 });

  process.stdout.write(JSON.stringify(messages, null, 2));
} catch (err) {
  console.error(`fetch-gmail.js failed: ${err.message}`);
  process.exit(1);
}
