import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Forbidden by the non-negotiable rails: never auto-send, soft-delete only.
const FORBIDDEN = [
  /\bsendMail\b/i,            // Graph send
  /\/sendMail\b/i,
  /messages\.send\b/i,        // Gmail send
  /\.send\s*\(/,             // generic send(
  /messages\.delete\b/i,      // Gmail permanent delete
  /messages\.batchDelete\b/i,
  /\bbatchDelete\b/i,
];

function executorFiles() {
  return readdirSync(here)
    .filter(f => f.endsWith(".js") && !f.endsWith(".test.js"));
}

describe("executor rails guard", () => {
  it("no executor references a send or permanent-delete API", () => {
    const violations = [];
    for (const f of executorFiles()) {
      const src = readFileSync(join(here, f), "utf-8");
      for (const rx of FORBIDDEN) {
        if (rx.test(src)) violations.push(`${f} matches ${rx}`);
      }
    }
    assert.deepEqual(violations, [], `rails violations:\n${violations.join("\n")}`);
  });
});
