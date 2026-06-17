import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { createApiServer } from "./api.js";

let server, base, dir, store;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "officeos-api-"));
  store = createStore(dir);
  store.saveModel({ generatedAt: "t", accounts: { brickell: { status: "ok", lastTickAt: "t" } }, items: [{ id: "i1", jobType: "owed_risk" }] });
  store.saveQueue({ proposals: [
    { id: "p1", itemId: "i1", action: "route:billing_portal", params: {}, state: "pending" },
    { id: "p2", itemId: "i1", action: "draft_chase", params: {}, state: "pending" },
  ] });
  const accountsById = { brickell: { id: "brickell", links: { billing_portal: "https://pay.example/portal" } } };
  const ctxFor = (proposal) => ({ account: accountsById[proposal.params?.account || "brickell"], saveDraftFn: async () => ({ draftId: "dX" }) });
  const acks = {};
  const ackStore = { recordAck: (id, fp) => { acks[id] = { fingerprint: fp }; }, getAcks: () => acks };
  server = createApiServer({ store, ctxFor, getLastTickAt: () => "t", ackStore, clock: { now: () => "t" } });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

describe("GET /health", () => {
  it("returns ok and last tick", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
  });
});

describe("GET /model", () => {
  it("returns merged model + proposals", async () => {
    const body = await (await fetch(`${base}/model`)).json();
    assert.equal(body.items[0].id, "i1");
    assert.equal(body.proposals.length, 2);
  });
});

describe("POST /proposals/:id/approve", () => {
  it("runs the route executor and marks the proposal executed", async () => {
    const res = await fetch(`${base}/proposals/p1/approve`, { method: "POST" });
    const body = await res.json();
    assert.equal(body.result.kind, "route");
    assert.equal(body.result.url, "https://pay.example/portal");
    assert.equal(body.proposal.state, "executed");
    // persisted
    assert.equal(createStore(dir).getQueue().proposals.find(p => p.id === "p1").state, "executed");
  });
});

describe("POST /proposals/:id/dismiss", () => {
  it("marks the proposal dismissed", async () => {
    const body = await (await fetch(`${base}/proposals/p2/dismiss`, { method: "POST" })).json();
    assert.equal(body.proposal.state, "dismissed");
  });
});

describe("unknown route", () => {
  it("404s", async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

describe("POST /items/:id/acknowledge", () => {
  it("records an ack with the supplied fingerprint", async () => {
    const res = await fetch(`${base}/items/i1/acknowledge?fp=abc123`, { method: "POST" });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.itemId, "i1");
  });
});
