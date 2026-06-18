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
import { stripHtml } from "./fetch-emails.js";
import "dotenv/config";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pure: best-effort plain text from a Gmail message payload. Prefers text/plain,
 * then stripped text/html, then a top-level body; recurses into multipart parts.
 */
export function extractGmailBody(payload) {
  if (!payload) return "";
  const decode = (data) =>
    Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  let plain = "", html = "";
  const walk = (p) => {
    if (!p) return;
    const mt = p.mimeType || "";
    if (mt === "text/plain" && p.body?.data && !plain) plain = decode(p.body.data);
    else if (mt === "text/html" && p.body?.data && !html) html = decode(p.body.data);
    for (const c of p.parts || []) walk(c);
  };
  walk(payload);
  if (plain) return plain.trim();
  if (html) return stripHtml(html);
  if (payload.body?.data) return decode(payload.body.data).trim();
  return "";
}

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
