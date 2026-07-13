/**
 * action-log.js — append-only audit log of every mutating action the daemon
 * performs (data/actions.jsonl), plus the pure deriveActed() fold that turns
 * recent entries into the panel's acted map. Undo is append-only: a reversing
 * entry carries undoOf=<original id>; nothing is ever rewritten (OneDrive-safe,
 * and the file doubles as a permanent audit trail). Corrupt lines are skipped.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export function createActionLog(dataDir, clock = { now: () => new Date().toISOString() }) {
  const path = join(dataDir, "actions.jsonl");
  try { mkdirSync(dataDir, { recursive: true }); } catch {}
  return {
    append(entry) {
      const full = { id: `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`, at: clock.now(), ...entry };
      try { appendFileSync(path, JSON.stringify(full) + "\n", "utf-8"); } catch {}
      return full;
    },
    recent({ days = 7 } = {}) {
      if (!existsSync(path)) return [];
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const out = [];
      let raw;
      try { raw = readFileSync(path, "utf-8"); } catch { return []; }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (Date.parse(e.at) >= cutoff) out.push(e);
        } catch { /* skip corrupt line */ }
      }
      return out;
    },
  };
}

/** Pure fold: recent entries (oldest-first) -> the panel's acted map, keyed by emailId. */
export function deriveActed(entries) {
  const undone = new Set(entries.filter(e => e.undoOf).map(e => e.undoOf));
  const acted = {};
  for (const e of entries) {
    if (e.undoOf || undone.has(e.id) || e.result?.error) continue;
    if (e.action === "delete") {
      for (const id of e.emailIds || []) {
        acted[id] = { ...(acted[id] || {}), deleted: true, account: e.account, emailIds: [id], deleteEntryId: e.id };
      }
    } else if (e.action === "killlist_add" && e.result?.added === true) {
      for (const id of e.emailIds || []) {
        acted[id] = { ...(acted[id] || {}), killed: true, account: e.account, emailIds: [id], sender: e.sender, killEntryId: e.id };
      }
    }
  }
  return acted;
}
