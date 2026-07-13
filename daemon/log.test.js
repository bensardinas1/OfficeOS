import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./log.js";

function tmp() { return mkdtempSync(join(tmpdir(), "officeos-log-")); }

describe("createLogger", () => {
  it("appends one JSON line per event with at/level/event + fields", () => {
    const dir = tmp();
    const logger = createLogger(dir);
    logger.log("info", "daemon-started", { pid: 123, port: 8138 });
    logger.log("error", "tick-error", { stack: "boom" });
    const lines = readFileSync(join(dir, "daemon.log"), "utf-8").trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].event, "daemon-started");
    assert.equal(lines[0].level, "info");
    assert.equal(lines[0].pid, 123);
    assert.ok(Date.parse(lines[0].at) > 0);
    assert.equal(lines[1].level, "error");
    assert.equal(lines[1].stack, "boom");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rotates an oversized log to .1 at creation time", () => {
    const dir = tmp();
    writeFileSync(join(dir, "daemon.log"), "x".repeat(5 * 1024 * 1024 + 1), "utf-8");
    createLogger(dir);
    assert.ok(existsSync(join(dir, "daemon.log.1")));
    assert.ok(!existsSync(join(dir, "daemon.log")));
    rmSync(dir, { recursive: true, force: true });
  });

  it("never throws when the data dir is unwritable", () => {
    // point at a path that cannot exist as a dir (file in the way)
    const dir = tmp();
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "file", "utf-8");
    const logger = createLogger(join(blocked, "sub")); // mkdir will fail
    assert.doesNotThrow(() => logger.log("info", "x", {}));
    rmSync(dir, { recursive: true, force: true });
  });
});
