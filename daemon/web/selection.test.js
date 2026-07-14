import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toggle, pendingApprovalsFor, resolveBulkPlan } from "./selection.js";

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
  it("returns pending proposal ids for the selected items only (item:-prefixed keys)", () => {
    const items = [
      { id: "i1", proposals: [{ id: "i1::draft_chase", state: "pending" }] },
      { id: "i2", proposals: [{ id: "i2::draft_chase", state: "executed" }] },
      { id: "i3", proposals: [{ id: "i3::draft_chase", state: "pending" }] },
    ];
    const sel = new Set(["item:i1", "item:i2"]);
    assert.deepEqual(pendingApprovalsFor(items, sel), ["i1::draft_chase"]);
  });
});

const mem = (id, from, conv, automated) => ({ emailId: id, from, fromName: from, conversationId: conv, automated, receivedAt: "2026-07-01T00:00:00Z", subject: id });
const view = { groups: [ { account: "b", items: [
  { id: "b:handled", account: "b", jobType: "handled", proposals: [], group: { members: [
    mem("c1", "luis@x.com", "cv-1", false), mem("c2", "mck@y.com", "cv-1", false),
    mem("n1", "noise@wp.com", null, true), mem("n2", "noise@wp.com", null, true),
  ] } },
  { id: "b:gw", account: "b", jobType: "gateway", proposals: [{ id: "p1", state: "pending" }], group: { members: [ mem("g1", "support@nmi.com", "cv-9", false) ] } },
] } ] };

describe("pendingApprovalsFor (typed keys)", () => {
  it("matches item:-prefixed keys only", () => {
    const items = view.groups[0].items;
    assert.deepEqual(pendingApprovalsFor(items, new Set(["item:b:gw"])), ["p1"]);
    assert.deepEqual(pendingApprovalsFor(items, new Set(["b:gw"])), []); // unprefixed no longer matches
  });
});

describe("resolveBulkPlan", () => {
  it("delete: tile → id-list; cluster → sender query; conv → id-list", () => {
    const sel = new Set(["item:b:gw", "cluster:b:noise@wp.com", "conv:b:cv-1"]);
    const plan = resolveBulkPlan("delete", sel, view);
    const kinds = plan.ops.map(o => o.kind).sort();
    assert.deepEqual(kinds, ["delete", "delete", "deleteBySender"]);
    const conv = plan.ops.find(o => o.unit === "conversation");
    assert.deepEqual(conv.emailIds.sort(), ["c1", "c2"]);
    const bySender = plan.ops.find(o => o.kind === "deleteBySender");
    assert.equal(bySender.sender, "noise@wp.com");
    assert.deepEqual(bySender.optimisticIds.sort(), ["n1", "n2"]);
  });

  it("dedupe: a tile's ids covered by a selected cluster drop out (skip when emptied)", () => {
    const v = { groups: [ { account: "b", items: [
      { id: "b:t", account: "b", jobType: "gateway", proposals: [], group: { members: [ mem("x1", "noise@wp.com", null, true) ] } },
    ] } ] };
    const plan = resolveBulkPlan("delete", new Set(["item:b:t", "cluster:b:noise@wp.com"]), v);
    assert.equal(plan.ops.filter(o => o.kind === "delete").length, 0);
    assert.equal(plan.ops.filter(o => o.kind === "deleteBySender").length, 1);
    assert.equal(plan.skips.length, 1);
    assert.match(plan.skips[0].reason, /covered/i);
  });

  it("delete skips fully-acted units with 'already deleted'", () => {
    const acted = { g1: { deleted: true, account: "b", emailIds: ["g1"], deleteEntryId: "d1" } };
    const plan = resolveBulkPlan("delete", new Set(["item:b:gw"]), view, acted);
    assert.equal(plan.ops.length, 0);
    assert.match(plan.skips[0].reason, /already deleted/i);
  });

  it("kill: clusters resolve; multi-sender conversations skip; single-sender tiles resolve; dedupes by account+sender", () => {
    const sel = new Set(["cluster:b:noise@wp.com", "conv:b:cv-1", "item:b:gw"]);
    const plan = resolveBulkPlan("kill", sel, view);
    assert.deepEqual(plan.ops.map(o => o.sender).sort(), ["noise@wp.com", "support@nmi.com"]);
    assert.equal(plan.skips.length, 1);
    assert.match(plan.skips[0].reason, /multiple senders/i);
    const wp = plan.ops.find(o => o.sender === "noise@wp.com");
    assert.deepEqual(wp.emailIds.sort(), ["n1", "n2"]);
  });

  it("delkill = delete ops then kill ops", () => {
    const plan = resolveBulkPlan("delkill", new Set(["cluster:b:noise@wp.com"]), view);
    assert.deepEqual(plan.ops.map(o => o.kind), ["deleteBySender", "kill"]);
  });

  it("undo: collects acted entries under selected units, deduped by entry id", () => {
    const acted = {
      c1: { deleted: true, account: "b", emailIds: ["c1"], deleteEntryId: "d9" },
      c2: { deleted: true, killed: true, account: "b", emailIds: ["c2"], deleteEntryId: "d9", sender: "mck@y.com", killEntryId: "k3" },
    };
    const plan = resolveBulkPlan("undo", new Set(["conv:b:cv-1"]), view, acted);
    const restore = plan.ops.find(o => o.kind === "restore");
    assert.equal(restore.undoOf, "d9");
    assert.deepEqual(restore.emailIds.sort(), ["c1", "c2"]); // one op for the shared entry
    const kr = plan.ops.find(o => o.kind === "killRemove");
    assert.deepEqual([kr.sender, kr.undoOf], ["mck@y.com", "k3"]);
  });

  it("undo skips units with nothing acted; approve resolves pending proposals of item keys", () => {
    const p1 = resolveBulkPlan("undo", new Set(["item:b:gw"]), view, {});
    assert.equal(p1.ops.length, 0);
    assert.equal(p1.skips.length, 1);
    const p2 = resolveBulkPlan("approve", new Set(["item:b:gw", "conv:b:cv-1"]), view, {});
    assert.deepEqual(p2.ops, [{ kind: "approve", proposalId: "p1" }]);
  });
});
