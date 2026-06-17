/**
 * store.js — persistence for the daemon's world model + proposal queue.
 * Files live under <dataDir>/. Corrupt files degrade to empty (never throw),
 * so a bad write never bricks the daemon. Uses atomicWrite for OneDrive safety.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../scripts/fs-utils.js";

const EMPTY_MODEL = { generatedAt: null, accounts: {}, items: [] };
const EMPTY_QUEUE = { proposals: [] };

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return structuredClone(fallback); }
}

export function createStore(dataDir) {
  const modelPath = join(dataDir, "world-model.json");
  const queuePath = join(dataDir, "proposal-queue.json");
  return {
    getModel: () => readJson(modelPath, EMPTY_MODEL),
    getQueue: () => readJson(queuePath, EMPTY_QUEUE),
    saveModel: (model) => atomicWrite(modelPath, JSON.stringify(model, null, 2)),
    saveQueue: (queue) => atomicWrite(queuePath, JSON.stringify(queue, null, 2)),
    // test/seam helper: write raw bytes to the model file
    saveModelRaw: (raw) => writeFileSync(modelPath, raw, "utf-8"),
  };
}
