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
import { isProtectedSender } from "./sender-guards.js";

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

if (process.argv[1] && process.argv[1].endsWith("killlist-add.js")) {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { atomicWrite } = await import("./fs-utils.js");
  const { loadCorrespondentsFile, correspondentSet } = await import("./correspondents.js");

  const accountId = process.argv[2];
  if (!accountId) { console.error("Usage: node scripts/killlist-add.js <accountId>  (sender JSON on stdin)"); process.exit(1); }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  let input = "";
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) input += chunk;
  let sender;
  try { sender = JSON.parse(input).sender; } catch { console.error("stdin must be JSON { sender }"); process.exit(1); }

  const cfgPath = join(root, "config/companies.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  let correspondents;
  try {
    const corrFile = loadCorrespondentsFile(join(root, "data/correspondents.json"));
    correspondents = correspondentSet(corrFile, accountId);
  } catch { correspondents = undefined; }

  const r = addSenderToKillList(cfg, accountId, sender, { correspondents });
  if (r.added) atomicWrite(cfgPath, JSON.stringify(cfg, null, 2));
  process.stdout.write(JSON.stringify({ added: r.added, reason: r.reason, value: r.value || null }));
}
