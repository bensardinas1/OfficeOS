import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActionLog, deriveActed } from "./action-log.js";

function tmp() { return mkdtempSync(join(tmpdir(), "officeos-actions-")); }

describe("createActionLog", () => {
  it("round-trips appended entries with generated id + at", () => {
    const dir = tmp();
    const log = createActionLog(dir);
    const e = log.append({ action: "delete", account: "brickell", emailIds: ["a"], result: { trashed: 1, failed: 0 } });
    assert.ok(e.id);
    assert.ok(Date.parse(e.at) > 0);
    const back = log.recent();
    assert.equal(back.length, 1);
    assert.equal(back[0].id, e.id);
    assert.equal(back[0].action, "delete");
    rmSync(dir, { recursive: true, force: true });
  });

  it("recent() filters by day window and skips corrupt lines", () => {
    const dir = tmp();
    const old = { now: () => "2026-01-01T00:00:00.000Z" };
    createActionLog(dir, old).append({ action: "delete", account: "b", emailIds: ["old"], result: { trashed: 1 } });
    appendFileSync(join(dir, "actions.jsonl"), "{not json\n", "utf-8");
    const log = createActionLog(dir);
    log.append({ action: "delete", account: "b", emailIds: ["new"], result: { trashed: 1 } });
    const back = log.recent({ days: 7 });
    assert.equal(back.length, 1);
    assert.deepEqual(back[0].emailIds, ["new"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("recent() returns [] when the file is missing", () => {
    const dir = tmp();
    assert.deepEqual(createActionLog(dir).recent(), []);
    rmSync(dir, { recursive: true, force: true });
  });

  it("append() never throws on an unwritable path and marks the entry persisted:false", () => {
    const dir = tmp();
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory", "utf-8");
    const log = createActionLog(join(blocked, "sub"));
    let e;
    assert.doesNotThrow(() => { e = log.append({ action: "delete", account: "b", emailIds: ["x"], result: { trashed: 1 } }); });
    assert.equal(e.persisted, false);
    assert.ok(e.id);
    const ok = createActionLog(dir).append({ action: "delete", account: "b", emailIds: ["y"], result: { trashed: 1 } });
    assert.equal("persisted" in ok, false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("deriveActed", () => {
  const del = { id: "d1", at: "t", action: "delete", account: "b", emailIds: ["e1", "e2"], result: { trashed: 2, failed: 0 } };
  const kill = { id: "k1", at: "t", action: "killlist_add", account: "b", sender: "spam@x.com", emailIds: ["e1"], result: { added: true } };

  it("marks deleted emailIds per-row, with the contributing entry id", () => {
    const acted = deriveActed([del]);
    assert.deepEqual(acted.e1, { deleted: true, account: "b", emailIds: ["e1"], deleteEntryId: "d1" });
    assert.deepEqual(acted.e2, { deleted: true, account: "b", emailIds: ["e2"], deleteEntryId: "d1" });
  });

  it("merges kill onto the same row and records sender + killEntryId", () => {
    const acted = deriveActed([del, kill]);
    assert.equal(acted.e1.deleted, true);
    assert.equal(acted.e1.killed, true);
    assert.equal(acted.e1.sender, "spam@x.com");
    assert.equal(acted.e1.killEntryId, "k1");
    assert.equal(acted.e2.killed, undefined);
  });

  it("a restore undoOf entry neutralizes only the ids it lists (per-row undo)", () => {
    const undoOne = { id: "r1", at: "t", action: "restore", account: "b", emailIds: ["e1"], result: { restored: 1 }, undoOf: "d1" };
    const acted = deriveActed([del, undoOne]);
    assert.equal(acted.e1, undefined);           // undone row gone
    assert.equal(acted.e2.deleted, true);        // sibling survives
  });

  it("an undoOf entry with no emailIds neutralizes the whole target (kill undo)", () => {
    const killUndo = { id: "ku1", at: "t", action: "killlist_remove", account: "b", sender: "spam@x.com", result: { removed: true }, undoOf: "k1" };
    const acted = deriveActed([del, kill, killUndo]);
    assert.equal(acted.e1.killed, undefined);
    assert.equal(acted.e1.deleted, true);        // delete unaffected
  });

  it("failedIds never contribute; wholly-failed new-shape deletes contribute nothing", () => {
    const partial = { id: "d3", at: "t", action: "delete", account: "b", emailIds: ["p1", "p2"], result: { trashed: 1, failed: 1, failedIds: ["p2"] } };
    const whollyFailed = { id: "d4", at: "t", action: "delete", account: "b", emailIds: ["w1"], result: { trashed: 0, failed: 1, failedIds: ["w1"] } };
    const acted = deriveActed([partial, whollyFailed]);
    assert.equal(acted.p1.deleted, true);
    assert.equal(acted.p2, undefined);
    assert.equal(acted.w1, undefined);
  });

  it("legacy entries without failedIds keep the old behavior", () => {
    const legacy = { id: "d5", at: "t", action: "delete", account: "b", emailIds: ["l1"], result: { trashed: 0, failed: 1 } };
    const acted = deriveActed([legacy]);
    assert.equal(acted.l1.deleted, true); // legacy shape: can't attribute per-id, keep old semantics
  });

  it("failed results and refused kills contribute nothing", () => {
    const failedDel = { id: "d2", at: "t", action: "delete", account: "b", emailIds: ["e9"], result: { error: "boom" } };
    const refusedKill = { id: "k2", at: "t", action: "killlist_add", account: "b", sender: "vip@x.com", emailIds: ["e9"], result: { added: false, reason: "protected" } };
    assert.deepEqual(deriveActed([failedDel, refusedKill]), {});
  });

  it("triage and restore (non-undo) entries contribute nothing", () => {
    const triage = { id: "t1", at: "t", action: "triage", account: null, result: { ok: true } };
    const plainRestore = { id: "r2", at: "t", action: "restore", account: "b", emailIds: ["e1"], result: { restored: 1 } };
    assert.deepEqual(deriveActed([triage, plainRestore]), {});
  });
});
