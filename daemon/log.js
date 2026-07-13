/**
 * log.js — operational JSONL logger for the daemon. One line per event:
 * {at, level, event, ...fields} appended to <dataDir>/daemon.log and echoed
 * to stdout/stderr. Logging must never crash the daemon: every fs call is
 * wrapped. Rotation happens only at creation (daemon restarts often enough):
 * >5MB renames to daemon.log.1, replacing any previous .1.
 */
import { appendFileSync, existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { safeRename } from "../scripts/fs-utils.js";

const MAX_BYTES = 5 * 1024 * 1024;

export function createLogger(dataDir) {
  const path = join(dataDir, "daemon.log");
  try {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      const prev = path + ".1";
      if (existsSync(prev)) rmSync(prev, { force: true });
      safeRename(path, prev);
    }
  } catch { /* logging must never throw */ }
  return {
    log(level, event, fields = {}) {
      const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...fields });
      try { (level === "error" ? process.stderr : process.stdout).write(line + "\n"); } catch {}
      try { appendFileSync(path, line + "\n", "utf-8"); } catch {}
    },
  };
}
