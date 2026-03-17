/**
 * delete-gmail-emails.js <messageId1> [messageId2 ...]
 *
 * Moves the specified Gmail messages to trash (soft delete, recoverable for 30 days).
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

let trashed = 0;
let failed = 0;

for (const id of messageIds) {
  try {
    await gmail.users.messages.trash({ userId: "me", id });
    trashed++;
  } catch (err) {
    console.error(`Failed to trash ${id}: ${err.message}`);
    failed++;
  }
}

console.log(`Done: ${trashed} trashed${failed ? `, ${failed} failed` : ""}.`);
