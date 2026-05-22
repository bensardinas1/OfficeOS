/**
 * gmail-verify.js
 *
 * Verifies that the authenticated Gmail session matches the configured
 * account's myEmail. Used by fetch/delete/draft scripts to prevent
 * operating on the wrong mailbox if the token cache is stale.
 *
 * Throws if mismatch; returns the authenticated address on success.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadAccount(accountId) {
  const companies = JSON.parse(
    readFileSync(join(__dirname, "../config/companies.json"), "utf-8")
  );
  const account = companies.companies.find(c => c.id === accountId);
  if (!account) throw new Error(`Account not found in companies.json: ${accountId}`);
  return account;
}

export async function verifyGmailAccount(gmail, accountId) {
  const account = loadAccount(accountId);
  if (!account.myEmail) {
    throw new Error(`Account ${accountId} has no myEmail set in companies.json`);
  }
  const profile = await gmail.users.getProfile({ userId: "me" });
  const authedAddress = (profile.data.emailAddress || "").toLowerCase();
  const expected = account.myEmail.toLowerCase();
  if (authedAddress !== expected) {
    throw new Error(
      `Gmail account mismatch for ${accountId}: token is authenticated as ${authedAddress} but companies.json expects ${expected}. ` +
      `Re-authenticate the correct Google account or fix the accountId.`
    );
  }
  return authedAddress;
}
