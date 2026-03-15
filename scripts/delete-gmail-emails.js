/**
 * delete-gmail-emails.js <messageId1> [messageId2 ...]
 *
 * Moves the specified Gmail messages to trash using batch delete.
 *
 * Usage:
 *   node scripts/delete-gmail-emails.js <id1> <id2> ...
 */

import { buildGmailClient } from "./gmail-client.js";

const messageIds = process.argv.slice(2);

if (messageIds.length === 0) {
  console.error("Usage: node scripts/delete-gmail-emails.js <messageId1> [messageId2 ...]");
  process.exit(1);
}

const gmail = await buildGmailClient();

try {
  await gmail.users.messages.batchDelete({
    userId: "me",
    requestBody: { ids: messageIds },
  });
  console.log(`Done: ${messageIds.length} deleted.`);
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
