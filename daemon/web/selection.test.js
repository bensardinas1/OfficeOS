import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toggle, pendingApprovalsFor } from "./selection.js";

describe("toggle", () => {
  it("adds and removes ids from a selection set immutably", () => {
    const a = toggle(new Set(), "x");
    assert.ok(a.has("x"));
    const b = toggle(a, "x");
    assert.ok(!b.has("x"));
    assert.ok(a.has("x")); // original unchanged
  });
});

describe("pendingApprovalsFor", () => {
  it("returns pending proposal ids for the selected items only", () => {
    const items = [
      { id: "i1", proposals: [{ id: "i1::draft_chase", state: "pending" }] },
      { id: "i2", proposals: [{ id: "i2::draft_chase", state: "executed" }] },
      { id: "i3", proposals: [{ id: "i3::draft_chase", state: "pending" }] },
    ];
    const sel = new Set(["i1", "i2"]);
    assert.deepEqual(pendingApprovalsFor(items, sel), ["i1::draft_chase"]);
  });
});
