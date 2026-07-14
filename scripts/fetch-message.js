/**
 * fetch-message.js <accountId> <messageId>
 *
 * Fetches ONE message's body by id and prints { id, body } (plain text) to
 * stdout. Read-only: no send, no delete. Thin shim over scripts/mail.js
 * fetchMessageBody, which branches on the account's provider (Outlook Graph
 * vs Gmail). HTML bodies are stripped to text before output; the panel never
 * renders raw HTML.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMessageBody } from "./mail.js";
import "dotenv/config";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Re-export extractGmailBody for any callers that import from fetch-message.js
export { extractGmailBody } from "./mail.js";

if (process.argv[1] && process.argv[1].endsWith("fetch-message.js")) {
  const accountId = process.argv[2];
  const messageId = process.argv[3];
  if (!accountId || !messageId) {
    console.error("Usage: node scripts/fetch-message.js <accountId> <messageId>");
    process.exit(1);
  }
  try {
    const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
    const account = companies.companies.find((c) => c.id === accountId);
    if (!account) throw new Error(`unknown account: ${accountId}`);
    const out = await fetchMessageBody(account, messageId);
    process.stdout.write(JSON.stringify(out));
  } catch (err) {
    console.error(`fetch-message.js failed: ${err.message}`);
    process.exit(1);
  }
}
