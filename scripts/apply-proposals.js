/**
 * apply-proposals.js
 *
 * Parses an approval line like:
 *   "approve p-2026-05-21-001, p-2026-05-21-003; decline p-2026-05-21-002"
 *
 * For each approved proposal targeting `companies.<id>.<field>`:
 *   - Atomically appends payload to the target array in config/companies.json.
 *   - Writes a memory journal entry: memory/rule-<id>.md
 *   - If sourceMemoryFile is set, appends "migrated to config on <date>" to that file.
 *
 * Only `companies.*` targets are supported in v1. Approved proposals with other
 * target roots (e.g., `account-types.*`) are pushed to report.skipped without
 * mutating state.
 *
 * For each declined proposal: marks status="declined" in proposed-rules.json.
 *
 * Atomic writes: temp file + rename, with EPERM/EXDEV fallback (Windows + OneDrive).
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { atomicWrite } from "./fs-utils.js";

export function parseApprovalLine(line) {
  const result = { approve: [], decline: [] };
  const segments = line.split(/;|\bthen\b/i);
  for (const seg of segments) {
    const trimmed = seg.trim();
    const approveMatch = trimmed.match(/^\s*approve\s+(.+)/i);
    const declineMatch = trimmed.match(/^\s*decline\s+(.+)/i);
    const m = approveMatch || declineMatch;
    if (!m) continue;
    const ids = m[1].split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    if (approveMatch) result.approve.push(...ids);
    if (declineMatch) result.decline.push(...ids);
  }
  return result;
}

function targetPathPieces(target) {
  return target.split(".");
}

function applyToCompanies(companiesObj, target, payload) {
  const pieces = targetPathPieces(target);
  if (pieces[0] !== "companies") throw new Error(`Unsupported target root: ${pieces[0]}`);
  const accountId = pieces[1];
  const field = pieces[2];
  const account = companiesObj.companies.find(c => c.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);
  if (!Array.isArray(account[field])) account[field] = [];
  account[field].push(payload);
}

export function applyProposals({ approve, decline }, { companiesPath, proposalsPath, memoryDir, now }) {
  const proposals = JSON.parse(readFileSync(proposalsPath, "utf-8"));
  const companies = JSON.parse(readFileSync(companiesPath, "utf-8"));

  const report = { approved: [], declined: [], skipped: [] };
  const approvedSet = new Set(approve);
  const declinedSet = new Set(decline);

  for (const p of proposals.proposals) {
    if (approvedSet.has(p.id)) {
      if (p.status !== "pending") { report.skipped.push({ id: p.id, status: p.status, reason: "not-pending" }); continue; }
      if (p.target.startsWith("companies.")) {
        applyToCompanies(companies, p.target, p.payload);
      } else {
        report.skipped.push(p);
        continue;
      }
      p.status = "approved";
      p.appliedAt = now;
      report.approved.push(p);

      const memPath = join(memoryDir, `rule-${p.id}.md`);
      const memBody =
        `---\nnode_type: memory\ntype: rule-journal\n---\n\n` +
        `# Rule ${p.id}\n\n` +
        `**Target:** \`${p.target}\`\n\n` +
        `**Applied on:** ${now}\n\n` +
        `**Reason:** ${p.reason || "(no reason recorded)"}\n\n` +
        `**Payload:**\n\n\`\`\`json\n${JSON.stringify(p.payload, null, 2)}\n\`\`\`\n`;
      atomicWrite(memPath, memBody);

      if (p.sourceMemoryFile) {
        const srcPath = join(memoryDir, p.sourceMemoryFile);
        if (existsSync(srcPath)) {
          appendFileSync(srcPath, `\n\n> Migrated to config on ${now.slice(0, 10)} as proposal ${p.id} → \`${p.target}\`.\n`);
        }
      }
    } else if (declinedSet.has(p.id)) {
      if (p.status !== "pending") { report.skipped.push({ id: p.id, status: p.status, reason: "not-pending" }); continue; }
      p.status = "declined";
      p.declinedAt = now;
      report.declined.push(p);
    }
  }

  // Unknown ids
  for (const id of [...approvedSet, ...declinedSet]) {
    if (!proposals.proposals.some(p => p.id === id)) {
      report.skipped.push({ id, status: "unknown" });
    }
  }

  // Write the live config first. If this fails, proposals stay "pending"
  // and the user can retry. Writing proposals first risked marking a
  // proposal "approved" without its companies.json patch landing.
  atomicWrite(companiesPath, JSON.stringify(companies, null, 2));
  atomicWrite(proposalsPath, JSON.stringify(proposals, null, 2));

  return report;
}

// CLI mode (optional)
if (process.argv[1] && process.argv[1].endsWith("apply-proposals.js")) {
  const line = process.argv.slice(2).join(" ");
  if (!line) {
    console.error('Usage: node scripts/apply-proposals.js "approve p-... ; decline p-..."');
    process.exit(1);
  }
  const parsed = parseApprovalLine(line);
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = join(__dirname, "..");
  const report = applyProposals(parsed, {
    companiesPath: join(root, "config/companies.json"),
    proposalsPath: join(root, "data/proposed-rules.json"),
    memoryDir: join(root, "memory"),
    now: new Date().toISOString()
  });
  console.log(JSON.stringify(report, null, 2));
}
