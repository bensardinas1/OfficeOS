/**
 * fetch-emails.js
 * Fetches recent emails from a mailbox via Microsoft Graph API.
 *
 * Usage:
 *   node scripts/fetch-emails.js [companyId] [hours] [folder]
 *
 * Examples:
 *   node scripts/fetch-emails.js healthcarema 24 inbox
 *   node scripts/fetch-emails.js healthcarema 48 inbox
 *
 * Output: JSON array of email objects printed to stdout.
 */

import { buildGraphClient } from "./graph-client.js";
import "dotenv/config";

const companyId = process.argv[2] || "healthcarema";
const hours = parseInt(process.argv[3] || "24", 10);
const folder = process.argv[4] || "inbox";

const email = process.env[`${companyId.toUpperCase()}_EMAIL`];
if (!email) {
  console.error(`Missing ${companyId.toUpperCase()}_EMAIL in .env`);
  process.exit(1);
}

const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

try {
  const client = await buildGraphClient(companyId);

  const response = await client
    .api(`/users/${email}/mailFolders/${folder}/messages`)
    .filter(`receivedDateTime ge ${since}`)
    .select("id,subject,from,receivedDateTime,isRead,bodyPreview,importance,hasAttachments")
    .orderby("receivedDateTime desc")
    .top(50)
    .get();

  const emails = (response.value || []).map((msg) => ({
    id: msg.id,
    subject: msg.subject,
    from: msg.from?.emailAddress?.address,
    fromName: msg.from?.emailAddress?.name,
    received: msg.receivedDateTime,
    isRead: msg.isRead,
    importance: msg.importance,
    hasAttachments: msg.hasAttachments,
    preview: msg.bodyPreview?.slice(0, 300),
  }));

  console.log(JSON.stringify(emails, null, 2));
} catch (err) {
  console.error("Error fetching emails:", err.message);
  process.exit(1);
}
