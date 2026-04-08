/**
 * triage.js
 *
 * End-to-end email triage: fetch → classify → format → save pending-deletions.
 * Replaces the multi-tool-call orchestration that Claude was doing in-conversation.
 *
 * Usage:
 *   node scripts/triage.js                          # all accounts, 24h
 *   node scripts/triage.js personal                 # single account
 *   node scripts/triage.js healthcarema,brickellpay  # specific accounts
 *   node scripts/triage.js personal 48              # 48-hour window
 *   node scripts/triage.js all 48 200               # all accounts, 48h, max 200 gmail msgs
 *
 * Output: Formatted markdown triage report to stdout.
 * Side effect: Writes data/pending-deletions.json for deletion workflow.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, detectBulkSignals } from "./classify-emails.js";
import { buildGraphClient } from "./graph-client.js";
import { buildGmailClient } from "./gmail-client.js";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "data");

// ---------------------------------------------------------------------------
// Config loaders
// ---------------------------------------------------------------------------

function loadConfig() {
  const companies = JSON.parse(
    readFileSync(join(ROOT, "config/companies.json"), "utf-8")
  );
  const accountTypes = JSON.parse(
    readFileSync(join(ROOT, "config/account-types.json"), "utf-8")
  );
  const prefs = JSON.parse(
    readFileSync(join(ROOT, "config/prefs.json"), "utf-8")
  );
  return { companies: companies.companies, accountTypes, prefs };
}

// ---------------------------------------------------------------------------
// Fetch: Outlook
// ---------------------------------------------------------------------------

async function fetchOutlook(accountId, hours) {
  const email = process.env[`${accountId.toUpperCase()}_EMAIL`];
  if (!email) throw new Error(`Missing ${accountId.toUpperCase()}_EMAIL in .env`);

  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const client = await buildGraphClient(accountId);

  const response = await client
    .api(`/users/${email}/mailFolders/inbox/messages`)
    .filter(`receivedDateTime ge ${since}`)
    .select("id,subject,from,receivedDateTime,isRead,bodyPreview,importance,hasAttachments,internetMessageHeaders")
    .orderby("receivedDateTime desc")
    .top(50)
    .get();

  return (response.value || []).map((msg) => {
    const inetHeaders = msg.internetMessageHeaders || [];
    const getInetHeader = (name) =>
      inetHeaders.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

    return {
      id: msg.id,
      subject: msg.subject,
      from: msg.from?.emailAddress?.address,
      fromName: msg.from?.emailAddress?.name,
      received: msg.receivedDateTime,
      isRead: msg.isRead,
      importance: msg.importance,
      hasAttachments: msg.hasAttachments,
      preview: msg.bodyPreview?.slice(0, 300),
      hasListUnsubscribe: !!getInetHeader("List-Unsubscribe"),
      precedence: getInetHeader("Precedence") || null,
      toRecipients: getInetHeader("To"),
      ccRecipients: getInetHeader("Cc"),
      gmailCategories: [],
    };
  });
}

// ---------------------------------------------------------------------------
// Fetch: Gmail
// ---------------------------------------------------------------------------

async function fetchGmail(hours, maxResults) {
  const gmail = await buildGmailClient();
  const afterEpoch = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);
  const query = `in:inbox after:${afterEpoch}`;

  // Paginate message IDs
  const messageIds = [];
  let pageToken;
  do {
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(maxResults - messageIds.length, 100),
      pageToken,
    });
    for (const m of listRes.data.messages || []) {
      messageIds.push(m.id);
    }
    pageToken = listRes.data.nextPageToken;
  } while (pageToken && messageIds.length < maxResults);

  // Fetch metadata concurrently in batches of 50
  const emails = [];
  for (let i = 0; i < messageIds.length; i += 50) {
    const batch = messageIds.slice(i, i + 50);
    const results = await Promise.all(
      batch.map((id) =>
        gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe", "Precedence", "To", "Cc"],
        })
      )
    );

    for (const res of results) {
      const headers = res.data.payload?.headers || [];
      const getHeader = (name) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

      const fromRaw = getHeader("From");
      let fromName = "";
      let fromEmail = fromRaw;
      const match = fromRaw.match(/^"?([^"<]*?)"?\s*<([^>]+)>/);
      if (match) {
        fromName = match[1].trim();
        fromEmail = match[2].trim();
      }

      const dateStr = getHeader("Date");
      let received;
      try { received = new Date(dateStr).toISOString(); } catch { received = dateStr; }

      const labelIds = res.data.labelIds || [];
      emails.push({
        id: res.data.id,
        subject: getHeader("Subject"),
        from: fromEmail,
        fromName: fromName || fromEmail,
        received,
        isRead: !labelIds.includes("UNREAD"),
        importance: labelIds.includes("IMPORTANT") ? "high" : "normal",
        hasAttachments: (res.data.payload?.parts || []).some(
          (p) => p.filename && p.filename.length > 0
        ),
        preview: (res.data.snippet || "").slice(0, 300),
        hasListUnsubscribe: !!getHeader("List-Unsubscribe"),
        precedence: getHeader("Precedence") || null,
        toRecipients: getHeader("To"),
        ccRecipients: getHeader("Cc"),
        gmailCategories: labelIds.filter((l) => l.startsWith("CATEGORY_")),
      });
    }
  }

  emails.sort((a, b) => new Date(b.received) - new Date(a.received));
  return emails;
}

// ---------------------------------------------------------------------------
// Fetch dispatcher
// ---------------------------------------------------------------------------

async function fetchAccount(account, hours, maxGmail) {
  if (account.provider === "gmail") {
    return fetchGmail(hours, maxGmail);
  }
  return fetchOutlook(account.id, hours);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatDate(prefs) {
  const now = new Date();
  if (prefs.display.dateFormat === "short") {
    return now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  return now.toISOString().slice(0, 10);
}

function formatFetchSummary(results, prefs) {
  const mode = prefs.display.fetchSummary;
  if (mode === "none") return "";

  const icons = prefs.display.statusIcons;
  const date = formatDate(prefs);

  const parts = results.map((r) => {
    const icon = mode === "inline-icons"
      ? (r.error ? icons.failure : r.count === 0 ? icons.warning : icons.success) + " "
      : "";
    if (r.error) return `${icon}${r.name} (error)`;
    return `${icon}${r.name} (${r.count} emails)`;
  });

  return parts.join(" · ") + ` — ${date} · Last ${results[0]?.hours || 24}h\n`;
}

function renderBusinessSection(businessResults, accountTypes) {
  const lines = [];

  // Action Items
  const actionItems = [];
  for (const r of businessResults) {
    const actionCat = r.classified.categories["action"];
    if (actionCat?.emails?.length) {
      for (const e of actionCat.emails) {
        actionItems.push({ account: r.name, email: e });
      }
    }
  }

  if (actionItems.length) {
    lines.push("## Action Items — All Business Accounts\n");
    for (const item of actionItems) {
      lines.push(
        `- **[${item.account}]** **[${item.email.fromName}]** ${item.email.subject}`
      );
    }
    lines.push("");
  }

  // News & Market
  const newsItems = [];
  for (const r of businessResults) {
    const newsCat = r.classified.categories["news"];
    if (newsCat?.emails?.length) {
      newsItems.push({ account: r.name, emails: newsCat.emails });
    }
  }
  if (newsItems.length) {
    lines.push("## News & Market Digest\n");
    for (const item of newsItems) {
      lines.push(`**${item.account}:** ${item.emails.map((e) => `${e.fromName} — ${e.subject}`).join("; ")}\n`);
    }
  }

  // FYI
  const fyiItems = [];
  for (const r of businessResults) {
    const fyiCat = r.classified.categories["fyi"];
    if (fyiCat?.emails?.length) {
      for (const e of fyiCat.emails) {
        fyiItems.push({ account: r.name, email: e });
      }
    }
  }
  if (fyiItems.length) {
    lines.push("## FYI\n");
    for (const item of fyiItems) {
      lines.push(
        `- **[${item.account}]** ${item.email.fromName} — ${item.email.subject}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderPersonalSection(personalResults) {
  const lines = [];
  lines.push("---\n");
  lines.push("## Personal Triage\n");

  for (const r of personalResults) {
    const cats = r.classified.categories;
    const catOrder = Object.keys(cats);

    for (const catId of catOrder) {
      const cat = cats[catId];
      if (cat.hidden || !cat.emails.length) continue;
      if (catId === "ignore") continue;

      lines.push(`### ${cat.label}\n`);
      for (const e of cat.emails) {
        lines.push(`- **[${e.fromName}]** ${e.subject}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function renderDeletionCandidates(allResults) {
  const lines = [];
  const pendingDeletions = [];
  let num = 0;

  lines.push("---\n");
  lines.push("## Deletion Candidates\n");

  for (const r of allResults) {
    for (const e of r.classified.deletionCandidates) {
      num++;
      const accountLabel = allResults.length > 1 ? `[${r.name}] ` : "";
      lines.push(`${num}. ${accountLabel}${e.fromName} — ${e.subject}`);
      pendingDeletions.push({
        number: num,
        id: e.id,
        accountId: r.accountId,
        provider: r.provider,
        sender: e.fromName,
        subject: e.subject,
      });
    }
  }

  if (num === 0) {
    lines.push("No deletion candidates.\n");
    return { text: lines.join("\n"), pendingDeletions: [] };
  }

  lines.push("");
  lines.push(
    "Reply with numbers or ranges to delete (e.g. 'delete 1-12, 15'), or 'delete all'."
  );

  return { text: lines.join("\n"), pendingDeletions };
}

// ---------------------------------------------------------------------------
// Raw output builder
// ---------------------------------------------------------------------------

function buildRawOutput(results, accountTypes) {
  const highKeep = [];
  const highDelete = [];
  const uncertain = [];

  // Build a lookup for account myEmail (needed for BCC detection in bulk signals)
  const companiesJson = JSON.parse(
    readFileSync(join(ROOT, "config/companies.json"), "utf-8")
  );
  const accountEmailMap = {};
  for (const c of companiesJson.companies) {
    accountEmailMap[c.id] = c.myEmail || "";
  }

  for (const r of results) {
    const classified = r.classified;
    const accountId = r.accountId;
    const provider = r.provider;
    const accountName = r.name;

    // Walk through each category's emails
    for (const [catId, cat] of Object.entries(classified.categories)) {
      for (const email of cat.emails) {
        const entry = {
          id: email.id,
          accountId,
          accountName,
          provider,
          sender: email.fromName,
          senderEmail: email.from,
          subject: email.subject,
          isRead: email.isRead,
          hasAttachments: email.hasAttachments,
          bulkSignals: detectBulkSignals(email, accountEmailMap[accountId] || "").signals,
          category: catId,
          categoryLabel: cat.label,
        };

        const isDeletionCandidate = classified.deletionCandidates.some(
          (d) => d.id === email.id
        );

        // High-confidence delete: script classified as ignore AND is a deletion candidate
        // This covers alwaysDelete senders, bulk signal hits, downrank matches
        if (catId === "ignore" && isDeletionCandidate) {
          entry.reason = "Script: deletion candidate (bulk/spam/alwaysDelete)";
          highDelete.push(entry);
        }
        // High-confidence keep: script classified into action/respond category
        // or sender matches prioritySenders/neverDelete
        else if (catId === "action" || catId === "respond") {
          entry.reason = "Script: action/respond category";
          highKeep.push(entry);
        }
        // Everything else is uncertain — Claude will classify
        else {
          uncertain.push(entry);
        }
      }
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    accounts: results.map((r) => ({
      id: r.accountId,
      name: r.name,
      provider: r.provider,
      accountType: r.accountType,
      emailCount: r.count,
    })),
    highKeep,
    highDelete,
    uncertain,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const rawMode = process.argv.includes("--raw");
  const args = process.argv.slice(2).filter(a => a !== "--raw");
  const accountFilter = args[0] || "all";
  const hours = parseInt(args[1] || "24", 10);
  const maxGmail = parseInt(args[2] || "100", 10);

  const { companies, accountTypes, prefs } = loadConfig();

  // Resolve which accounts to triage
  let accounts;
  if (accountFilter === "all") {
    accounts = companies;
  } else {
    const ids = accountFilter.split(",").map((s) => s.trim());
    accounts = companies.filter((c) => ids.includes(c.id));
    if (accounts.length === 0) {
      console.error(`No accounts found matching: ${accountFilter}`);
      process.exit(1);
    }
  }

  // Fetch and classify each account
  const results = [];
  const fetchSummary = [];

  for (const account of accounts) {
    const label = account.name;
    try {
      const emails = await fetchAccount(account, hours, maxGmail);
      const classified = classify(emails, account.id);
      results.push({
        accountId: account.id,
        name: label,
        provider: account.provider || "outlook",
        accountType: account.accountType,
        count: emails.length,
        classified,
      });
      fetchSummary.push({ name: label, count: emails.length, hours });
    } catch (err) {
      console.error(`Error fetching ${label}: ${err.message}`);
      fetchSummary.push({ name: label, error: true, hours });
    }
  }

  // --- RAW MODE: return structured JSON for Claude to classify ---
  if (rawMode) {
    const raw = buildRawOutput(results, accountTypes);
    console.log(JSON.stringify(raw, null, 2));
    return;
  }

  // --- FORMATTED MODE: existing markdown output ---
  const output = [];
  output.push(formatFetchSummary(fetchSummary, prefs));

  const businessResults = results.filter((r) => {
    const tc = accountTypes[r.accountType];
    return tc?.dailyBrief?.section === "main";
  });
  const personalResults = results.filter((r) => {
    const tc = accountTypes[r.accountType];
    return tc?.dailyBrief?.section === "personal-appendix";
  });

  if (businessResults.length) {
    output.push(renderBusinessSection(businessResults, accountTypes));
  }

  if (personalResults.length) {
    output.push(renderPersonalSection(personalResults));
  }

  const { text: deletionText, pendingDeletions } =
    renderDeletionCandidates(results);
  output.push(deletionText);

  if (pendingDeletions.length) {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      join(DATA_DIR, "pending-deletions.json"),
      JSON.stringify(pendingDeletions, null, 2),
      "utf-8"
    );
  }

  console.log(output.join("\n"));
}

main().catch((err) => {
  console.error("Triage failed:", err.message);
  process.exit(1);
});
