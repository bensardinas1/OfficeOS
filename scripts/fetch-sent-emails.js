/**
 * fetch-sent-emails.js <accountId> [count]
 *
 * Fetches recent sent emails for voice profile analysis.
 * Returns JSON array to stdout: [{ to, cc, subject, body, sent }, ...]
 *
 * Usage:
 *   node scripts/fetch-sent-emails.js <accountId> 60
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraphClient } from "./graph-client.js";
import { buildGmailClient } from "./gmail-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = join(__dirname, "../config/companies.json");
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function isOriginalEmail({ subject, body }) {
  const subj = (subject || "").toLowerCase();
  const text = (body || "").toLowerCase();

  // Filter forwarded messages
  if (subj.startsWith("fw:") || subj.startsWith("fwd:")) return false;

  // Filter calendar responses
  if (/^(accepted|declined|tentative|tentatively accepted):/.test(subj)) return false;

  // Filter auto-replies
  if (text.includes("out of office") || text.includes("automatic reply")) return false;

  return true;
}

export function transformSentEmails(messages) {
  if (!messages || messages.length === 0) return [];

  return messages
    .map((m) => ({
      to: (m.toRecipients || []).map((r) => r.emailAddress.address),
      cc: (m.ccRecipients || []).map((r) => r.emailAddress.address),
      subject: m.subject || "",
      body: m.body?.contentType === "html" ? stripHtml(m.body.content) : (m.body?.content ?? ""),
      sent: m.sentDateTime,
    }))
    .filter((e) => isOriginalEmail(e));
}

function splitAddresses(header) {
  const addresses = [];
  let current = "";
  let inQuotes = false;
  for (const ch of header) {
    if (ch === '"') { inQuotes = !inQuotes; current += ch; }
    else if (ch === "," && !inQuotes) {
      const addr = current.trim().replace(/.*<([^>]+)>/, "$1");
      if (addr) addresses.push(addr);
      current = "";
    } else { current += ch; }
  }
  const last = current.trim().replace(/.*<([^>]+)>/, "$1");
  if (last) addresses.push(last);
  return addresses;
}

async function fetchOutlook(accountId, count) {
  const client = await buildGraphClient(accountId);
  const response = await client
    .api("/me/mailFolders/sentitems/messages")
    .select("id,subject,toRecipients,ccRecipients,body,sentDateTime")
    .orderby("sentDateTime desc")
    .top(count)
    .get();
  return transformSentEmails(response.value || []);
}

async function fetchGmail(count) {
  const gmail = await buildGmailClient();
  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: "in:sent",
    maxResults: count,
  });
  const messageIds = (listRes.data.messages || []).map((m) => m.id);

  const messages = [];
  for (const id of messageIds) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
    const headers = msg.data.payload?.headers || [];
    const getHeader = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

    // Extract body from payload (walks nested multipart MIME trees)
    function findPart(payload, mimeType) {
      if (payload.mimeType === mimeType && payload.body?.data) return payload;
      for (const part of (payload.parts || [])) {
        const found = findPart(part, mimeType);
        if (found) return found;
      }
      return null;
    }
    function decodeBase64Url(data) {
      return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    }
    let bodyContent = "";
    let bodyType = "text";
    const textPart = findPart(msg.data.payload, "text/plain");
    const htmlPart = findPart(msg.data.payload, "text/html");
    if (textPart?.body?.data) {
      bodyContent = decodeBase64Url(textPart.body.data);
    } else if (htmlPart?.body?.data) {
      bodyContent = decodeBase64Url(htmlPart.body.data);
      bodyType = "html";
    } else if (msg.data.payload?.body?.data) {
      bodyContent = decodeBase64Url(msg.data.payload.body.data);
      if (msg.data.payload?.mimeType === "text/html") bodyType = "html";
    }

    messages.push({
      toRecipients: splitAddresses(getHeader("To")).map((addr) => ({
        emailAddress: { address: addr },
      })),
      ccRecipients: getHeader("Cc") ? splitAddresses(getHeader("Cc")).map((addr) => ({
        emailAddress: { address: addr },
      })) : [],
      subject: getHeader("Subject"),
      sentDateTime: new Date(getHeader("Date")).toISOString(),
      body: { content: bodyContent, contentType: bodyType },
    });
  }
  return transformSentEmails(messages);
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith("fetch-sent-emails.js")) {
  const accountId = process.argv[2];
  const count = parseInt(process.argv[3] || "50", 10);
  if (!accountId) {
    console.error("Usage: node scripts/fetch-sent-emails.js <accountId> [count]");
    process.exit(1);
  }
  try {
    const config = loadConfig();
    const account = config.companies.find((c) => c.id === accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);

    let emails;
    if (account.provider === "gmail") {
      emails = await fetchGmail(count);
    } else {
      emails = await fetchOutlook(accountId, count);
    }
    console.log(JSON.stringify(emails, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}
