/**
 * gmail-client.js
 *
 * Builds an authenticated Gmail API client using OAuth 2.0.
 * On first run, prints an auth URL for the user to visit and paste the code.
 * Tokens are cached in data/.gmail-token-cache.json and refreshed automatically.
 */

import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = join(__dirname, "../data/.gmail-token-cache.json");
const DATA_DIR = join(__dirname, "../data");

function loadTokenCache() {
  if (existsSync(TOKEN_PATH)) return JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
  return null;
}

function saveTokenCache(tokens) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

async function promptUser(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

export async function buildGmailClient() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env");
  }

  const oauth2 = new google.auth.OAuth2(
    clientId,
    clientSecret,
    "urn:ietf:wg:oauth:2.0:oob"  // Desktop/CLI out-of-band redirect
  );

  const cached = loadTokenCache();
  if (cached) {
    oauth2.setCredentials(cached);
    // Refresh if expired
    if (cached.expiry_date && Date.now() > cached.expiry_date - 60000) {
      const { credentials } = await oauth2.refreshAccessToken();
      saveTokenCache(credentials);
      oauth2.setCredentials(credentials);
    }
  } else {
    // First-time auth flow
    const authUrl = oauth2.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/gmail.modify"],
    });
    console.error("\nOpen this URL to authorize Gmail access:\n");
    console.error(authUrl);
    console.error("");
    const code = await promptUser("Paste the authorization code: ");
    const { tokens } = await oauth2.getToken(code);
    saveTokenCache(tokens);
    oauth2.setCredentials(tokens);
  }

  return google.gmail({ version: "v1", auth: oauth2 });
}
