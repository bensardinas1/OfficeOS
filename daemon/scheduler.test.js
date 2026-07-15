import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { runTick } from "./scheduler.js";

function tmp() { return mkdtempSync(join(tmpdir(), "officeos-sched-")); }

const account = { id: "brickell", accountType: "business", links: { billing_portal: "https://pay.example/portal" } };
const typeConfigs = { business: {
  triageCategories: [{ id: "action", actionable: true }, { id: "fyi" }, { id: "ignore", hidden: true }],
  jobTypes: {
    owed_risk: { sourceCategories: ["action"], failureSignals: ["payment failed", "was declined"], grouping: { order: ["card", "vendorDomain"] }, threshold: { atRiskMembers: 1 } },
    handled: {},
  },
} };

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
    getAcks: over.getAcks || (() => ({})),
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
      assert.equal(model.accounts.brickell.label, "brickell");
      assert.equal(model.accounts.brickell.accountType, "business");
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
      assert.equal(model.accounts.brickell.accountType, "business");
      assert.equal(model.accounts.brickell.label, "brickell");
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

  it("reports newAtRisk items in the emit payload and return value", async () => {
    const dir = tmp();
    try {
      const events = [];
      const d = deps(dir, { emit: (e) => events.push(e) });
      const summary = await runTick(d);
      assert.ok(summary.notify.newAtRisk.some(i => i.group.rootCause === "card_4821"));
      assert.ok(events[0].notify.newAtRisk.length >= 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("flips an account stale and emits even when item set is unchanged", async () => {
    const dir = tmp();
    try {
      await runTick(deps(dir)); // seed ok + items
      const events = [];
      const d = deps(dir, { fetchFn: async () => { throw new Error("boom"); }, emit: (e) => events.push(e), store: createStore(dir) });
      const summary = await runTick(d);
      assert.deepEqual(summary.notify.staleFlips, ["brickell"]);
      assert.equal(events.length, 1); // emitted despite items being retained/unchanged
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("produces a handled summary item alongside owed_risk", async () => {
    const dir = tmp();
    try {
      const d = deps(dir);
      await runTick(d);
      const model = d.store.getModel();
      assert.ok(model.items.some(i => i.jobType === "handled" && i.id === "brickell:handled"));
      assert.ok(model.items.some(i => i.jobType === "owed_risk"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("stamps fingerprints and applies acks (acked item forced ok)", async () => {
    const dir = tmp();
    try {
      const d = deps(dir);
      await runTick(d);
      const model = d.store.getModel();
      const item = model.items.find(i => i.jobType === "owed_risk");
      assert.ok(item.fingerprint, "items get a fingerprint");

      const acks = { [item.id]: { fingerprint: item.fingerprint } };
      const d2 = deps(dir, { store: createStore(dir), getAcks: () => acks });
      await runTick(d2);
      const acked = d2.store.getModel().items.find(i => i.id === item.id);
      assert.equal(acked.status, "ok");
      assert.equal(acked.acknowledged, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("emits a triage Cleanup item from getPendingDeletions", async () => {
    const dir = tmp();
    try {
      const d = deps(dir, { getPendingDeletions: () => [{ id: "e1", accountId: "brickell", sender: "S", from: "s@x.com", subject: "junk", receivedAt: "2026-06-15T00:00:00Z" }] });
      await runTick(d);
      const model = d.store.getModel();
      const t = model.items.find(i => i.jobType === "triage" && i.id === "brickell:triage");
      assert.ok(t, "expected a triage item");
      assert.equal(t.group.members[0].emailId, "e1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("config findings on the model", () => {
  const findings = [{ level: "error", path: "companies[x].provider", message: "bad" }];

  it("stamps deps.getConfigFindings() onto the saved model", async () => {
    const dir = tmp();
    try {
      const d = deps(dir, { getConfigFindings: () => findings });
      await runTick(d);
      assert.deepEqual(d.store.getModel().configFindings, findings);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("defaults configFindings to [] when the dep is absent", async () => {
    const dir = tmp();
    try {
      const d = deps(dir);
      await runTick(d);
      assert.deepEqual(d.store.getModel().configFindings, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a findings change alone flips `changed` (same items)", async () => {
    const dir = tmp();
    try {
      await runTick(deps(dir)); // seed: no findings
      const again = await runTick(deps(dir)); // same emails, still no findings
      assert.equal(again.changed, false);
      const withFindings = await runTick(deps(dir, { getConfigFindings: () => findings }));
      assert.equal(withFindings.changed, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
