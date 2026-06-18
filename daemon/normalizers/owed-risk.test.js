import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeOwedRisk } from "./owed-risk.js";

const rules = {
  failureSignals: ["payment failed", "was declined", "past due"],
  grouping: { order: ["card", "vendorDomain"] },
  threshold: { atRiskMembers: 1 },
};
const account = { id: "brickell", links: { billing_portal: "https://pay.example/portal" } };

const emails = [
  { id: "e1", from: "billing@acme.com", fromName: "Acme", subject: "Payment failed — card ending in 4821", preview: "", receivedAt: "2026-06-14T00:00:00Z" },
  { id: "e2", from: "ar@globex.com", fromName: "Globex", subject: "Your card ending in 4821 was declined", preview: "", receivedAt: "2026-06-15T00:00:00Z" },
  { id: "e3", from: "ar@initech.com", fromName: "Initech", subject: "Invoice past due", preview: "" },
  { id: "e4", from: "newsletter@acme.com", fromName: "Acme", subject: "Spring sale!", preview: "deals inside" },
];

describe("normalizeOwedRisk", () => {
  it("keeps only payment-failure emails (drops the newsletter)", () => {
    const items = normalizeOwedRisk(emails, account, rules);
    const ids = items.flatMap(i => i.group.members.map(m => m.emailId));
    assert.ok(!ids.includes("e4"));
  });

  it("groups the two card-4821 failures into one item with a root cause", () => {
    const items = normalizeOwedRisk(emails, account, rules);
    const card = items.find(i => i.group.rootCause === "card_4821");
    assert.ok(card, "expected a card_4821 group");
    assert.equal(card.group.members.length, 2);
    assert.match(card.title, /2 failed payments/);
    assert.equal(card.status, "at_risk");
  });

  it("emits stable ids and the configured proposed actions + portal source", () => {
    const items = normalizeOwedRisk(emails, account, rules);
    const card = items.find(i => i.group.rootCause === "card_4821");
    assert.equal(card.id, "brickell:owed_risk:card_4821");
    assert.deepEqual(card.proposedActions, ["draft_chase", "route:billing_portal"]);
    assert.ok(card.source.some(s => s.kind === "url" && s.url === "https://pay.example/portal"));
    assert.ok(card.source.some(s => s.kind === "thread" && s.emailId === "e1"));
  });

  it("carries member receivedAt + fromName through for tile context", () => {
    const card = normalizeOwedRisk(emails, account, rules).find(i => i.group.rootCause === "card_4821");
    const m = card.group.members.find(x => x.emailId === "e1");
    assert.equal(m.receivedAt, "2026-06-14T00:00:00Z");
    assert.equal(m.fromName, "Acme");
  });

  it("returns [] when no emails match", () => {
    assert.deepEqual(normalizeOwedRisk([emails[3]], account, rules), []);
  });
});
