/**
 * restore-emails.js <companyId> <messageId1> [messageId2 ...]
 *
 * Moves the specified messages from Deleted Items back to the Inbox (undo of a
 * soft delete). Thin shim over scripts/mail.js restoreEmails — move only, never
 * sends or permanent-deletes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { restoreEmails } from "./mail.js";

const [, , companyId, ...messageIds] = process.argv;

if (!companyId || messageIds.length === 0) {
  console.error("Usage: node scripts/restore-emails.js <companyId> <messageId1> [messageId2 ...]");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
const account = companies.companies.find((c) => c.id === companyId) || { id: companyId, provider: "outlook" };

const r = await restoreEmails(account, messageIds);
for (const id of r.failedIds) console.error(`FAILED: ${id}`);
console.log(`Done: ${r.restored} restored${r.failed ? `, ${r.failed} failed` : ""}.`);
