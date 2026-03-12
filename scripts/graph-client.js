import { PublicClientApplication } from "@azure/msal-node";
import pkg from "@microsoft/microsoft-graph-client";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const { Client } = pkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_CACHE_DIR = join(__dirname, "../data");

function loadTokenCache(companyId) {
  const path = join(TOKEN_CACHE_DIR, `.token-cache-${companyId}.json`);
  if (existsSync(path)) return readFileSync(path, "utf-8");
  return null;
}

function saveTokenCache(companyId, data) {
  if (!existsSync(TOKEN_CACHE_DIR)) mkdirSync(TOKEN_CACHE_DIR, { recursive: true });
  writeFileSync(join(TOKEN_CACHE_DIR, `.token-cache-${companyId}.json`), data, "utf-8");
}

/**
 * Build an authenticated Microsoft Graph client using OAuth device flow.
 * Tokens are cached locally in data/.token-cache.json and refreshed automatically.
 */
export async function buildGraphClient(companyId) {
  const prefix = companyId.toUpperCase();
  const tenantId = process.env[`${prefix}_TENANT_ID`];
  const clientId = process.env[`${prefix}_CLIENT_ID`];

  if (!tenantId || !clientId) {
    throw new Error(
      `Missing Graph API credentials for: ${companyId}. ` +
      `Expected: ${prefix}_TENANT_ID, ${prefix}_CLIENT_ID`
    );
  }

  const cachePlugin = {
    beforeCacheAccess: async (context) => {
      const cached = loadTokenCache(companyId);
      if (cached) context.tokenCache.deserialize(cached);
    },
    afterCacheAccess: async (context) => {
      if (context.cacheHasChanged) saveTokenCache(companyId, context.tokenCache.serialize());
    },
  };

  const msalApp = new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    cache: { cachePlugin },
  });

  const scopes = ["Mail.Read", "Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"];

  // Try silent auth from cache first
  let accessToken = null;
  const accounts = await msalApp.getTokenCache().getAllAccounts();

  if (accounts.length > 0) {
    try {
      const result = await msalApp.acquireTokenSilent({ scopes, account: accounts[0] });
      accessToken = result.accessToken;
    } catch {
      // Cache miss or expired — fall through to device flow
    }
  }

  // Device flow if no cached token
  if (!accessToken) {
    const result = await msalApp.acquireTokenByDeviceCode({
      scopes,
      deviceCodeCallback: (response) => {
        console.log("\n" + response.message + "\n");
      },
    });
    accessToken = result.accessToken;
  }

  if (!accessToken) throw new Error("Failed to acquire access token");

  const client = Client.init({
    authProvider: (done) => done(null, accessToken),
  });

  return client;
}
