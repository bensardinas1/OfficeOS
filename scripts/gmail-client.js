/**
 * gmail-client.js
 *
 * Builds an authenticated Gmail API client using OAuth 2.0.
 *
 * First-run auth: starts a local HTTP server on port 4891, prints the auth URL,
 * and waits for Google to redirect back with the authorization code.
 * Tokens are cached in data/.gmail-token-cache.json and refreshed automatically.
 *
 * IMPORTANT: The Google Cloud Console OAuth 2.0 credentials for ben@sardinasfamily.com
 * must have http://localhost:4891/oauth2callback added as an authorized redirect URI.
 */

import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = join(__dirname, "../data/.gmail-token-cache.json");
const DATA_DIR = join(__dirname, "../data");

const REDIRECT_PORT = 4891;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

function loadTokenCache() {
  if (existsSync(TOKEN_PATH)) return JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
  return null;
}

function saveTokenCache(tokens) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

async function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get("code");
      if (code) {
        res.end("Authorization complete. You can close this tab.");
        server.close();
        resolve(code);
      } else {
        res.end("No code found.");
        server.close();
        reject(new Error("No authorization code in callback"));
      }
    });
    server.listen(REDIRECT_PORT, () => {
      // server is ready
    });
    server.on("error", reject);
  });
}

export async function buildGmailClient() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env");
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const cached = loadTokenCache();
  if (cached) {
    oauth2.setCredentials(cached);
    if (cached.expiry_date && Date.now() > cached.expiry_date - 60000) {
      const { credentials } = await oauth2.refreshAccessToken();
      saveTokenCache(credentials);
      oauth2.setCredentials(credentials);
    }
  } else {
    const authUrl = oauth2.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/gmail.modify"],
    });
    console.error("\nOpen this URL to authorize Gmail access:\n");
    console.error(authUrl);
    console.error(`\nWaiting for authorization on http://localhost:${REDIRECT_PORT}...`);
    const code = await waitForCode();
    const { tokens } = await oauth2.getToken(code);
    saveTokenCache(tokens);
    oauth2.setCredentials(tokens);
    console.error("Authorization complete. Tokens cached.");
  }

  return google.gmail({ version: "v1", auth: oauth2 });
}
