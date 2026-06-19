/**
 * restore-emails.js <companyId> <messageId1> [messageId2 ...]
 *
 * Moves the specified messages from Deleted Items back to the Inbox (undo of a
 * soft delete). Move only — never sends or permanent-deletes.
 */
import { buildGraphClient } from "./graph-client.js";

const [, , companyId, ...messageIds] = process.argv;
if (!companyId || messageIds.length === 0) {
  console.error("Usage: node scripts/restore-emails.js <companyId> <messageId1> [messageId2 ...]");
  process.exit(1);
}
const client = await buildGraphClient(companyId);
let restored = 0, failed = 0;
for (const id of messageIds) {
  try { await client.api(`/me/messages/${id}/move`).post({ destinationId: "inbox" }); restored++; }
  catch (err) { console.error(`FAILED: ${id} — ${err.message}`); failed++; }
}
console.log(`Done: ${restored} restored${failed ? `, ${failed} failed` : ""}.`);
