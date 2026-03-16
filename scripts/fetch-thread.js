/**
 * fetch-thread.js <accountId> <messageId>
 *
 * Fetches the full email thread for an Outlook account via Microsoft Graph API.
 * Returns JSON to stdout: { threadId, subject, messages: [...] }
 *
 * Usage:
 *   node scripts/fetch-thread.js <accountId> <messageId>
 */
import { buildGraphClient } from "./graph-client.js";

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

export function transformGraphMessages(messages) {
  const sorted = [...messages].sort(
    (a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime)
  );
  const first = sorted[0];
  return {
    threadId: first.conversationId,
    subject: first.subject,
    messages: sorted.map((m) => ({
      messageId: m.id,
      from: m.from.emailAddress.address,
      fromName: m.from.emailAddress.name,
      to: (m.toRecipients || []).map((r) => r.emailAddress.address),
      cc: (m.ccRecipients || []).map((r) => r.emailAddress.address),
      received: m.receivedDateTime,
      body: m.body?.contentType === "html" ? stripHtml(m.body.content) : (m.body?.content ?? ""),
    })),
  };
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith("fetch-thread.js")) {
  const [, , accountId, messageId] = process.argv;
  if (!accountId || !messageId) {
    console.error("Usage: node scripts/fetch-thread.js <accountId> <messageId>");
    process.exit(1);
  }
  const client = await buildGraphClient(accountId);
  const msg = await client.api(`/me/messages/${messageId}`).select("conversationId").get();
  const conversationId = msg.conversationId;
  const response = await client
    .api("/me/messages")
    .filter(`conversationId eq '${conversationId}'`)
    .select("id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,body")
    .orderby("receivedDateTime asc")
    .top(50)
    .get();
  const result = transformGraphMessages(response.value);
  console.log(JSON.stringify(result, null, 2));
}
