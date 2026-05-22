/**
 * fetch-gmail.js <accountId> <hours> <folder>
 *
 * Fetches recent Gmail messages via the Gmail REST API (no MCP).
 *
 * Args:
 *   accountId — account id from config/companies.json (informational; Gmail client
 *               authenticates via stored OAuth tokens, not per-account credentials).
 *   hours     — lookback window in hours (default 24).
 *   folder    — ignored for Gmail; included for interface parity with fetch-emails.js.
 *
 * Output: JSON array of email objects matching the shape produced by fetch-emails.js
 *         (id, subject, from, fromName, received, receivedAt, isRead, importance,
 *          hasAttachments, preview, hasListUnsubscribe, precedence).
 */

import { buildGmailClient } from "./gmail-client.js";
import "dotenv/config";

const accountId = process.argv[2] || "personal";
const hours = parseInt(process.argv[3] || "24", 10);
// const folder = process.argv[4] || "inbox"; // unused — Gmail uses labels, not folders

const sinceUnixSec = Math.floor(Date.now() / 1000) - hours * 3600;

try {
  const gmail = await buildGmailClient();

  // List message IDs in inbox newer than `sinceUnixSec`.
  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: `in:inbox after:${sinceUnixSec}`,
    maxResults: 100,
  });
  const ids = (listRes.data.messages || []).map(m => m.id);

  // Fetch metadata in parallel.
  const messages = await Promise.all(
    ids.map(async (id) => {
      const res = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe", "Precedence"],
      });
      const headers = res.data.payload?.headers || [];
      const h = (name) => (headers.find(x => x.name.toLowerCase() === name.toLowerCase())?.value || "");
      const fromHeader = h("From");
      // "Display Name <user@host.com>" or "user@host.com"
      const angleMatch = fromHeader.match(/^([^<]*)<([^>]+)>$/);
      const fromName = angleMatch ? angleMatch[1].trim().replace(/^"|"$/g, "") : "";
      const from = angleMatch ? angleMatch[2].trim() : fromHeader.trim();
      const received = h("Date");
      return {
        id,
        threadId: res.data.threadId,
        subject: h("Subject"),
        from,
        fromName,
        received,
        receivedAt: received ? new Date(received).toISOString() : null,
        isRead: !(res.data.labelIds || []).includes("UNREAD"),
        importance: "normal",
        hasAttachments: false, // metadata format doesn't expose attachments cheaply
        preview: res.data.snippet || "",
        hasListUnsubscribe: !!h("List-Unsubscribe"),
        precedence: h("Precedence").toLowerCase(),
        gmailCategories: res.data.labelIds || [],
      };
    })
  );

  process.stdout.write(JSON.stringify(messages, null, 2));
} catch (err) {
  console.error(`fetch-gmail.js failed: ${err.message}`);
  process.exit(1);
}
