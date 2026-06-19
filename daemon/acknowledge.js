/**
 * acknowledge.js — item-level acknowledge: a fingerprint of an item's salient
 * fields, a small persisted ack store, and a pure applyAcks that suppresses an
 * acknowledged item ONLY while its fingerprint still matches (re-alert on change).
 * Local-state only — no mail, no external calls.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../scripts/fs-utils.js";

export function fingerprint(item) {
  const salient = JSON.stringify({ id: item.id, status: item.status, title: item.title, rootCause: item.group?.rootCause });
  return createHash("sha1").update(salient).digest("hex").slice(0, 16);
}

export function createAckStore(dataDir) {
  const path = join(dataDir, "acknowledged.json");
  const read = () => {
    if (!existsSync(path)) return {};
    try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return {}; }
  };
  return {
    getAcks: () => read(),
    recordAck: (itemId, fp, now) => {
      const acks = read();
      acks[itemId] = { fingerprint: fp, ackedAt: now };
      atomicWrite(path, JSON.stringify(acks, null, 2));
    },
    removeAck: (itemId) => {
      const acks = read();
      delete acks[itemId];
      atomicWrite(path, JSON.stringify(acks, null, 2));
    },
    saveRaw: (raw) => writeFileSync(path, raw, "utf-8"),
  };
}

export function applyAcks(items, acks) {
  return items.map(item => {
    const ack = acks[item.id];
    if (ack && ack.fingerprint === item.fingerprint) {
      return { ...item, status: "ok", acknowledged: true };
    }
    return item;
  });
}
