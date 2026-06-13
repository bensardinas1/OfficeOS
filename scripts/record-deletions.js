/**
 * record-deletions.js <trashed-msgids.json>
 *
 * Going-forward learning hook for the clean path. After the skill soft-deletes,
 * call this with the trashed msgids: it looks each up in the last-run bundle and
 * increments that sender's consecutive-deletion counter in data/sender-history.json.
 * Then `promote-senders.js --apply` graduates senders that cross the threshold to
 * the permanent kill-list (so the reasoner never judges them again).
 *
 * Senders NOT in the trash list that survived this run get their counter reset
 * (recordKeep) — a sender must be deleted CONSECUTIVELY to graduate.
 *
 * Input: JSON array of msgids, or of {msgid} objects. Bundle: data/.last-run-bundle.json.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHistory, saveHistory, recordDeletion, recordKeep } from "./sender-history.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];
if (!arg) { console.error("Usage: node scripts/record-deletions.js <trashed-msgids.json>"); process.exit(1); }

const bundle = JSON.parse(readFileSync(join(root, "data/.last-run-bundle.json"), "utf-8")).bundle || [];
const byMsgid = new Map(bundle.map(b => [b.msgid, b]));
const raw = JSON.parse(readFileSync(arg, "utf-8"));
const trashedIds = new Set(raw.map(x => (typeof x === "string" ? x : x.msgid)));

const histPath = join(root, "data/sender-history.json");
const history = loadHistory(histPath);
const now = new Date().toISOString().slice(0, 10);

let deleted = 0, kept = 0;
for (const item of bundle) {
  const sender = (item.from || "").toLowerCase();
  if (!sender) continue;
  if (trashedIds.has(item.msgid)) {
    recordDeletion(history, item.account, sender, { hasListUnsubscribe: item.hasListUnsubscribe, timestamp: now });
    deleted++;
  } else {
    recordKeep(history, item.account, sender); // survived → reset its consecutive counter
    kept++;
  }
}
saveHistory(histPath, history);
console.log(JSON.stringify({ recordedDeletions: deleted, resets: kept, historyKeys: Object.keys(history).length }));
