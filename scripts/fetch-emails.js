/**
 * fetch-emails.js
 * Fetches recent emails from a mailbox via Microsoft Graph API.
 * Thin shim over scripts/mail.js fetchMail.
 *
 * Usage:
 *   node scripts/fetch-emails.js [companyId] [hours] [folder] [top] [bodyChars]
 *
 * Examples:
 *   node scripts/fetch-emails.js healthcarema 24 inbox
 *   node scripts/fetch-emails.js healthcarema 24 inbox 200
 *   node scripts/fetch-emails.js healthcarema 24 inbox 200 5000
 *
 * Output: JSON array of email objects printed to stdout.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMail } from "./mail.js";

export { stripHtml } from "./mail.js";

// CLI entrypoint — guarded so the module can be imported for tests without
// executing the fetch (Windows-safe: checks the resolved script path).
if (process.argv[1] && process.argv[1].endsWith("fetch-emails.js")) {
  const companyId = process.argv[2] || "healthcarema";
  const hours = parseInt(process.argv[3] || "24", 10);
  const folder = process.argv[4] || "inbox";
  const top = parseInt(process.argv[5] || "50", 10);
  const bodyChars = parseInt(process.argv[6] || "0", 10);

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
    const account = companies.companies.find((c) => c.id === companyId) || { id: companyId, provider: "outlook" };

    const emails = await fetchMail(account, { hours, folder, max: top, bodyChars });

    console.log(JSON.stringify(emails, null, 2));
  } catch (err) {
    console.error("Error fetching emails:", err.message);
    process.exit(1);
  }
}
