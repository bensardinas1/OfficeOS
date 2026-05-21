/**
 * pattern-discovery.js
 *
 * Three discovery functions that emit rule proposals for the morning brief:
 *
 *   discoverAutoTrash(history, accounts, pendingProposals, opts)
 *     → senders with >=5 consecutive deletes + list-unsubscribe + not protected
 *
 *   discoverScamPatterns(recentDeletions, accounts, pendingProposals, opts)
 *     → recurring subject patterns across multiple sender domains
 *
 *   discoverMemoryBackfill(memoryDir, accounts, pendingProposals, opts)
 *     → memory entries (feedback_*.md / relationship_*.md) referencing
 *       senders not yet represented in any account's neverDelete
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { splitKey } from "./sender-history.js";

const AUTO_TRASH_THRESHOLD = 5;
const SCAM_WINDOW_DAYS = 30;
const SCAM_MIN_HITS = 3;
const SCAM_MIN_DOMAINS = 2;

export function proposalId(timestamp, counter) {
  const datePart = (timestamp || "").slice(0, 10); // YYYY-MM-DD
  const counterPart = String(counter).padStart(3, "0");
  return `p-${datePart}-${counterPart}`;
}

export function isPendingProposal(proposals, target, payloadValue) {
  return proposals.some(p =>
    p.status === "pending" &&
    p.target === target &&
    JSON.stringify(p.payload).toLowerCase().includes((payloadValue || "").toLowerCase())
  );
}

function findAccount(accounts, accountId) {
  return accounts.find(a => a.id === accountId);
}

function senderIsProtected(account, senderEmail) {
  const domain = (senderEmail.split("@")[1] || "").toLowerCase();
  const lists = [...(account.neverDelete || []), ...(account.prioritySenders || [])];
  for (const rule of lists) {
    if (rule.type === "email" && rule.value.toLowerCase() === senderEmail.toLowerCase()) return true;
    if (rule.type === "domain" && rule.value.toLowerCase() === domain) return true;
  }
  return false;
}

export function discoverAutoTrash(history, accounts, pendingProposals, { now }) {
  const proposals = [];
  let counter = pendingProposals.length + 1;
  for (const [key, entry] of Object.entries(history)) {
    const { accountId, senderEmail } = splitKey(key);
    if (!entry.hasListUnsubscribe) continue;
    if (entry.deletedCount < AUTO_TRASH_THRESHOLD) continue;
    const account = findAccount(accounts, accountId);
    if (!account) continue;
    if (senderIsProtected(account, senderEmail)) continue;
    const target = `companies.${accountId}.alwaysDelete`;
    if (isPendingProposal(pendingProposals, target, senderEmail)) continue;
    proposals.push({
      id: proposalId(now, counter++),
      target,
      payload: {
        type: "email",
        value: senderEmail,
        label: `${senderEmail} (${entry.deletedCount} consecutive deletes)`
      },
      reason: `${entry.deletedCount} consecutive deletes + list-unsubscribe + not protected`,
      proposedAt: now,
      status: "pending"
    });
  }
  return proposals;
}

/**
 * Extract a "fuzzy subject pattern" — the common lowercase content words
 * across a set of subject strings. Stopwords filtered. Returns up to 2 terms.
 */
function commonSubjectTerms(subjects) {
  const STOPWORDS = new Set(["the", "a", "an", "your", "you", "is", "for", "of", "and", "to", "in", "on", "at", "2026", "2025", "re", "fw", "fwd"]);
  const sets = subjects.map(s =>
    new Set(
      s.toLowerCase()
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length >= 4 && !STOPWORDS.has(w))
    )
  );
  if (sets.length === 0) return [];
  // intersection
  let common = [...sets[0]];
  for (let i = 1; i < sets.length; i++) {
    common = common.filter(w => sets[i].has(w));
  }
  return common.slice(0, 2);
}

export function discoverScamPatterns(recentDeletions, accounts, pendingProposals, { now }) {
  const proposals = [];
  let counter = pendingProposals.length + 1;
  const cutoff = new Date(now).getTime() - SCAM_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  // group by account
  const byAccount = {};
  for (const d of recentDeletions) {
    const ts = new Date(d.deletedAt).getTime();
    if (ts < cutoff) continue;
    (byAccount[d.accountId] = byAccount[d.accountId] || []).push(d);
  }

  for (const [accountId, deletions] of Object.entries(byAccount)) {
    const account = findAccount(accounts, accountId);
    if (!account) continue;

    // Cluster by common subject terms — naive: any pair sharing a common
    // content term forms a cluster. For v1 we look at the dominant term.
    const termHits = {}; // term -> { domains: Set, deletions: [] }
    for (const d of deletions) {
      const terms = commonSubjectTerms([d.subject]);
      for (const t of terms) {
        const entry = (termHits[t] = termHits[t] || { domains: new Set(), deletions: [] });
        entry.domains.add(d.senderDomain.toLowerCase());
        entry.deletions.push(d);
      }
    }

    // Dedupe clusters that resolve to the same subjectAll fingerprint.
    // Two different seed terms (e.g. "annual" and "report") can yield the
    // same intersected pattern across the same deletions — emit one proposal.
    const seenFingerprints = new Set();
    for (const [, info] of Object.entries(termHits)) {
      if (info.deletions.length < SCAM_MIN_HITS) continue;
      if (info.domains.size < SCAM_MIN_DOMAINS) continue;

      // Look at all subjects sharing this term and intersect to find the full pattern
      const terms = commonSubjectTerms(info.deletions.map(d => d.subject));
      if (terms.length === 0) continue;
      // Join into a single phrase entry — classify-emails expects subjectAll
      // to be an array of substrings that all must appear in the subject.
      const subjectAll = [terms.join(" ")];
      const fingerprint = [...terms].sort().join("|");
      if (seenFingerprints.has(fingerprint)) continue;
      seenFingerprints.add(fingerprint);
      // Skip if any sender domain is in neverDelete (would be a false positive)
      const anyProtected = [...info.domains].some(domain =>
        (account.neverDelete || []).some(r => r.type === "domain" && r.value.toLowerCase() === domain)
      );
      if (anyProtected) continue;

      const target = `companies.${accountId}.scamPatterns`;
      if (isPendingProposal(pendingProposals, target, subjectAll[0])) continue;

      proposals.push({
        id: proposalId(now, counter++),
        target,
        payload: {
          label: `Recurring subject pattern: "${subjectAll[0]}"`,
          subjectAll,
          senderAllowlist: [],
          action: "delete"
        },
        reason: `${info.deletions.length} deletions in ${SCAM_WINDOW_DAYS}d across ${info.domains.size} sender domains`,
        proposedAt: now,
        status: "pending"
      });
    }
  }

  return proposals;
}

/**
 * Scan a memory directory for feedback_*.md / relationship_*.md files and
 * propose neverDelete entries for senders mentioned in those files that
 * are not yet in any account's neverDelete.
 *
 * v1 heuristic: extract an email-shaped or domain-shaped token from the
 * body. If none, propose nothing for that file (the human will do it).
 */
export function discoverMemoryBackfill(memoryDir, accounts, pendingProposals, { now }) {
  if (!existsSync(memoryDir)) return [];
  const proposals = [];
  let counter = pendingProposals.length + 1;
  const files = readdirSync(memoryDir).filter(f =>
    (f.startsWith("feedback_") || f.startsWith("relationship_")) && f.endsWith(".md")
  );

  for (const file of files) {
    const body = readFileSync(join(memoryDir, file), "utf-8");
    // Extract email-shaped token
    const emailMatch = body.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    const domainMatch = !emailMatch && body.match(/\b([a-z0-9-]+\.(?:com|org|net|edu|gov|io))\b/i);
    const value = emailMatch ? emailMatch[0].toLowerCase() : (domainMatch ? domainMatch[1].toLowerCase() : null);
    if (!value) continue;
    const type = emailMatch ? "email" : "domain";

    // Check if any account's neverDelete already covers this
    const alreadyCovered = accounts.some(account =>
      (account.neverDelete || []).some(rule => {
        if (rule.type === "email" && rule.value.toLowerCase() === value) return true;
        if (rule.type === "domain") {
          if (type === "email") return value.endsWith("@" + rule.value.toLowerCase()) || value.endsWith("." + rule.value.toLowerCase());
          return rule.value.toLowerCase() === value;
        }
        return false;
      })
    );
    if (alreadyCovered) continue;

    // Default to personal account if no signal; this is a hint, user can change on approval
    const targetAccount = body.toLowerCase().includes("healthcare m&a") || body.toLowerCase().includes("hcma")
      ? "healthcarema"
      : "personal";
    const target = `companies.${targetAccount}.neverDelete`;
    if (isPendingProposal(pendingProposals, target, value)) continue;

    proposals.push({
      id: proposalId(now, counter++),
      target,
      payload: {
        type,
        value,
        label: `Backfilled from memory: ${file}`
      },
      reason: `Memory entry ${file} references ${value} but no config rule exists`,
      proposedAt: now,
      status: "pending",
      sourceMemoryFile: file
    });
  }
  return proposals;
}
