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
  if ((account.provider || "outlook") === "gmail") {
    // Verify the authenticated Gmail session matches the configured account
    // BEFORE any operation can use the client — a stale token cache for the
    // wrong mailbox rejects the cached promise (getClient's eviction handler
    // clears it) and no fetch/delete/restore/deleteBySender proceeds.
    // Test-injected factories bypass this on purpose: fakes shouldn't verify.
    return buildGmailClient().then(async (client) => {
      const { verifyGmailAccount } = await import("./gmail-verify.js");
      await verifyGmailAccount(client, account.id);
      return client;
    });
  }
  return buildGraphClient(account.id);
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

// ---------------------------------------------------------------------------
// Mutations — soft-delete / restore only. Per-id so one bad id can't sink a batch.
// ---------------------------------------------------------------------------
async function perId(ids, fn) {
  let ok = 0; const failedIds = [];
  for (const id of ids) {
    try { await fn(id); ok++; } catch { failedIds.push(id); }
  }
  return { ok, failedIds };
}

export async function deleteEmails(account, ids) {
  const client = await getClient(account);
  const gmail = (account.provider || "outlook") === "gmail";
  const { ok, failedIds } = await perId(ids, (id) => gmail
    ? client.users.messages.trash({ userId: "me", id })
    : client.api(`/me/messages/${id}/move`).post({ destinationId: "deleteditems" }));
  return { trashed: ok, failed: failedIds.length, failedIds };
}

export async function restoreEmails(account, ids) {
  const client = await getClient(account);
  const gmail = (account.provider || "outlook") === "gmail";
  const { ok, failedIds } = await perId(ids, (id) => gmail
    ? client.users.messages.untrash({ userId: "me", id })
    : client.api(`/me/messages/${id}/move`).post({ destinationId: "inbox" }));
  return { restored: ok, failed: failedIds.length, failedIds };
}

// ---------------------------------------------------------------------------
// Single message body (read-only)
// ---------------------------------------------------------------------------
export function extractGmailBody(payload) {
  if (!payload) return "";
  const decode = (data) =>
    Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  let plain = "", html = "";
  const walk = (p) => {
    if (!p) return;
    const mt = p.mimeType || "";
    if (mt === "text/plain" && p.body?.data && !plain) plain = decode(p.body.data);
    else if (mt === "text/html" && p.body?.data && !html) html = decode(p.body.data);
    for (const c of p.parts || []) walk(c);
  };
  walk(payload);
  if (plain) return plain.trim();
  if (html) return stripHtml(html);
  if (payload.body?.data) return decode(payload.body.data).trim();
  return "";
}

export async function fetchMessageBody(account, emailId) {
  const client = await getClient(account);
  if ((account.provider || "outlook") === "gmail") {
    const res = await client.users.messages.get({ userId: "me", id: emailId, format: "full" });
    return { id: res.data.id, body: extractGmailBody(res.data.payload) };
  }
  const email = process.env[`${account.id.toUpperCase()}_EMAIL`] || account.myEmail;
  const path = email ? `/users/${email}/messages/${emailId}` : `/me/messages/${emailId}`;
  const msg = await client.api(path).select("id,body").get();
  return { id: msg.id, body: stripHtml(msg.body?.content || "") };
}

// ---------------------------------------------------------------------------
// deleteBySender — intent-level bulk delete. GUARDS FIRST (same rails as the
// kill-list): protected senders and correspondents are refused before any API
// call. Inbox only; window clamped to [1h, 1y]; match cap 1000 per invocation.
// ---------------------------------------------------------------------------
const MATCH_CAP = 1000;

// Strict single-address shape: rejects whitespace, colons, quotes, angle
// brackets, parens, commas, pipes, braces, and multi-@ strings so no Gmail
// search operator (documented or undocumented OR separator) or OData fragment
// can ride in on the sender string. None of these characters appear in a real
// sender address, so excluding them fails closed. Validated BEFORE the guards
// so a crafted string can't confuse isProtectedSender's domain split either.
const EMAIL_SHAPE = /^[^\s@:'"<>(),|{}]+@[^\s@:'"<>(),|{}]+\.[^\s@:'"<>(),|{}]+$/;

export async function deleteBySender(account, sender, { sinceHours = 720, correspondents } = {}) {
  const email = String(sender || "").trim().toLowerCase();
  const none = { matched: 0, trashed: 0, failed: 0, failedIds: [], emailIds: [] };
  if (!EMAIL_SHAPE.test(email)) return { ...none, refused: "not a valid email address" };
  if (isProtectedSender(account, email)) return { ...none, refused: "protected sender (priority/never-delete/own domain)" };
  if (correspondents && correspondents.has(email)) return { ...none, refused: "you've emailed this sender (correspondent)" };

  const n = Number(sinceHours);
  const hours = Math.min(Math.max(Number.isFinite(n) ? n : 720, 1), 8760);
  const client = await getClient(account);
  let ids;
  if ((account.provider || "outlook") === "gmail") {
    const afterEpoch = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
    ids = await gmailListIds(client, `in:inbox from:${email} after:${afterEpoch}`, MATCH_CAP);
  } else {
    const me = outlookAddress(account);
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const odataSender = email.replace(/'/g, "''");
    const messages = await outlookCollect(client, () =>
      client.api(`/users/${me}/mailFolders/inbox/messages`)
        .filter(`from/emailAddress/address eq '${odataSender}' and receivedDateTime ge ${since}`)
        .select("id")
        .top(Math.min(MATCH_CAP, 1000))
        .get(), MATCH_CAP);
    ids = messages.map(m => m.id);
  }
  const del = await deleteEmails(account, ids);
  const failedSet = new Set(del.failedIds);
  return { matched: ids.length, ...del, emailIds: ids.filter(id => !failedSet.has(id)) };
}
