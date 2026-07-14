/**
 * delete-emails.js <companyId> <messageId1> [messageId2 ...]
 *
 * Moves the specified messages to Deleted Items (soft delete, recoverable).
 * Thin shim over scripts/mail.js deleteEmails, which performs the Graph API
 * move to the deleteditems folder.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteEmails } from "./mail.js";

const [, , companyId, ...messageIds] = process.argv;

if (!companyId || messageIds.length === 0) {
  console.error("Usage: node scripts/delete-emails.js <companyId> <messageId1> [messageId2 ...]");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
const account = companies.companies.find((c) => c.id === companyId) || { id: companyId, provider: "outlook" };

const r = await deleteEmails(account, messageIds);
for (const id of r.failedIds) console.error(`FAILED: ${id}`);
console.log(`Done: ${r.trashed} trashed${r.failed ? `, ${r.failed} failed` : ""}.`);
