/**
 * build-bundle.js
 *
 * Codifies the fetch -> classify -> bundle bridge so no session hand-scripts it.
 * Emits { generatedAt, window, bundle, emailsById, funnel }. The reasoner consumes
 * `bundle` (msgid-keyed, tagged, collapsed groups marked); the applier consumes
 * `emailsById` (carries `account`). The funnel attributes cost at every tier.
 *
 * Injected deps make the bridge testable without network:
 *   deps.accounts: [{ id, accountType }]
 *   deps.fetchAllFn(accountId, sinceIso) -> full paginated email list
 *   deps.classifyFn(emails, accountId)  -> { explicitDeletions, heuristicDeletions, ... }
 *   deps.now: ISO timestamp
 *
 * CLI: node scripts/build-bundle.js --since <ISO|Nd|Nh> [--accounts a,b] [--out <path>]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./fs-utils.js";
import { groupForReasoning } from "./collapse.js";
import { proposalId, isPendingProposal, nextCounterFor } from "./pattern-discovery.js";

export async function collectPages(fetchPage, { sinceMs, dateOf }) {
  const out = [];
  let token = null;
  // NOTE: assumes pages arrive newest-first (descending date). Once a page
  // contains an item older than `since`, all later pages are older, so we stop.
  // Callers whose API does NOT guarantee descending order must pass sinceMs: 0
  // and filter elsewhere (the Gmail path does this — server-side `after:` windows).
  for (;;) {
    const { items, nextToken } = await fetchPage({ token });
    let sawOld = false;
    for (const it of items || []) {
      if (new Date(dateOf(it)).getTime() < sinceMs) { sawOld = true; continue; }
      out.push(it);
    }
    if (sawOld || !nextToken) break;
    token = nextToken;
  }
  return out;
}

/**
 * Maps a Graph message into the email shape the classifier consumes, hydrating
 * ALL bulk signals reachable from Outlook — not just List-Unsubscribe. The
 * `internetMessageHeaders` and `toRecipients`/`ccRecipients` are already fetched
 * in the select; this pulls `precedence` and recipients out so `detectBulkSignals`
 * can score >=2 on genuinely-bulk mail (the business threshold), instead of being
 * capped at 1 by List-Unsubscribe alone.
 */
export function mapOutlookMessage(m) {
  const headers = m.internetMessageHeaders || [];
  const headerVal = (name) => {
    const h = headers.find(x => (x.name || "").toLowerCase() === name);
    return h ? h.value : undefined;
  };
  const recipStr = (arr) => (arr || [])
    .map(r => r.emailAddress?.address || "").filter(Boolean).join(", ");
  return {
    id: m.id, subject: m.subject,
    from: m.from?.emailAddress?.address, fromName: m.from?.emailAddress?.name,
    receivedAt: m.receivedDateTime, preview: m.bodyPreview,
    hasListUnsubscribe: headers.some(h => (h.name || "").toLowerCase() === "list-unsubscribe"),
    precedence: headerVal("precedence"),
    toRecipients: recipStr(m.toRecipients),
    ccRecipients: recipStr(m.ccRecipients),
  };
}

function compactEmail(e, accountId) {
  return {
    id: e.id, account: accountId,
    from: e.from, fromName: e.fromName,
    subject: e.subject, receivedAt: e.receivedAt || e.received,
  };
}

export async function buildBundle({ since, deps, pendingProposals = [] }) {
  const { accounts, fetchAllFn, classifyFn, now } = deps;
  const sinceIso = since;

  const bundle = [];
  const emailsById = {};
  const perAccount = {};
  let fetched = 0, explicitDropped = 0, survivors = 0, heuristicCandidates = 0;

  const warnings = [];
  const settled = await Promise.allSettled(accounts.map(async (acct) => {
    const emails = await fetchAllFn(acct.id, sinceIso);
    const r = classifyFn(emails, acct.id);
    return { acct, emails, r };
  }));
  const results = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") results.push(s.value);
    else warnings.push(`[${accounts[i].id}] fetch/classify failed: ${s.reason?.message || s.reason}`);
  });

  const toCollapse = [];
  for (const { acct, emails, r } of results) {
    const explicitIds = new Set((r.explicitDeletions || []).map(e => e.id));
    const heuristicIds = new Set((r.heuristicDeletions || []).map(e => e.id));
    let aFetched = emails.length, aExplicit = 0, aSurv = 0, aHeur = 0;
    for (const e of emails) {
      if (explicitIds.has(e.id)) { aExplicit++; continue; }
      const tag = heuristicIds.has(e.id) ? "heuristic-delete-candidate" : "survivor";
      if (tag === "survivor") aSurv++; else aHeur++;
      emailsById[e.id] = compactEmail(e, acct.id);
      toCollapse.push({
        msgid: e.id, account: acct.id, tag,
        from: e.from, fromName: e.fromName, subject: e.subject,
        preview: (e.preview || "").slice(0, 200),
        receivedAt: e.receivedAt || e.received, hasListUnsubscribe: !!e.hasListUnsubscribe,
      });
    }
    fetched += aFetched; explicitDropped += aExplicit; survivors += aSurv; heuristicCandidates += aHeur;
    perAccount[acct.id] = { fetched: aFetched, explicitDropped: aExplicit, survivors: aSurv, heuristicCandidates: aHeur };
  }

  const { groups, byMsgid } = groupForReasoning(toCollapse);
  for (const item of toCollapse) {
    const g = byMsgid[item.msgid];
    const group = groups.find(x => x.id === g.groupId);
    item.group = { id: g.groupId, kind: group.kind, isRepresentative: g.isRepresentative, size: group.memberMsgids.length };
    bundle.push(item);
  }

  // Surface noise-class proposals for alert-batches (never auto-drop).
  const proposals = [];
  let counter = nextCounterFor(pendingProposals, (now || "").slice(0, 10));
  for (const group of groups) {
    if (group.kind !== "alert-batch") continue;
    const rep = bundle.find(b => b.msgid === group.representativeMsgid);
    if (!rep) continue;
    const sender = (rep.from || "").toLowerCase();
    const target = `companies.${rep.account}.alwaysDelete`;
    if (!sender || isPendingProposal(pendingProposals, target, sender)) continue;
    proposals.push({
      id: proposalId(now, counter++),
      target,
      payload: { type: "email", value: sender, label: `${sender} (alert batch ×${group.memberMsgids.length})` },
      reason: `${group.memberMsgids.length} same-template alerts from ${sender} in window`,
      proposedAt: now, status: "pending",
    });
  }

  const fromMembers = toCollapse.length;
  const reasoningUnits = groups.length;
  const funnel = {
    fetched, explicitDropped, survivors, heuristicCandidates,
    collapsed: { groups: reasoningUnits, fromMembers, savedJudgments: fromMembers - reasoningUnits },
    reasoningUnits, perAccount,
  };

  return { generatedAt: now, window: { since: sinceIso }, bundle, emailsById, funnel, warnings, proposals };
}

function funnelLine(f) {
  return `fetched ${f.fetched} → explicit-dropped ${f.explicitDropped} → ${f.survivors} survivors + ${f.heuristicCandidates} candidates → collapse ${f.collapsed.fromMembers}→${f.reasoningUnits} units → reasoned ${f.reasoningUnits}`;
}

export function resolveSince(arg, nowIso) {
  if (/^\d+d$/i.test(arg)) return new Date(new Date(nowIso).getTime() - parseInt(arg) * 86400000).toISOString();
  if (/^\d+h$/i.test(arg)) return new Date(new Date(nowIso).getTime() - parseInt(arg) * 3600000).toISOString();
  const d = new Date(arg);
  if (isNaN(d.getTime())) throw new Error(`--since must be ISO, Nd, or Nh; got "${arg}"`);
  return d.toISOString();
}

if (process.argv[1] && process.argv[1].endsWith("build-bundle.js")) {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since") flags.since = args[++i];
    else if (args[i] === "--accounts") flags.accounts = args[++i];
    else if (args[i] === "--out") flags.out = args[++i];
  }
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = join(__dirname, "..");
  const nowIso = new Date().toISOString();
  if (!flags.since) process.stderr.write("build-bundle: --since not specified; defaulting to 30d\n");
  const since = resolveSince(flags.since || "30d", nowIso);
  const companies = JSON.parse(readFileSync(join(root, "config/companies.json"), "utf-8"));
  const wanted = flags.accounts ? new Set(flags.accounts.split(",")) : null;
  const accounts = companies.companies
    .filter(c => !wanted || wanted.has(c.id))
    .map(c => ({ id: c.id, accountType: c.accountType, provider: c.provider }));

  const { buildGraphClient } = await import("./graph-client.js");
  const { buildGmailClient } = await import("./gmail-client.js");
  const { classify } = await import("./classify-emails.js");
  const sinceMs = new Date(since).getTime();

  async function fetchAllOutlook(accountId) {
    const client = await buildGraphClient(accountId);
    return collectPages(async ({ token }) => {
      // When paginating, `token` is the full @odata.nextLink URL; Graph's client.api()
      // accepts an absolute URL and reuses the server-encoded select/orderby/top.
      const req = token
        ? client.api(token)
        : client.api("/me/mailFolders/inbox/messages").top(100)
            .select("id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,internetMessageHeaders")
            .orderby("receivedDateTime desc");
      const res = await req.get();
      const items = (res.value || []).map(mapOutlookMessage);
      return { items, nextToken: res["@odata.nextLink"] || null };
    }, { sinceMs, dateOf: e => e.receivedAt });
  }

  // TODO(multi-gmail): buildGmailClient() is not yet account-scoped (single token
  // cache). accountId is threaded here for contract-correctness; when a second
  // Gmail account is added, buildGmailClient must take accountId like graph-client.
  async function fetchAllGmail(accountId) {
    const gmail = await buildGmailClient();
    const afterSec = Math.floor(sinceMs / 1000);
    const ids = await collectPages(async ({ token }) => {
      const res = await gmail.users.messages.list({ userId: "me", q: `in:inbox after:${afterSec}`, maxResults: 100, pageToken: token || undefined });
      return { items: (res.data.messages || []).map(m => ({ id: m.id, receivedAt: new Date().toISOString() })), nextToken: res.data.nextPageToken || null };
    }, { sinceMs: 0, dateOf: () => new Date().toISOString() });
    const out = [];
    // TODO(perf): sequential per-message hydration; replace with gmail.batch() for
    // windows with many messages (the load test will show if this is painful).
    for (const { id } of ids) {
      const m = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe"] });
      const h = Object.fromEntries((m.data.payload?.headers || []).map(x => [x.name, x.value]));
      out.push({ id, subject: h.Subject, from: (h.From || "").replace(/.*<(.+)>.*/, "$1"), fromName: (h.From || "").replace(/<.*>/, "").trim(), receivedAt: new Date(Number(m.data.internalDate)).toISOString(), preview: m.data.snippet, hasListUnsubscribe: !!h["List-Unsubscribe"] });
    }
    return out;
  }

  const deps = {
    accounts,
    now: nowIso,
    fetchAllFn: async (accountId) => {
      const acct = accounts.find(a => a.id === accountId);
      return acct.provider === "gmail" ? fetchAllGmail(accountId) : fetchAllOutlook(accountId);
    },
    classifyFn: (emails, accountId) => classify(emails, accountId),
  };

  let existingPending = [];
  try { existingPending = JSON.parse(readFileSync(join(root, "data/proposed-rules.json"), "utf-8")).proposals || []; } catch { /* none */ }
  const result = await buildBundle({ since, deps, pendingProposals: existingPending });
  const outPath = flags.out || join(root, "data/.last-run-bundle.json");
  if (result.proposals && result.proposals.length) {
    const prPath = join(root, "data/proposed-rules.json");
    let pr = { proposals: [] };
    try { pr = JSON.parse(readFileSync(prPath, "utf-8")); } catch { /* fresh */ }
    pr.proposals.push(...result.proposals);
    atomicWrite(prPath, JSON.stringify(pr, null, 2));
  }
  atomicWrite(outPath, JSON.stringify(result, null, 2));
  process.stderr.write(funnelLine(result.funnel) + "\n");
  process.stdout.write(JSON.stringify({ funnel: result.funnel, out: outPath }, null, 2));
}
