import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { createApiServer } from "./api.js";

let server, base, dir, store, acks;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "officeos-api-"));
  store = createStore(dir);
  store.saveModel({ generatedAt: "t", accounts: { brickell: { status: "ok", lastTickAt: "t" } }, items: [{ id: "i1", jobType: "owed_risk" }] });
  store.saveQueue({ proposals: [
    { id: "p1", itemId: "i1", action: "route:billing_portal", params: {}, state: "pending" },
    { id: "p2", itemId: "i1", action: "draft_chase", params: {}, state: "pending" },
    { id: "p3", itemId: "i1", action: "draft_chase", params: {}, state: "pending" },
  ] });
  const accountsById = { brickell: { id: "brickell", links: { billing_portal: "https://pay.example/portal" } } };
  const ctxFor = (proposal) => ({ account: accountsById[proposal.params?.account || "brickell"], saveDraftFn: async () => ({ draftId: "dX" }) });
  acks = {};
  const ackStore = { recordAck: (id, fp) => { acks[id] = { fingerprint: fp }; }, removeAck: (id) => { delete acks[id]; }, getAcks: () => acks };
  const fetchBodyFn = async (account, emailId) => {
    if (emailId === "boom") throw new Error("nope");
    return { id: emailId, body: `body of ${emailId} for ${account}` };
  };
  const deleted = [];
  const deleteFn = async (account, ids) => { deleted.push({ account, ids }); return { trashed: ids.length, failed: 0 }; };
  const killed = [];
  const killlistFn = async (account, sender) => { killed.push({ account, sender }); return sender.includes("vip") ? { added: false, reason: "protected sender" } : { added: true, value: sender }; };
  server = createApiServer({ store, ctxFor, getLastTickAt: () => "t", ackStore, clock: { now: () => "t" },
    accounts: [{ id: "brickell" }], fetchBodyFn, deleteFn, killlistFn });
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
    assert.equal(body.proposals.length, 3);
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

describe("GET /messages/:id/body", () => {
  it("returns the body for a known account", async () => {
    const res = await fetch(`${base}/messages/m1/body?account=brickell`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.body, "body of m1 for brickell");
  });
  it("400s on unknown/missing account", async () => {
    assert.equal((await fetch(`${base}/messages/m1/body`)).status, 400);
    assert.equal((await fetch(`${base}/messages/m1/body?account=ghost`)).status, 400);
  });
  it("surfaces a connector error as ok:false (not a crash)", async () => {
    const body = await (await fetch(`${base}/messages/boom/body?account=brickell`)).json();
    assert.equal(body.ok, false);
    assert.match(body.error, /nope/);
  });
});

describe("POST /proposals/:id/reopen", () => {
  it("turns a dismissed proposal back to pending", async () => {
    await fetch(`${base}/proposals/p3/dismiss`, { method: "POST" });
    const body = await (await fetch(`${base}/proposals/p3/reopen`, { method: "POST" })).json();
    assert.equal(body.proposal.state, "pending");
    assert.equal(createStore(dir).getQueue().proposals.find(p => p.id === "p3").state, "pending");
  });
  it("404s reopening an unknown proposal", async () => {
    assert.equal((await fetch(`${base}/proposals/ghost/reopen`, { method: "POST" })).status, 404);
  });
});

describe("POST /items/:id/unacknowledge", () => {
  it("removes a recorded ack", async () => {
    await fetch(`${base}/items/i9/acknowledge?fp=z`, { method: "POST" });
    assert.ok(acks.i9);
    const body = await (await fetch(`${base}/items/i9/unacknowledge`, { method: "POST" })).json();
    assert.equal(body.ok, true);
    assert.ok(!acks.i9);
  });
});

describe("POST /messages/delete", () => {
  it("soft-deletes the given ids for a known account", async () => {
    const res = await fetch(`${base}/messages/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", emailIds: ["a", "b"] }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.trashed, 2);
  });
  it("400s on unknown account or missing ids", async () => {
    assert.equal((await fetch(`${base}/messages/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "ghost", emailIds: ["a"] }) })).status, 400);
    assert.equal((await fetch(`${base}/messages/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", emailIds: [] }) })).status, 400);
  });
});

describe("POST /senders/killlist", () => {
  it("adds a sender and reports added", async () => {
    const body = await (await fetch(`${base}/senders/killlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", sender: "promo@x.com" }) })).json();
    assert.equal(body.added, true);
  });
  it("surfaces a guard refusal as added:false with a reason", async () => {
    const body = await (await fetch(`${base}/senders/killlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", sender: "ceo@vip.com" }) })).json();
    assert.equal(body.added, false);
    assert.match(body.reason, /protected/);
  });
  it("400s on unknown account or missing sender", async () => {
    assert.equal((await fetch(`${base}/senders/killlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "ghost", sender: "x@y.com" }) })).status, 400);
    assert.equal((await fetch(`${base}/senders/killlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell" }) })).status, 400);
  });
});
