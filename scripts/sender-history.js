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

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function loadHistory(historyPath) {
  if (!existsSync(historyPath)) return {};
  const raw = readFileSync(historyPath, "utf-8");
  return JSON.parse(raw);
}

export function saveHistory(historyPath, history) {
  mkdirSync(dirname(historyPath), { recursive: true });
  const tmpPath = `${historyPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(history, null, 2), "utf-8");
  renameSync(tmpPath, historyPath);
}

function keyFor(accountId, senderEmail) {
  return `${accountId}:${(senderEmail || "").toLowerCase()}`;
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
