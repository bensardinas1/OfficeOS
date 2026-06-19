/**
 * killlist-remove.js <accountId>   (sender JSON on stdin: { "sender": "x@y.com" })
 *
 * Removes an EMAIL-EXACT rule from a company's alwaysDelete kill-list (undo of
 * killlist-add). Config write ONLY — never sends or deletes mail.
 * Prints { removed: bool, reason: string|null }.
 */
export function removeSenderFromKillList(cfg, accountId, sender) {
  const email = String(sender || "").trim().toLowerCase();
  const company = (cfg.companies || []).find(c => c.id === accountId);
  if (!company) return { cfg, removed: false, reason: `unknown account: ${accountId}` };
  const before = (company.alwaysDelete || []).length;
  company.alwaysDelete = (company.alwaysDelete || []).filter(
    r => !(r.type === "email" && (r.value || "").toLowerCase() === email)
  );
  if (company.alwaysDelete.length === before) return { cfg, removed: false, reason: "not on the kill-list" };
  return { cfg, removed: true, reason: null };
}

if (process.argv[1] && process.argv[1].endsWith("killlist-remove.js")) {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { atomicWrite } = await import("./fs-utils.js");
  const accountId = process.argv[2];
  if (!accountId) { console.error("Usage: node scripts/killlist-remove.js <accountId>  (sender JSON on stdin)"); process.exit(1); }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let input = "";
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) input += chunk;
  let sender;
  try { sender = JSON.parse(input).sender; } catch { console.error("stdin must be JSON { sender }"); process.exit(1); }
  const cfgPath = join(root, "config/companies.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  const r = removeSenderFromKillList(cfg, accountId, sender);
  if (r.removed) atomicWrite(cfgPath, JSON.stringify(cfg, null, 2));
  process.stdout.write(JSON.stringify({ removed: r.removed, reason: r.reason }));
}
