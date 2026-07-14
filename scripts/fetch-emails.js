/**
 * fetch-emails.js
 * Fetches recent emails from a mailbox via Microsoft Graph API.
 *
 * Usage:
 *   node scripts/fetch-emails.js [companyId] [hours] [folder] [top] [bodyChars]
 *
 * Examples:
 *   node scripts/fetch-emails.js healthcarema 24 inbox
 *   node scripts/fetch-emails.js healthcarema 24 inbox 200
 *   node scripts/fetch-emails.js healthcarema 24 inbox 200 5000
 *
 * Output: JSON array of email objects printed to stdout.
 */

import { buildGraphClient } from "./graph-client.js";
import { stripHtml } from "./mail.js";
import "dotenv/config";

export { stripHtml } from "./mail.js";

// CLI entrypoint — guarded so the module can be imported for tests without
// executing the fetch (Windows-safe: checks the resolved script path).
if (process.argv[1] && process.argv[1].endsWith("fetch-emails.js")) {
  const companyId = process.argv[2] || "healthcarema";
  const hours = parseInt(process.argv[3] || "24", 10);
  const folder = process.argv[4] || "inbox";
  const top = parseInt(process.argv[5] || "50", 10);
  const bodyChars = parseInt(process.argv[6] || "0", 10);

  const email = process.env[`${companyId.toUpperCase()}_EMAIL`];
  if (!email) {
    console.error(`Missing ${companyId.toUpperCase()}_EMAIL in .env`);
    process.exit(1);
  }

  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  try {
    const client = await buildGraphClient(companyId);

    // Build the select fields — only include body when bodyChars > 0
    const selectFields = "id,subject,from,receivedDateTime,isRead,bodyPreview,importance,hasAttachments";
    const select = bodyChars > 0 ? `${selectFields},body` : selectFields;

    // Paginate to collect up to `top` messages
    const collected = [];
    const pageSize = Math.min(top, 1000);

    let response = await client
      .api(`/users/${email}/mailFolders/${folder}/messages`)
      .filter(`receivedDateTime ge ${since}`)
      .select(select)
      .orderby("receivedDateTime desc")
      .top(pageSize)
      .get();

    collected.push(...(response.value || []));

    // Follow @odata.nextLink pages until we have enough or pages are exhausted
    while (response["@odata.nextLink"] && collected.length < top) {
      response = await client.api(response["@odata.nextLink"]).get();
      collected.push(...(response.value || []));
    }

    // Trim to requested top
    const messages = collected.slice(0, top);

    const emails = messages.map((msg) => {
      const obj = {
        id: msg.id,
        subject: msg.subject,
        from: msg.from?.emailAddress?.address,
        fromName: msg.from?.emailAddress?.name,
        received: msg.receivedDateTime,
        receivedAt: msg.receivedDateTime,
        isRead: msg.isRead,
        importance: msg.importance,
        hasAttachments: msg.hasAttachments,
        preview: msg.bodyPreview?.slice(0, 300),
      };
      if (bodyChars > 0) {
        obj.body = stripHtml(msg.body?.content || "").slice(0, bodyChars);
      }
      return obj;
    });

    console.log(JSON.stringify(emails, null, 2));
  } catch (err) {
    console.error("Error fetching emails:", err.message);
    process.exit(1);
  }
}
