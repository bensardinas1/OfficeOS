/**
 * build-correspondents.js <accountId> [days=730]
 *
 * Harvests every address the user has SENT mail to (To + Cc) from the account's
 * Sent folder and merges it into data/correspondents.json. These addresses are
 * protected from heuristic deletion by classify-emails.js ("people I've written
 * to are not junk"). Explicit alwaysDelete/scamPatterns still win.
 *
 * Outlook: paginates /me/mailFolders/sentitems. Gmail: paginates in:sent.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { collectPages } from "./build-bundle.js";
import { parseAddressList, mergeCorrespondents, loadCorrespondentsFile, saveCorrespondentsFile } from "./correspondents.js";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const statePath = join(root, "data/correspondents.json");

const accountId = process.argv[2];
const days = parseInt(process.argv[3] || "730", 10);
if (!accountId) {
  console.error("Usage: node scripts/build-correspondents.js <accountId> [days=730]");
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
const account = cfg.companies.find(c => c.id === accountId);
if (!account) { console.error(`Unknown account: ${accountId}`); process.exit(1); }

const sinceMs = Date.now() - days * 86400000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const addresses = [];

async function withRetry(fn) {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      console.error(`attempt ${attempt}/5 failed: ${err.message || err.code} — retrying in ${attempt * 2}s`);
      await sleep(attempt * 2000);
    }
  }
  throw lastErr;
}

if (account.provider === "gmail") {
  const { buildGmailClient } = await import("./gmail-client.js");
  const { verifyGmailAccount } = await import("./gmail-verify.js");
  const gmail = await buildGmailClient();
  await verifyGmailAccount(gmail, accountId);
  const afterSec = Math.floor(sinceMs / 1000);
  const ids = await collectPages(async ({ token }) => withRetry(async () => {
    const res = await gmail.users.messages.list({
      userId: "me", q: `in:sent after:${afterSec}`, maxResults: 100, pageToken: token || undefined,
    });
    return { items: (res.data.messages || []).map(m => m.id), nextToken: res.data.nextPageToken || null };
  }), { sinceMs: 0, dateOf: () => new Date().toISOString() }); // window enforced by the query
  console.error(`gmail sent messages: ${ids.length}`);
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    const metas = await Promise.all(batch.map(id => withRetry(() =>
      gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["To", "Cc"] })
    )));
    for (const r of metas) {
      for (const h of (r.data.payload?.headers || [])) {
        if (h.name === "To" || h.name === "Cc") addresses.push(...parseAddressList(h.value));
      }
    }
  }
} else {
  const { buildGraphClient } = await import("./graph-client.js");
  const client = await buildGraphClient(accountId);
  const messages = await collectPages(async ({ token }) => withRetry(async () => {
    const req = token
      ? client.api(token)
      : client.api("/me/mailFolders/sentitems/messages").top(100)
          .select("toRecipients,ccRecipients,sentDateTime").orderby("sentDateTime desc");
    const res = await req.get();
    return { items: res.value || [], nextToken: res["@odata.nextLink"] || null };
  }), { sinceMs, dateOf: m => m.sentDateTime });
  console.error(`outlook sent messages: ${messages.length}`);
  for (const m of messages) {
    for (const r of [...(m.toRecipients || []), ...(m.ccRecipients || [])]) {
      const a = (r.emailAddress?.address || "").toLowerCase();
      if (a.includes("@")) addresses.push(a);
    }
  }
}

// never protect the account's own address (self-sends shouldn't blanket-protect internal blasts)
const self = (account.myEmail || "").toLowerCase();
const filtered = addresses.filter(a => a !== self);

const map = loadCorrespondentsFile(statePath);
const before = (map[accountId] || []).length;
mergeCorrespondents(map, accountId, filtered);
saveCorrespondentsFile(statePath, map);
console.log(JSON.stringify({ account: accountId, sentWindow: `${days}d`, recipientsSeen: addresses.length, uniqueBefore: before, uniqueAfter: map[accountId].length }));
