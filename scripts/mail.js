/**
 * mail.js — the ONE library for touching mail. Every fetch/delete/restore path
 * (CLI shims, triage, morning-brief, the daemon) goes through these functions so
 * pagination, provider dispatch, the unified email shape, and the safety rails
 * live in exactly one place. Soft-delete only: Outlook move→deleteditems, Gmail
 * trash. Never a permanent delete, never a send.
 *
 * All functions take the ACCOUNT OBJECT (from config/companies.json) first.
 * Clients are cached per account. For tests, _setClientFactoryForTest injects
 * fakes (null restores the default and clears the cache).
 */
import { buildGraphClient } from "./graph-client.js";
import { buildGmailClient, mapGmailMessage } from "./gmail-client.js";
import { isProtectedSender } from "./sender-guards.js";
import "dotenv/config";

// ---------------------------------------------------------------------------
// Client cache + test seam
// ---------------------------------------------------------------------------
let clientFactory = null; // null → default
const clientCache = new Map();

function defaultFactory(account) {
  return (account.provider || "outlook") === "gmail" ? buildGmailClient() : buildGraphClient(account.id);
}

async function getClient(account) {
  const key = `${account.provider || "outlook"}:${account.id}`;
  if (!clientCache.has(key)) {
    const p = Promise.resolve((clientFactory || defaultFactory)(account));
    clientCache.set(key, p);
    p.catch(() => { if (clientCache.get(key) === p) clientCache.delete(key); });
  }
  return clientCache.get(key);
}

export function _setClientFactoryForTest(fn) {
  clientFactory = fn;
  clientCache.clear();
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
export function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function outlookAddress(account) {
  const email = process.env[`${account.id.toUpperCase()}_EMAIL`] || account.myEmail;
  if (!email) throw new Error(`Missing ${account.id.toUpperCase()}_EMAIL in .env`);
  return email;
}

const OUTLOOK_SELECT = "id,subject,from,receivedDateTime,isRead,bodyPreview,importance,hasAttachments,internetMessageHeaders";

function mapOutlookMessage(msg, bodyChars) {
  const inet = msg.internetMessageHeaders || [];
  const h = (name) => inet.find(x => x.name.toLowerCase() === name.toLowerCase())?.value || "";
  const obj = {
    id: msg.id,
    subject: msg.subject,
    from: msg.from?.emailAddress?.address,
    fromName: msg.from?.emailAddress?.name,
    received: msg.receivedDateTime,
    receivedAt: msg.receivedDateTime,
    isRead: msg.isRead,
    importance: msg.importance,
    hasAttachments: msg.hasAttachments,
    preview: msg.bodyPreview?.slice(0, 300),
    hasListUnsubscribe: !!h("List-Unsubscribe"),
    precedence: h("Precedence") || null,
    toRecipients: h("To"),
    ccRecipients: h("Cc"),
    gmailCategories: [],
  };
  if (bodyChars > 0) obj.body = stripHtml(msg.body?.content || "").slice(0, bodyChars);
  return obj;
}

/** Follow @odata.nextLink pages until `max` ids collected or pages exhausted. */
async function outlookCollect(client, firstRequest, max) {
  const collected = [];
  let response = await firstRequest();
  collected.push(...(response.value || []));
  while (response["@odata.nextLink"] && collected.length < max) {
    response = await client.api(response["@odata.nextLink"]).get();
    collected.push(...(response.value || []));
  }
  return collected.slice(0, max);
}

async function gmailListIds(client, q, max) {
  const ids = [];
  let pageToken;
  do {
    const res = await client.users.messages.list({
      userId: "me", q, maxResults: Math.min(max - ids.length, 100), pageToken,
    });
    for (const m of res.data.messages || []) ids.push(m.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

// ---------------------------------------------------------------------------
// fetchMail
// ---------------------------------------------------------------------------
export async function fetchMail(account, { hours = 24, folder = "inbox", max = 200, bodyChars = 0 } = {}) {
  const client = await getClient(account);
  if ((account.provider || "outlook") === "gmail") {
    // Gmail has labels, not folders — the folder param is Outlook-only (spec'd).
    const afterEpoch = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
    const ids = await gmailListIds(client, `in:inbox after:${afterEpoch}`, max);
    const emails = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = await Promise.all(ids.slice(i, i + 50).map(id =>
        client.users.messages.get({
          userId: "me", id, format: "metadata",
          metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe", "Precedence", "To", "Cc"],
        })));
      for (const r of batch) {
        const e = mapGmailMessage(r.data, { previewLimit: 300 });
        e.fromName = e.fromName || e.from;
        emails.push(e);
      }
    }
    emails.sort((a, b) => new Date(b.received) - new Date(a.received));
    return emails;
  }
  const email = outlookAddress(account);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const select = bodyChars > 0 ? `${OUTLOOK_SELECT},body` : OUTLOOK_SELECT;
  const messages = await outlookCollect(client, () =>
    client.api(`/users/${email}/mailFolders/${folder}/messages`)
      .filter(`receivedDateTime ge ${since}`)
      .select(select)
      .orderby("receivedDateTime desc")
      .top(Math.min(max, 1000))
      .get(), max);
  return messages.map(m => mapOutlookMessage(m, bodyChars));
}
