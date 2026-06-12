/**
 * correspondents.js
 *
 * Sent-mail-derived sender protection: if the user has ever emailed an address,
 * mail FROM that address is never heuristically deleted ("people I've written
 * to are not junk"). Explicit config rules (alwaysDelete / scamPatterns) still
 * win — a deliberate kill-list entry beats the inference.
 *
 * State file: data/correspondents.json — { "<accountId>": ["addr", ...] }
 * Harvested by scripts/build-correspondents.js from the account's Sent folder.
 */

import { readFileSync, existsSync } from "node:fs";
import { atomicWrite } from "./fs-utils.js";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** "Name <a@b.com>, c@d.com" -> ["a@b.com", "c@d.com"] (lowercased, in order) */
export function parseAddressList(headerValue) {
  const out = [];
  const seen = new Set();
  for (const m of String(headerValue || "").matchAll(EMAIL_RE)) {
    const addr = m[0].toLowerCase();
    if (!seen.has(addr)) { seen.add(addr); out.push(addr); }
  }
  return out;
}

/** Merge addresses into map[accountId] (lowercased, deduped, sorted). */
export function mergeCorrespondents(map, accountId, addresses) {
  const set = new Set(map[accountId] || []);
  for (const a of addresses || []) {
    const addr = String(a || "").trim().toLowerCase();
    if (addr.includes("@")) set.add(addr);
  }
  map[accountId] = [...set].sort();
  return map;
}

/** Load the state file; {} on missing/corrupt (protection degrades gracefully). */
export function loadCorrespondentsFile(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveCorrespondentsFile(path, map) {
  atomicWrite(path, JSON.stringify(map, null, 2));
}

export function correspondentSet(map, accountId) {
  return new Set(map[accountId] || []);
}
