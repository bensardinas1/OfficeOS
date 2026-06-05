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
  const needle = (payloadValue || "").toLowerCase();
  return proposals.some(p => {
    if (p.status !== "pending") return false;
    if (p.target !== target) return false;
    const payload = p.payload || {};
    // For alwaysDelete / neverDelete entries
    if (typeof payload.value === "string" && payload.value.toLowerCase() === needle) return true;
    // For scamPatterns entries (subjectAll is an array of phrases)
    if (Array.isArray(payload.subjectAll) && payload.subjectAll.some(s => (s || "").toLowerCase() === needle)) return true;
    return false;
  });
}

function findAccount(accounts, accountId) {
  return accounts.find(a => a.id === accountId);
}

/**
 * Returns the next counter value to use for proposals on `datePart` (YYYY-MM-DD),
 * given the current proposals array. Looks at the maximum counter already in use
 * for that date across ALL existing proposal IDs (any status).
 *
 * Contract: when the orchestrator calls multiple discovery functions in the same
 * run, it MUST concatenate the output of each call into the proposals array
 * passed to the next call. Otherwise this function will re-issue the same
 * counter values to each caller. See the morning-brief orchestrator (Task 7)
 * for the accumulator pattern.
 */
export function nextCounterFor(proposals, datePart) {
  let max = 0;
  const pattern = new RegExp(`^p-${datePart}-(\\d{3})$`);
  for (const p of proposals) {
    const m = (p.id || "").match(pattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
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

function alreadyAutoTrashed(account, senderEmail) {
  const domain = (senderEmail.split("@")[1] || "").toLowerCase();
  for (const rule of (account.alwaysDelete || [])) {
    if (rule.type === "email" && rule.value.toLowerCase() === senderEmail.toLowerCase()) return true;
    if (rule.type === "domain" && rule.value.toLowerCase() === domain) return true;
  }
  return false;
}

export function discoverAutoTrash(history, accounts, pendingProposals, { now }) {
  const proposals = [];
  const datePart = (now || "").slice(0, 10);
  let counter = nextCounterFor(pendingProposals, datePart);
  for (const [key, entry] of Object.entries(history)) {
    const { accountId, senderEmail } = splitKey(key);
    if (!entry.hasListUnsubscribe) continue;
    if (entry.deletedCount < AUTO_TRASH_THRESHOLD) continue;
    const account = findAccount(accounts, accountId);
    if (!account) continue;
    if (senderIsProtected(account, senderEmail)) continue;
    if (alreadyAutoTrashed(account, senderEmail)) continue;
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
 *
 * The STOPWORDS list is intentionally broad — single-word patterns like
 * `["with"]` or `["save"]` would catastrophically over-delete if approved as
 * a scamPattern. Anything that's a common English connector, modal verb,
 * preposition, generic action verb, or vague noun is filtered out so it
 * can't seed a one-word fingerprint.
 */
const STOPWORDS = new Set([
  // articles / pronouns / determiners
  "the", "a", "an", "this", "that", "these", "those", "your", "you", "yours",
  "our", "ours", "their", "theirs", "they", "them", "his", "her", "hers", "its",
  "my", "mine", "me", "we", "us", "i", "he", "she", "it", "who", "whose", "what",
  "which", "any", "all", "some", "each", "every", "other", "another", "such",
  "own", "same", "many", "much", "more", "most", "few", "less", "least", "both",
  "either", "neither", "none", "one", "two", "three",
  // be / have / do / modal verbs
  "is", "are", "was", "were", "been", "being", "be",
  "have", "has", "had", "having",
  "do", "does", "did", "done", "doing",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  // conjunctions / connectors
  "and", "or", "but", "nor", "yet", "so", "for", "if", "then", "than", "as",
  "because", "since", "though", "although", "while", "whereas", "unless",
  // prepositions
  "to", "in", "on", "at", "by", "with", "from", "about", "into", "onto", "upon",
  "over", "under", "above", "below", "between", "among", "through", "throughout",
  "during", "before", "after", "across", "behind", "beyond", "near", "next",
  "off", "out", "up", "down", "back", "away", "along", "around", "without",
  "within", "against", "toward", "towards", "via",
  // adverbs and vague modifiers
  "also", "still", "just", "even", "very", "really", "quite", "rather", "ever",
  "never", "always", "often", "sometimes", "now", "today", "yesterday", "soon",
  "later", "then", "again", "here", "there", "where", "when", "how", "why",
  "only", "almost", "already", "thus", "however", "instead", "anyway",
  // common nouns / generic content
  "time", "way", "thing", "things", "stuff", "people", "person", "thing", "day",
  "year", "week", "month", "morning", "afternoon", "evening", "night", "today",
  // generic verbs
  "make", "made", "making", "get", "got", "getting", "go", "going", "went", "gone",
  "come", "came", "coming", "see", "saw", "seen", "seeing", "look", "looking",
  "find", "found", "finding", "tell", "told", "telling", "ask", "asked", "asking",
  "try", "tried", "trying", "need", "needed", "want", "wanted", "feel", "felt",
  "seem", "seemed", "let", "put", "keep", "kept", "help", "helped", "show", "showed",
  "work", "worked", "play", "played", "move", "moved", "live", "lived",
  "say", "said", "saying", "know", "knew", "knowing", "think", "thought",
  "take", "took", "taking", "taken", "give", "gave", "given", "giving",
  "save", "saved", "saving", "send", "sent", "sending",
  // common adjectives / vague descriptors
  "good", "bad", "new", "old", "big", "small", "high", "low", "long", "short",
  "best", "worst", "great", "right", "wrong", "true", "false", "free", "open",
  "early", "late", "last", "first", "second", "third", "next", "previous",
  "inside", "outside",
  // email/transactional plumbing
  "re", "fw", "fwd", "reply", "subject", "email", "message",
]);
const NUMERIC_TOKEN = /^\d+$/;

function commonSubjectTerms(subjects) {
  const sets = subjects.map(s =>
    new Set(
      s.toLowerCase()
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length >= 4 && !STOPWORDS.has(w) && !NUMERIC_TOKEN.test(w))
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
  const datePart = (now || "").slice(0, 10);
  let counter = nextCounterFor(pendingProposals, datePart);
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
      // Require at least 2 content terms in the intersection. Single-word
      // patterns like ["with"] or ["save"] are inherently over-broad — they
      // catch huge swaths of legitimate email. If the cluster only shares
      // one content word, skip rather than propose.
      if (terms.length < 2) continue;
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
  const datePart = (now || "").slice(0, 10);
  let counter = nextCounterFor(pendingProposals, datePart);
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

    // Route to the account whose memoryKeywords match the file body.
    // Falls back to the first personal-type account, or the first account
    // overall if no personal account exists.
    const bodyLower = body.toLowerCase();
    let targetAccount = null;
    for (const acct of accounts) {
      const keywords = acct.memoryKeywords || [];
      if (keywords.some(kw => bodyLower.includes(kw.toLowerCase()))) {
        targetAccount = acct.id;
        break;
      }
    }
    if (!targetAccount) {
      const personalAcct = accounts.find(a => a.accountType === "personal");
      targetAccount = personalAcct ? personalAcct.id : (accounts[0] ? accounts[0].id : "personal");
    }
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
