/**
 * killlist-add.js <accountId>   (sender JSON on stdin: { "sender": "x@y.com" })
 *
 * Appends an EMAIL-EXACT rule to a company's alwaysDelete kill-list so future
 * mail from that sender auto-deletes. Config write ONLY — never sends or deletes
 * mail. Guarded (mirrors promote-senders): refuses protected senders, anyone the
 * user corresponds with, and senders already on the list.
 *
 * Prints { added: bool, reason: string|null, value: string } to stdout.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isProtectedSender } from "./sender-guards.js";
import { atomicWrite } from "./fs-utils.js";
import { loadCorrespondentsFile, correspondentSet } from "./correspondents.js";

/** Pure: returns { cfg, added, reason }. correspondents = Set<lowercased email> (optional). */
export function addSenderToKillList(cfg, accountId, sender, { correspondents } = {}) {
  const email = String(sender || "").trim().toLowerCase();
  const company = (cfg.companies || []).find(c => c.id === accountId);
  if (!company) return { cfg, added: false, reason: `unknown account: ${accountId}` };
  if (!email || !email.includes("@")) return { cfg, added: false, reason: "not a valid email address" };
  if (isProtectedSender(company, email)) return { cfg, added: false, reason: "protected sender (priority/never-delete/own domain)" };
  if (correspondents && correspondents.has(email)) return { cfg, added: false, reason: "you've emailed this sender (correspondent)" };
  company.alwaysDelete ||= [];
  const domain = email.split("@")[1] || "";
  for (const rule of company.alwaysDelete) {
    if (rule.type === "email" && (rule.value || "").toLowerCase() === email) return { cfg, added: false, reason: "already on the kill-list" };
    if (rule.type === "domain" && (rule.value || "").toLowerCase() === domain) return { cfg, added: false, reason: "domain already kill-listed" };
  }
  company.alwaysDelete.push({ type: "email", value: email, label: `added from panel` });
  return { cfg, added: true, reason: null, value: email };
}

/**
 * Full-cycle: load companies.json from configDir (NOT repo root — the daemon
 * and the CLI resolve different config dirs), apply the kill-list add, and
 * atomically persist only when it actually changed. correspondentsPath is
 * optional; a missing/corrupt file degrades to no correspondent protection
 * (the other guards still apply) rather than throwing.
 */
export async function applyKillListAdd(configDir, accountId, sender, { correspondentsPath } = {}) {
  const cfgPath = join(configDir, "companies.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  let correspondents;
  try { if (correspondentsPath) correspondents = correspondentSet(loadCorrespondentsFile(correspondentsPath), accountId); }
  catch { correspondents = undefined; }
  const r = addSenderToKillList(cfg, accountId, sender, { correspondents });
  if (r.added) atomicWrite(cfgPath, JSON.stringify(cfg, null, 2));
  return { added: r.added, reason: r.reason, value: r.value || null };
}

if (process.argv[1] && process.argv[1].endsWith("killlist-add.js")) {
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const accountId = process.argv[2];
  if (!accountId) { console.error("Usage: node scripts/killlist-add.js <accountId>  (sender JSON on stdin)"); process.exit(1); }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  let input = "";
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) input += chunk;
  let sender;
  try { sender = JSON.parse(input).sender; } catch { console.error("stdin must be JSON { sender }"); process.exit(1); }

  const r = await applyKillListAdd(join(root, "config"), accountId, sender, { correspondentsPath: join(root, "data/correspondents.json") });
  process.stdout.write(JSON.stringify(r));
}
