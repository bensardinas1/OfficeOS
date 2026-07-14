/**
 * fetch-message.js <accountId> <messageId>
 *
 * Fetches ONE message's body by id and prints { id, body } (plain text) to
 * stdout. Read-only: no send, no delete. Branches on the account's provider
 * (Outlook Graph vs Gmail). HTML bodies are stripped to text before output;
 * the panel never renders raw HTML.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractGmailBody, stripHtml } from "./mail.js";
import "dotenv/config";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Re-export extractGmailBody for any callers that import from fetch-message.js
export { extractGmailBody };

async function outlookBody(accountId, messageId) {
  const { buildGraphClient } = await import("./graph-client.js");
  const email = process.env[`${accountId.toUpperCase()}_EMAIL`];
  const client = await buildGraphClient(accountId);
  const path = email ? `/users/${email}/messages/${messageId}` : `/me/messages/${messageId}`;
  const msg = await client.api(path).select("id,body").get();
  return { id: msg.id, body: stripHtml(msg.body?.content || "") };
}

async function gmailBody(messageId) {
  const { buildGmailClient } = await import("./gmail-client.js");
  const gmail = await buildGmailClient();
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  return { id: res.data.id, body: extractGmailBody(res.data.payload) };
}

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
    const out = account.provider === "gmail" ? await gmailBody(messageId) : await outlookBody(accountId, messageId);
    process.stdout.write(JSON.stringify(out));
  } catch (err) {
    console.error(`fetch-message.js failed: ${err.message}`);
    process.exit(1);
  }
}
