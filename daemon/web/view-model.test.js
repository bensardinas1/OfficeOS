import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPanelView, filterItems, filterGroups, findItem, groupHandledMembers, stripReplyPrefix } from "./view-model.js";

const model = {
  generatedAt: "2026-06-17T12:00:00Z",
  accounts: {
    brickell: { status: "ok", lastTickAt: "t", label: "Brickell Pay", accountType: "business" },
    summit: { status: "ok", lastTickAt: "t", label: "Summit Miami", accountType: "business" },
  },
  items: [
    { id: "brickell:owed_risk:card_4821", jobType: "owed_risk", account: "brickell", title: "2 failed payments — one root cause", status: "at_risk",
      group: { rootCause: "card_4821", members: [
        { vendor: "Acme", from: "billing@acme.com", fromName: "Acme", subject: "s1", emailId: "e1", receivedAt: "2026-06-14T00:00:00Z" },
        { vendor: "Acme", from: "billing@acme.com", fromName: "Acme", subject: "s2", emailId: "e2", receivedAt: "2026-06-16T00:00:00Z" },
      ] }, source: [], proposedActions: ["draft_chase", "route:billing_portal"], lastChanged: "t" },
    { id: "brickell:owed_risk:vendor:initech.com", jobType: "owed_risk", account: "brickell", title: "1 failed payment", status: "at_risk",
      group: { rootCause: "vendor:initech.com", members: [{ vendor: "Initech", from: "ar@initech.com", fromName: "Initech", subject: "s3", emailId: "e3", receivedAt: "2026-06-10T00:00:00Z" }] },
      source: [], proposedActions: ["draft_chase"], lastChanged: "t" },
    { id: "summit:handled", jobType: "handled", account: "summit", title: "Summit — all handled", status: "ok",
      group: { rootCause: "summary", members: [{ subject: "x", emailId: "z", receivedAt: "2026-06-12T00:00:00Z", from: "a@b.com", fromName: "Bee" }] }, source: [], proposedActions: [], lastChanged: "t" },
  ],
  proposals: [
    { id: "brickell:owed_risk:card_4821::draft_chase", itemId: "brickell:owed_risk:card_4821", action: "draft_chase", state: "pending", preview: { summary: "x", drafts: [{}, {}] } },
    { id: "brickell:owed_risk:vendor:initech.com::draft_chase", itemId: "brickell:owed_risk:vendor:initech.com", action: "draft_chase", state: "executed", preview: { summary: "y", drafts: [{}] } },
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
    assert.deepEqual(v.staleAccounts, []);
  });
  it("lists an account in staleAccounts when its status is stale", () => {
    const v = toPanelView({ ...model, accounts: { ...model.accounts, summit: { status: "stale" } } });
    assert.deepEqual(v.staleAccounts, ["summit"]);
  });
  it("tolerates an empty model", () => {
    const v = toPanelView({ generatedAt: null, accounts: {}, items: [], proposals: [] });
    assert.equal(v.needsYouCount, 0);
    assert.deepEqual(v.groups, []);
  });
  it("passes configFindings through, defaulting to []", () => {
    assert.deepEqual(toPanelView({ items: [], accounts: {} }).configFindings, []);
    const f = [{ level: "error", path: "p", message: "m" }];
    assert.deepEqual(toPanelView({ items: [], accounts: {}, configFindings: f }).configFindings, f);
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

describe("toPanelView display + grouping", () => {
  it("derives display: sender, latest date, count per item", () => {
    const v = toPanelView(model);
    const card = v.groups.flatMap(g => g.items).find(i => i.id === "brickell:owed_risk:card_4821");
    assert.equal(card.display.messageCount, 2);
    assert.equal(card.display.latestDate, "2026-06-16T00:00:00Z");
    assert.equal(card.display.primarySender, "Acme");
    assert.equal(card.display.accountLabel, "Brickell Pay");
    assert.equal(card.display.accountType, "business");
  });

  it("surfaces label/type/atRiskCount per group and orders most-at-risk first", () => {
    const v = toPanelView(model);
    assert.equal(v.groups[0].account, "brickell");
    assert.equal(v.groups[0].label, "Brickell Pay");
    assert.equal(v.groups[0].accountType, "business");
    assert.equal(v.groups[0].atRiskCount, 2);
    assert.equal(v.groups[1].account, "summit");
    assert.equal(v.groups[1].atRiskCount, 0);
  });

  it("falls back to account id when no label is present", () => {
    const v = toPanelView({ ...model, accounts: { brickell: { status: "ok" }, summit: { status: "ok" } } });
    assert.equal(v.groups.find(g => g.account === "brickell").label, "brickell");
  });

  it("prefers vendor over fromName for owed_risk primarySender", () => {
    const m = {
      generatedAt: "t", accounts: { brickell: { status: "ok" } },
      items: [{ id: "x", jobType: "owed_risk", account: "brickell", title: "t", status: "at_risk",
        group: { rootCause: "r", members: [{ vendor: "Acme Corp", fromName: "billing-bot", from: "b@acme.com", subject: "s", emailId: "e", receivedAt: "2026-06-14T00:00:00Z" }] } }],
      proposals: [],
    };
    assert.equal(toPanelView(m).groups[0].items[0].display.primarySender, "Acme Corp");
  });
});

describe("findItem", () => {
  it("finds an item across groups by id, with display attached", () => {
    const v = toPanelView(model);
    const hit = findItem(v, "brickell:owed_risk:card_4821");
    assert.ok(hit);
    assert.equal(hit.display.accountLabel, "Brickell Pay");
    assert.equal(findItem(v, "nope"), null);
  });
});

describe("filterGroups", () => {
  it("filters items within each group and drops emptied groups", () => {
    const v = toPanelView(model);
    const g = filterGroups(v, { query: "initech" });
    assert.equal(g.length, 1);
    assert.equal(g[0].account, "brickell");
    assert.equal(g[0].items.length, 1);
    assert.equal(filterGroups(v, { query: "nope" }).length, 0);
  });
  it("filters by account axis and drops other groups", () => {
    const v = toPanelView(model);
    const g = filterGroups(v, { account: "summit" });
    assert.equal(g.length, 1);
    assert.equal(g[0].account, "summit");
  });
});

describe("stripReplyPrefix", () => {
  it("strips stacked Re:/Fwd:/Fw: prefixes, case-insensitive", () => {
    assert.equal(stripReplyPrefix("RE: Fwd: re: Path Peptides underwriting"), "Path Peptides underwriting");
    assert.equal(stripReplyPrefix("Regular subject"), "Regular subject");
    assert.equal(stripReplyPrefix(""), "");
  });
});

describe("groupHandledMembers", () => {
  const m = (id, from, conv, automated, at, subject) =>
    ({ emailId: id, from, fromName: from, conversationId: conv, automated, receivedAt: at, subject });

  it("routes human mail to conversations grouped by conversationId, automated to sender groups", () => {
    const members = [
      m("e1", "luis@brickellpay.com", "cv-1", false, "2026-07-01T00:00:00Z", "Path Peptides underwriting"),
      m("e2", "mckenna@partner.com", "cv-1", false, "2026-07-02T00:00:00Z", "RE: Path Peptides underwriting"),
      m("e3", "noise@wp.com", null, true, "2026-07-03T00:00:00Z", "New order #1"),
      m("e4", "noise@wp.com", null, true, "2026-07-04T00:00:00Z", "New order #2"),
    ];
    const g = groupHandledMembers(members);
    assert.equal(g.conversations.length, 1);
    assert.equal(g.conversations[0].key, "cv-1");
    assert.equal(g.conversations[0].label, "Path Peptides underwriting"); // latest subject, prefix stripped
    assert.equal(g.conversations[0].senderCount, 2);
    assert.deepEqual(g.conversations[0].members.map(x => x.emailId), ["e1", "e2"]); // oldest-first
    assert.equal(g.senders.length, 1);
    assert.equal(g.senders[0].members.length, 2);
  });

  it("orders conversations newest-activity-first and falls back to singleton groups", () => {
    const members = [
      m("a1", "x@y.com", null, false, "2026-07-01T00:00:00Z", "Solo one"),   // no convId → singleton
      m("b1", "z@y.com", "cv-2", false, "2026-07-05T00:00:00Z", "Newer thread"),
    ];
    const g = groupHandledMembers(members);
    assert.deepEqual(g.conversations.map(c => c.key), ["cv-2", "msg:a1"]);
  });

  it("members missing the automated field fall back to sender groups (stale model)", () => {
    const legacy = { emailId: "l1", from: "who@y.com", subject: "old", receivedAt: "2026-07-01T00:00:00Z" };
    const g = groupHandledMembers([legacy]);
    assert.equal(g.conversations.length, 0);
    assert.equal(g.senders.length, 1);
  });

  it("handles empty/missing input", () => {
    assert.deepEqual(groupHandledMembers([]), { conversations: [], senders: [] });
    assert.deepEqual(groupHandledMembers(undefined), { conversations: [], senders: [] });
  });
});
