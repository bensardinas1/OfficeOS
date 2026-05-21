/**
 * sender-history.js
 *
 * Tracks per-account, per-sender consecutive-deletion counters used by
 * pattern-discovery to propose auto-trash rules.
 *
 * State file: data/sender-history.json
 * Keys: "<accountId>:<senderEmail-lowercase>"
 * Values: { deletedCount, lastDeletedAt, hasListUnsubscribe }
 */

import { readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function loadHistory(historyPath) {
  if (!existsSync(historyPath)) return {};
  try {
    return JSON.parse(readFileSync(historyPath, "utf-8"));
  } catch {
    // Corrupt or unreadable state file — start fresh rather than crash.
    // Auto-trash counters will rebuild on subsequent runs.
    return {};
  }
}

export function saveHistory(historyPath, history) {
  mkdirSync(dirname(historyPath), { recursive: true });
  const tmpPath = `${historyPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(history, null, 2), "utf-8");
  try {
    renameSync(tmpPath, historyPath);
  } catch (err) {
    // Windows + OneDrive can throw EPERM on rename when the target file
    // is briefly locked by the sync agent. EXDEV can occur across mount
    // boundaries. Fall back to copy+unlink — not strictly atomic, but
    // recoverable rather than crashing the entire run.
    if (err.code === "EPERM" || err.code === "EXDEV") {
      copyFileSync(tmpPath, historyPath);
      unlinkSync(tmpPath);
    } else {
      throw err;
    }
  }
}

function keyFor(accountId, senderEmail) {
  return `${accountId}:${(senderEmail || "").toLowerCase()}`;
}

/**
 * Splits a history key back into its components.
 *
 * Account IDs must not contain ":" (this is the only invariant the key
 * encoding requires). Email addresses cannot contain ":" per RFC 5321.
 *
 * Returns { accountId, senderEmail }.
 */
export function splitKey(key) {
  const idx = key.indexOf(":");
  if (idx < 0) return { accountId: key, senderEmail: "" };
  return { accountId: key.slice(0, idx), senderEmail: key.slice(idx + 1) };
}

export function recordDeletion(history, accountId, senderEmail, { hasListUnsubscribe, timestamp }) {
  const key = keyFor(accountId, senderEmail);
  const existing = history[key] || { deletedCount: 0, hasListUnsubscribe: false };
  history[key] = {
    deletedCount: existing.deletedCount + 1,
    hasListUnsubscribe: existing.hasListUnsubscribe || !!hasListUnsubscribe,
    lastDeletedAt: timestamp,
  };
}

export function recordKeep(history, accountId, senderEmail) {
  const key = keyFor(accountId, senderEmail);
  if (history[key]) {
    history[key].deletedCount = 0;
  }
}

export function thresholdCrossed(entry, threshold) {
  if (!entry) return false;
  if (!entry.hasListUnsubscribe) return false;
  return entry.deletedCount >= threshold;
}
