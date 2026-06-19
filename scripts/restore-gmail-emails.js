/**
 * restore-gmail-emails.js <accountId> <messageId1> [messageId2 ...]
 *
 * Untrashes the specified Gmail messages (undo of a soft delete). Untrash only —
 * never sends or permanent-deletes.
 */
import { buildGmailClient } from "./gmail-client.js";
import { verifyGmailAccount } from "./gmail-verify.js";

const [, , accountIdArg, ...messageIds] = process.argv;
if (!accountIdArg || messageIds.length === 0) {
  console.error("Usage: node scripts/restore-gmail-emails.js <accountId> <messageId1> [messageId2 ...]");
  process.exit(1);
}
const gmail = await buildGmailClient();
await verifyGmailAccount(gmail, accountIdArg);
let restored = 0, failed = 0;
for (const id of messageIds) {
  try { await gmail.users.messages.untrash({ userId: "me", id }); restored++; }
  catch (err) { console.error(`Failed to untrash ${id}: ${err.message}`); failed++; }
}
console.log(`Done: ${restored} restored${failed ? `, ${failed} failed` : ""}.`);
