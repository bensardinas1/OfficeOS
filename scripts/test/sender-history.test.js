import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadHistory,
  saveHistory,
  recordDeletion,
  recordKeep,
  thresholdCrossed,
  splitKey
} from "../sender-history.js";

let tmpDir;
let historyPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sender-history-test-"));
  historyPath = join(tmpDir, "sender-history.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadHistory", () => {
  it("returns empty object when file does not exist", () => {
    const h = loadHistory(historyPath);
    assert.deepEqual(h, {});
  });

  it("returns parsed JSON when file exists", () => {
    writeFileSync(historyPath, JSON.stringify({ "personal:foo@x.com": { deletedCount: 3 } }));
    const h = loadHistory(historyPath);
    assert.equal(h["personal:foo@x.com"].deletedCount, 3);
  });
});

describe("saveHistory", () => {
  it("writes atomically (no partial file on failure simulated by file existing)", () => {
    saveHistory(historyPath, { "personal:a@b.com": { deletedCount: 1 } });
    assert.ok(existsSync(historyPath));
    const parsed = JSON.parse(readFileSync(historyPath, "utf-8"));
    assert.equal(parsed["personal:a@b.com"].deletedCount, 1);
  });
});

describe("recordDeletion", () => {
  it("creates entry with deletedCount=1 on first deletion", () => {
    const h = {};
    recordDeletion(h, "personal", "foo@x.com", { hasListUnsubscribe: true, timestamp: "2026-05-21T06:00:00Z" });
    assert.equal(h["personal:foo@x.com"].deletedCount, 1);
    assert.equal(h["personal:foo@x.com"].hasListUnsubscribe, true);
    assert.equal(h["personal:foo@x.com"].lastDeletedAt, "2026-05-21T06:00:00Z");
  });

  it("increments existing counter", () => {
    const h = { "personal:foo@x.com": { deletedCount: 4, hasListUnsubscribe: true, lastDeletedAt: "..." } };
    recordDeletion(h, "personal", "foo@x.com", { hasListUnsubscribe: true, timestamp: "2026-05-21T07:00:00Z" });
    assert.equal(h["personal:foo@x.com"].deletedCount, 5);
    assert.equal(h["personal:foo@x.com"].lastDeletedAt, "2026-05-21T07:00:00Z");
  });

  it("preserves hasListUnsubscribe=true if any prior deletion had it", () => {
    const h = { "personal:foo@x.com": { deletedCount: 1, hasListUnsubscribe: true } };
    recordDeletion(h, "personal", "foo@x.com", { hasListUnsubscribe: false, timestamp: "..." });
    assert.equal(h["personal:foo@x.com"].hasListUnsubscribe, true);
  });

  it("lowercases the sender key", () => {
    const h = {};
    recordDeletion(h, "personal", "FOO@X.com", { hasListUnsubscribe: false, timestamp: "..." });
    assert.ok(h["personal:foo@x.com"]);
  });
});

describe("recordKeep", () => {
  it("resets deletedCount to 0", () => {
    const h = { "personal:foo@x.com": { deletedCount: 7, hasListUnsubscribe: true, lastDeletedAt: "..." } };
    recordKeep(h, "personal", "foo@x.com");
    assert.equal(h["personal:foo@x.com"].deletedCount, 0);
  });

  it("is a no-op when sender not tracked", () => {
    const h = {};
    recordKeep(h, "personal", "foo@x.com");
    assert.deepEqual(h, {});
  });
});

describe("thresholdCrossed", () => {
  it("returns true when deletedCount >= threshold AND hasListUnsubscribe", () => {
    const entry = { deletedCount: 5, hasListUnsubscribe: true };
    assert.equal(thresholdCrossed(entry, 5), true);
  });

  it("returns false when deletedCount < threshold", () => {
    const entry = { deletedCount: 4, hasListUnsubscribe: true };
    assert.equal(thresholdCrossed(entry, 5), false);
  });

  it("returns false when hasListUnsubscribe is false", () => {
    const entry = { deletedCount: 10, hasListUnsubscribe: false };
    assert.equal(thresholdCrossed(entry, 5), false);
  });

  it("returns false when entry is undefined", () => {
    assert.equal(thresholdCrossed(undefined, 5), false);
  });
});

describe("splitKey", () => {
  it("splits a normal key", () => {
    const r = splitKey("personal:foo@x.com");
    assert.equal(r.accountId, "personal");
    assert.equal(r.senderEmail, "foo@x.com");
  });

  it("returns the whole key as accountId when no separator present", () => {
    const r = splitKey("malformed");
    assert.equal(r.accountId, "malformed");
    assert.equal(r.senderEmail, "");
  });

  it("preserves later colons in the email portion (defensive)", () => {
    // Email addresses cannot contain colons per RFC 5321, but be defensive
    // in case future state files have unexpected content.
    const r = splitKey("personal:weird:value");
    assert.equal(r.accountId, "personal");
    assert.equal(r.senderEmail, "weird:value");
  });
});

describe("loadHistory — corrupt JSON resilience", () => {
  it("returns empty object on malformed JSON instead of throwing", () => {
    writeFileSync(historyPath, "{not valid json");
    const h = loadHistory(historyPath);
    assert.deepEqual(h, {});
  });
});
