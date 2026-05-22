import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWrite } from "../fs-utils.js";

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fs-utils-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("atomicWrite", () => {
  it("creates the file with the given content", () => {
    const path = join(tmpDir, "subdir", "out.txt");
    atomicWrite(path, "hello world");
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path, "utf-8"), "hello world");
  });

  it("creates parent directories if missing", () => {
    const path = join(tmpDir, "a", "b", "c", "out.txt");
    atomicWrite(path, "nested");
    assert.equal(readFileSync(path, "utf-8"), "nested");
  });

  it("overwrites an existing file", () => {
    const path = join(tmpDir, "out.txt");
    atomicWrite(path, "first");
    atomicWrite(path, "second");
    assert.equal(readFileSync(path, "utf-8"), "second");
  });
});
