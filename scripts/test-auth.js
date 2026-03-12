/**
 * test-auth.js
 * Quick test to verify Graph API credentials are working.
 * Usage: node scripts/test-auth.js [companyId]
 */

import { buildGraphClient } from "./graph-client.js";
import "dotenv/config";

const companyId = process.argv[2] || "healthcarema";
const email = process.env[`${companyId.toUpperCase()}_EMAIL`];

console.log(`Testing Graph API auth for: ${companyId} (${email})`);

try {
  const client = await buildGraphClient(companyId);
  const profile = await client.api(`/users/${email}`).select("displayName,mail").get();
  console.log("✓ Auth successful");
  console.log(`  Name: ${profile.displayName}`);
  console.log(`  Email: ${profile.mail}`);
} catch (err) {
  console.error("✗ Auth failed:", err.message);
  process.exit(1);
}
