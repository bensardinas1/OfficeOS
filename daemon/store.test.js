import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";

function tmp() { return mkdtempSync(join(tmpdir(), "officeos-store-")); }

describe("createStore", () => {
  it("returns empty model + queue when no files exist", () => {
    const dir = tmp();
    try {
      const store = createStore(dir);
      assert.deepEqual(store.getModel().items, []);
      assert.deepEqual(store.getQueue().proposals, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("persists and reloads the model and queue", () => {
    const dir = tmp();
    try {
      const a = createStore(dir);
      a.saveModel({ generatedAt: "t", accounts: { brickell: { status: "ok", lastTickAt: "t" } }, items: [{ id: "x" }] });
      a.saveQueue({ proposals: [{ id: "p1", state: "pending" }] });
      const b = createStore(dir); // fresh instance reads from disk
      assert.equal(b.getModel().items[0].id, "x");
      assert.equal(b.getQueue().proposals[0].id, "p1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("survives a corrupt file by returning empty", () => {
    const dir = tmp();
    try {
      const store = createStore(dir);
      store.saveModelRaw("{ not json");
      assert.deepEqual(store.getModel().items, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
