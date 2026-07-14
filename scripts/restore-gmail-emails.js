/**
 * restore-gmail-emails.js <accountId> <messageId1> [messageId2 ...]
 *
 * Untrashes the specified Gmail messages (undo of a soft delete). Thin shim
 * over scripts/mail.js restoreEmails — untrash only, never sends or
 * permanent-deletes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { restoreEmails } from "./mail.js";

const [, , accountId, ...messageIds] = process.argv;

if (!accountId || messageIds.length === 0) {
  console.error("Usage: node scripts/restore-gmail-emails.js <accountId> <messageId1> [messageId2 ...]");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
const account = companies.companies.find((c) => c.id === accountId) || { id: accountId, provider: "gmail" };

const r = await restoreEmails(account, messageIds);
for (const id of r.failedIds) console.error(`FAILED: ${id}`);
console.log(`Done: ${r.restored} restored${r.failed ? `, ${r.failed} failed` : ""}.`);
