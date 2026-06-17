import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { regroupStragglers } from "./regroup.js";

const account = { id: "brickell", links: { billing_portal: "https://pay.example/portal" } };
const rules = { threshold: { atRiskMembers: 1 } };

const items = [
  { id: "brickell:owed_risk:card_4821", jobType: "owed_risk", account: "brickell", title: "1 failed payment", status: "at_risk",
    group: { rootCause: "card_4821", members: [{ vendor: "X", from: "x@x.com", subject: "s", emailId: "k1" }] },
    source: [], proposedActions: ["draft_chase"], lastChanged: null },
  { id: "brickell:owed_risk:ungrouped", jobType: "owed_risk", account: "brickell", title: "2 failed payments — one root cause", status: "at_risk",
    group: { rootCause: "ungrouped", members: [
      { vendor: "Acme", from: "billing@acme.com", subject: "Overdue", emailId: "e1" },
      { vendor: "Globex", from: "dun@globex.io", subject: "Final", emailId: "e2" },
    ] },
    source: [], proposedActions: ["draft_chase"], lastChanged: null },
];

describe("regroupStragglers", () => {
  it("splits the ungrouped item per the reasoner's keys, leaving grouped items intact", async () => {
    const reasoner = async () => ({ e1: "acct:acme", e2: "acct:globex" });
    const out = await regroupStragglers(items, account, rules, reasoner);
    assert.ok(out.some(i => i.id === "brickell:owed_risk:card_4821"));
    assert.ok(!out.some(i => i.group.rootCause === "ungrouped"));
    assert.ok(out.some(i => i.group.rootCause === "acct:acme"));
    assert.ok(out.some(i => i.group.rootCause === "acct:globex"));

    const acme = out.find(i => i.group.rootCause === "acct:acme");
    assert.equal(acme.id, "brickell:owed_risk:acct:acme");
    assert.equal(acme.account, "brickell");
    assert.equal(acme.status, "at_risk");                 // 1 member >= threshold 1
    assert.match(acme.title, /1 failed payment/);
    assert.deepEqual(acme.proposedActions, ["draft_chase", "route:billing_portal"]);
    assert.ok(acme.source.some(s => s.kind === "thread" && s.emailId === "e1"));
    assert.ok(acme.source.some(s => s.kind === "url" && s.url === "https://pay.example/portal"));
    assert.equal(acme.lastChanged, null);
  });

  it("returns items unchanged when there is no ungrouped item", async () => {
    const only = [items[0]];
    const out = await regroupStragglers(only, account, rules, async () => ({}));
    assert.deepEqual(out, only);
  });

  it("keeps the ungrouped item as-is when the reasoner yields <2 distinct keys (no confident split)", async () => {
    const out = await regroupStragglers(items, account, rules, async () => ({ e1: "x", e2: "x" }));
    assert.ok(out.some(i => i.group.rootCause === "ungrouped"));
  });

  it("never throws if the reasoner rejects", async () => {
    const out = await regroupStragglers(items, account, rules, async () => { throw new Error("claude down"); });
    assert.ok(out.some(i => i.group.rootCause === "ungrouped"));
  });
});
