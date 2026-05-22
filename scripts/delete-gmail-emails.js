/**
 * delete-gmail-emails.js <messageId1> [messageId2 ...]
 *
 * Moves the specified Gmail messages to trash (soft delete, recoverable for 30 days).
 *
 * Usage:
 *   node scripts/delete-gmail-emails.js <id1> <id2> ...
 */

import { buildGmailClient } from "./gmail-client.js";
import { verifyGmailAccount } from "./gmail-verify.js";

// First positional is accountId; we use it to verify the authenticated Gmail
// session matches the configured account before mutating any messages.
const [, , accountIdArg, ...messageIds] = process.argv;

if (!accountIdArg || messageIds.length === 0) {
  console.error("Usage: node scripts/delete-gmail-emails.js <accountId> <messageId1> [messageId2 ...]");
  process.exit(1);
}

const gmail = await buildGmailClient();
await verifyGmailAccount(gmail, accountIdArg);

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
