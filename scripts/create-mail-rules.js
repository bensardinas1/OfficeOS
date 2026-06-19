/**
 * create-mail-rules.js <accountId>
 *
 * One-off setup: creates the "Security" mail folder (if missing) and three inbox
 * rules that route security alerts into it, so the daemon's `exposed` job (which
 * reads inbox + Security) captures them even if they'd otherwise be auto-deleted:
 *   - Defender → Security   (senders mssecurity-noreply / defender-noreply)
 *   - PCI Tamper → Security (noreply@brickellpay.com + subject "Tamper Detection")
 *   - Entra → Security      (azure-noreply + subject "Entra ID Protection"/"Identity Protection")
 *
 * Requires the app to have MailboxSettings.ReadWrite. Idempotent: skips a rule
 * whose displayName already exists. Mailbox-settings mutation only — it never
 * sends or deletes mail (the rules move matching mail within the mailbox).
 *
 * Usage: node scripts/create-mail-rules.js brickellpay
 */
import { buildGraphClient } from "./graph-client.js";
import "dotenv/config";

const accountId = process.argv[2];
if (!accountId) { console.error("Usage: node scripts/create-mail-rules.js <accountId>"); process.exit(1); }
const email = process.env[`${accountId.toUpperCase()}_EMAIL`];
if (!email) { console.error(`Missing ${accountId.toUpperCase()}_EMAIL in .env`); process.exit(1); }

const client = await buildGraphClient(accountId);
const base = `/users/${email}`;

// 1. Security folder — find or create.
let folderId;
const folders = await client.api(`${base}/mailFolders`).filter("displayName eq 'Security'").get();
if (folders.value?.length) folderId = folders.value[0].id;
else folderId = (await client.api(`${base}/mailFolders`).post({ displayName: "Security" })).id;

// 2. Existing inbox rules — dedupe by displayName.
const existing = await client.api(`${base}/mailFolders/inbox/messageRules`).get();
const have = new Set((existing.value || []).map(r => r.displayName));

const RULES = [
  { displayName: "Defender → Security", sequence: 1, isEnabled: true,
    conditions: { senderContains: ["mssecurity-noreply", "defender-noreply"] },
    actions: { moveToFolder: folderId, stopProcessingRules: true } },
  { displayName: "PCI Tamper → Security", sequence: 2, isEnabled: true,
    conditions: { senderContains: ["noreply@brickellpay.com"], subjectContains: ["Tamper Detection"] },
    actions: { moveToFolder: folderId, stopProcessingRules: true } },
  { displayName: "Entra → Security", sequence: 3, isEnabled: true,
    conditions: { senderContains: ["azure-noreply"], subjectContains: ["Entra ID Protection", "Identity Protection"] },
    actions: { moveToFolder: folderId, stopProcessingRules: true } },
];

const results = [];
for (const rule of RULES) {
  if (have.has(rule.displayName)) { results.push({ rule: rule.displayName, status: "exists" }); continue; }
  try {
    await client.api(`${base}/mailFolders/inbox/messageRules`).post(rule);
    results.push({ rule: rule.displayName, status: "created" });
  } catch (err) {
    results.push({ rule: rule.displayName, status: "FAILED", error: err.message });
  }
}
console.log(JSON.stringify({ account: accountId, folderId, results }, null, 2));
