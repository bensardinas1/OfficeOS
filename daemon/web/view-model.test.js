import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPanelView, filterItems } from "./view-model.js";

const model = {
  generatedAt: "2026-06-17T12:00:00Z",
  accounts: { brickell: { status: "ok", lastTickAt: "t" }, summit: { status: "stale", lastTickAt: "t" } },
  items: [
    { id: "brickell:owed_risk:card_4821", jobType: "owed_risk", account: "brickell", title: "2 failed payments — one root cause", status: "at_risk", group: { rootCause: "card_4821", members: [{}, {}] }, source: [], proposedActions: ["draft_chase", "route:billing_portal"], lastChanged: "t" },
    { id: "brickell:owed_risk:vendor:initech.com", jobType: "owed_risk", account: "brickell", title: "1 failed payment", status: "at_risk", group: { rootCause: "vendor:initech.com", members: [{}] }, source: [], proposedActions: ["draft_chase"], lastChanged: "t" },
  ],
  proposals: [
    { id: "brickell:owed_risk:card_4821::draft_chase", itemId: "brickell:owed_risk:card_4821", action: "draft_chase", state: "pending", preview: { summary: "2 failed payments — one root cause", drafts: [{}, {}] } },
    { id: "brickell:owed_risk:vendor:initech.com::draft_chase", itemId: "brickell:owed_risk:vendor:initech.com", action: "draft_chase", state: "executed", preview: { summary: "1 failed payment", drafts: [{}] } },
  ],
};

describe("toPanelView", () => {
  it("counts items needing attention and pending proposals", () => {
    const v = toPanelView(model);
    assert.equal(v.needsYouCount, 2);
    assert.equal(v.pendingCount, 1);
  });
  it("attaches each item's proposals by itemId", () => {
    const v = toPanelView(model);
    const item = v.groups.flatMap(g => g.items).find(i => i.id === "brickell:owed_risk:card_4821");
    assert.equal(item.proposals.length, 1);
    assert.equal(item.proposals[0].state, "pending");
  });
  it("groups items by account and surfaces stale accounts", () => {
    const v = toPanelView(model);
    const brickell = v.groups.find(g => g.account === "brickell");
    assert.equal(brickell.items.length, 2);
    assert.deepEqual(v.staleAccounts, ["summit"]);
  });
  it("tolerates an empty model", () => {
    const v = toPanelView({ generatedAt: null, accounts: {}, items: [], proposals: [] });
    assert.equal(v.needsYouCount, 0);
    assert.deepEqual(v.groups, []);
  });
});

describe("filterItems", () => {
  it("filters by account and by free-text query against title/rootCause", () => {
    const v = toPanelView(model);
    assert.equal(filterItems(v, { account: "brickell" }).length, 2);
    assert.equal(filterItems(v, { query: "initech" }).length, 1);
    assert.equal(filterItems(v, { query: "nope" }).length, 0);
  });
});
