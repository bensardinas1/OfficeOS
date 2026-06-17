import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { runTick } from "./scheduler.js";

function tmp() { return mkdtempSync(join(tmpdir(), "officeos-sched-")); }

const account = { id: "brickell", accountType: "business", links: { billing_portal: "https://pay.example/portal" } };
const typeConfigs = { business: { jobTypes: { owed_risk: {
  sourceCategories: ["action"],
  failureSignals: ["payment failed", "was declined"],
  grouping: { order: ["card", "vendorDomain"] },
  threshold: { atRiskMembers: 1 },
} } } };

// classifyFn returns category buckets like the existing classify() does.
const classified = { categories: {
  action: { emails: [
    { id: "e1", from: "billing@acme.com", fromName: "Acme", subject: "Payment failed — card ending in 4821", preview: "" },
    { id: "e2", from: "ar@globex.com", fromName: "Globex", subject: "card ending in 4821 was declined", preview: "" },
  ] },
  fyi: { emails: [{ id: "e9", from: "n@x.com", subject: "hi", preview: "" }] },
} };

function deps(dir, over = {}) {
  return {
    accounts: [account],
    typeConfigs,
    store: createStore(dir),
    fetchFn: async () => [{ id: "e1" }], // raw emails; classifyFn ignores and returns fixture
    classifyFn: () => classified,
    clock: { now: "2026-06-16T12:00:00Z" },
    emit: () => {},
    ...over,
  };
}

describe("runTick", () => {
  it("produces a grouped owed_risk item and a pending proposal, persisted", async () => {
    const dir = tmp();
    try {
      const d = deps(dir);
      await runTick(d);
      const model = d.store.getModel();
      const item = model.items.find(i => i.group.rootCause === "card_4821");
      assert.ok(item);
      assert.equal(item.group.members.length, 2);
      assert.equal(model.accounts.brickell.status, "ok");
      const queue = d.store.getQueue();
      assert.ok(queue.proposals.some(p => p.id === "brickell:owed_risk:card_4821::draft_chase" && p.state === "pending"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("marks an account stale and keeps last-good items when fetch throws", async () => {
    const dir = tmp();
    try {
      await runTick(deps(dir)); // seed a good model
      const d = deps(dir, { fetchFn: async () => { throw new Error("boom"); } });
      const summary = await runTick(d);
      const model = d.store.getModel();
      assert.equal(model.accounts.brickell.status, "stale");
      assert.ok(model.items.length > 0, "last-good items retained");
      assert.ok(summary.warnings.some(w => /boom/.test(w)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("emits an update event only when the model changed", async () => {
    const dir = tmp();
    try {
      const events = [];
      const d = deps(dir, { emit: (e) => events.push(e) });
      await runTick(d);            // first tick: change (empty -> items)
      await runTick(deps(dir, { store: d.store, emit: (e) => events.push(e) })); // identical -> no change
      assert.equal(events.length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
