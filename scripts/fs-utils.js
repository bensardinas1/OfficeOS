/**
 * fs-utils.js
 *
 * Shared filesystem helpers used by multiple connectors and helpers.
 */

import { writeFileSync, renameSync, copyFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file atomically (temp file + rename).
 *
 * On Windows + OneDrive, renameSync can throw EPERM when the target file is
 * briefly locked by the sync agent; EXDEV can occur across mount boundaries.
 * Falls back to copyFileSync + unlinkSync — not strictly atomic, but recovers
 * rather than crashing the run.
 *
 * Parent directory is created if missing.
 */
export function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EXDEV") {
      copyFileSync(tmp, path);
      unlinkSync(tmp);
    } else {
      throw err;
    }
  }
}
