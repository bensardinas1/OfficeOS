/**
 * delete-emails.js <companyId> <messageId1> [messageId2 ...]
 *
 * Moves the specified messages to Deleted Items (soft delete, recoverable).
 * Uses the Microsoft Graph API via the shared graph-client.
 */
import { buildGraphClient } from "./graph-client.js";

const [,, companyId, ...messageIds] = process.argv;

if (!companyId || messageIds.length === 0) {
  console.error("Usage: node scripts/delete-emails.js <companyId> <messageId1> [messageId2 ...]");
  process.exit(1);
}

const client = await buildGraphClient(companyId);

let trashed = 0;
let failed = 0;

for (const id of messageIds) {
  try {
    await client.api(`/me/messages/${id}/move`).post({ destinationId: "deleteditems" });
    trashed++;
  } catch (err) {
    console.error(`FAILED: ${id} — ${err.message}`);
    failed++;
  }
}

console.log(`Done: ${trashed} trashed${failed ? `, ${failed} failed` : ""}.`);
