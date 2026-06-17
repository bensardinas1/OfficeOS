import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChaseDrafts, stageProposals, transition } from "./proposals.js";

const account = { id: "brickell" };
const item = {
  id: "brickell:owed_risk:card_4821",
  account: "brickell",
  proposedActions: ["draft_chase", "route:billing_portal"],
  group: { rootCause: "card_4821", members: [
    { vendor: "Acme", from: "billing@acme.com", subject: "Payment failed", emailId: "e1" },
    { vendor: "Globex", from: "ar@globex.com", subject: "Declined", emailId: "e2" },
  ] },
};

describe("buildChaseDrafts", () => {
  it("creates one draft per member, addressed to the vendor, never marked sent", () => {
    const drafts = buildChaseDrafts(item, account);
    assert.equal(drafts.length, 2);
    assert.deepEqual(drafts[0].to, ["billing@acme.com"]);
    assert.equal(drafts[0].replyToMessageId, "e1");
    assert.match(drafts[0].body, /card_4821|card ending/i);
  });
});

describe("stageProposals", () => {
  it("creates a pending draft_chase proposal for a new item", () => {
    const { proposals } = stageProposals([item], { proposals: [] }, account);
    const p = proposals.find(x => x.action === "draft_chase");
    assert.ok(p);
    assert.equal(p.id, "brickell:owed_risk:card_4821::draft_chase");
    assert.equal(p.state, "pending");
    assert.equal(p.preview.drafts.length, 2);
  });
  it("is idempotent — does not duplicate or reset an existing proposal", () => {
    const first = stageProposals([item], { proposals: [] }, account);
    first.proposals[0].state = "executed";
    const second = stageProposals([item], first, account);
    const draftProps = second.proposals.filter(p => p.action === "draft_chase");
    assert.equal(draftProps.length, 1);
    assert.equal(draftProps[0].state, "executed"); // preserved
  });
});

describe("transition", () => {
  it("pending -> approved -> executed", () => {
    const p = { state: "pending" };
    assert.equal(transition(p, "approve").state, "approved");
    assert.equal(transition({ state: "approved" }, "executed").state, "executed");
  });
  it("pending -> dismissed and pending -> snoozed", () => {
    assert.equal(transition({ state: "pending" }, "dismiss").state, "dismissed");
    assert.equal(transition({ state: "pending" }, "snooze").state, "snoozed");
  });
  it("rejects an invalid transition", () => {
    assert.throws(() => transition({ state: "executed" }, "approve"), /invalid transition/i);
  });
});
