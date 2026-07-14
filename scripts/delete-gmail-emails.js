/**
 * delete-gmail-emails.js <accountId> <messageId1> [messageId2 ...]
 *
 * Moves the specified Gmail messages to trash (soft delete, recoverable for
 * 30 days). Thin shim over scripts/mail.js deleteEmails, which calls
 * users.messages.trash per id.
 *
 * Usage:
 *   node scripts/delete-gmail-emails.js <accountId> <id1> <id2> ...
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteEmails } from "./mail.js";

const [, , accountId, ...messageIds] = process.argv;

if (!accountId || messageIds.length === 0) {
  console.error("Usage: node scripts/delete-gmail-emails.js <accountId> <messageId1> [messageId2 ...]");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
const account = companies.companies.find((c) => c.id === accountId) || { id: accountId, provider: "gmail" };

const r = await deleteEmails(account, messageIds);
for (const id of r.failedIds) console.error(`FAILED: ${id}`);
console.log(`Done: ${r.trashed} trashed${r.failed ? `, ${r.failed} failed` : ""}.`);
