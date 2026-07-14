import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeHandled } from "./handled.js";

const account = { id: "brickell" };
const typeConfig = { triageCategories: [
  { id: "action", actionable: true },
  { id: "fyi" },
  { id: "news" },
  { id: "ignore", hidden: true },
] };

function classifiedWith(counts) {
  const categories = {};
  for (const [id, n] of Object.entries(counts)) {
    categories[id] = { emails: Array.from({ length: n }, (_, i) => ({ id: `${id}${i}` })) };
  }
  return { categories };
}

describe("normalizeHandled", () => {
  it("leads with the actionable count and demotes the rest to a subtitle", () => {
    const items = normalizeHandled(classifiedWith({ action: 2, fyi: 3, news: 1, ignore: 5 }), account, typeConfig);
    assert.equal(items.length, 1);
    const it0 = items[0];
    assert.equal(it0.id, "brickell:handled");
    assert.equal(it0.jobType, "handled");
    assert.equal(it0.status, "ok");
    assert.equal(it0.title, "2 need a reply or decision");
    assert.equal(it0.subtitle, "+ 4 informational");
    assert.doesNotMatch(it0.title, /need you|waiting/); // no collision with the header's "N need you"
  });

  it("says nothing needs a reply when there is no actionable mail but other mail exists", () => {
    const items = normalizeHandled(classifiedWith({ fyi: 10 }), account, typeConfig);
    assert.equal(items[0].title, "Nothing needs a reply");
    assert.equal(items[0].subtitle, "+ 10 informational");
  });

  it("says inbox clear with no subtitle when nothing is actionable or waiting", () => {
    const items = normalizeHandled(classifiedWith({ ignore: 4 }), account, typeConfig);
    assert.match(items[0].title, /clear/i);
    assert.equal(items[0].subtitle, "");
    assert.equal(items[0].group.members.length, 0);
  });

  it("uses singular 'needs' for a single actionable item, and carries counts in group", () => {
    const items = normalizeHandled(classifiedWith({ action: 1, fyi: 2 }), account, typeConfig);
    assert.equal(items[0].title, "1 needs a reply or decision");
    assert.equal(items[0].group.rootCause, "handled");
    assert.deepEqual(items[0].group.counts, { needsYou: 1, waiting: 2 });
  });

  it("excludes emails older than lookbackHours from counts", () => {
    const now = Date.parse("2026-06-17T00:00:00Z");
    const classified = { categories: {
      action: { emails: [ { id: "a", received: "2026-06-16T00:00:00Z" }, { id: "b", received: "2026-05-01T00:00:00Z" } ] },
    } };
    const items = normalizeHandled(classified, { id: "brickell" }, typeConfig, { lookbackHours: 168, nowMs: now });
    assert.deepEqual(items[0].group.counts, { needsYou: 1, waiting: 0 });
  });

  it("populates members from non-ignore emails, newest-first, capped at 50", () => {
    const emails = (n, cat) => Array.from({ length: n }, (_, i) => ({ id: `${cat}${i}`, subject: `${cat}-${i}`, from: `${cat}${i}@x.com`, fromName: cat, receivedAt: `2026-06-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z` }));
    const classified = { categories: { action: { emails: emails(30, "a") }, fyi: { emails: emails(40, "f") }, ignore: { emails: emails(5, "ig") } } };
    const it0 = normalizeHandled(classified, account, typeConfig)[0];
    assert.equal(it0.group.members.length, 50);
    assert.equal(it0.group.moreCount, 20);
    assert.ok(it0.group.members[0].receivedAt >= it0.group.members[1].receivedAt);
    assert.ok(!it0.group.members.some(m => m.emailId.startsWith("ig")));
    assert.ok("subject" in it0.group.members[0] && "from" in it0.group.members[0] && "emailId" in it0.group.members[0]);
  });
  it("sets moreCount 0 and keeps members empty when nothing is non-ignore", () => {
    const it0 = normalizeHandled(classifiedWith({ ignore: 4 }), account, typeConfig)[0];
    assert.equal(it0.group.members.length, 0);
    assert.equal(it0.group.moreCount, 0);
  });

  it("counts automated/no-reply actionable mail as informational, not needs-a-reply", () => {
    const classified = { categories: { action: { emails: [
      { id: "p1", from: "wayne@brickellpay.com", subject: "decision?", receivedAt: "2026-06-20T00:00:00Z" },
      { id: "a1", from: "noreply@brickellpay.com", subject: "alert", receivedAt: "2026-06-20T00:00:00Z" },
      { id: "a2", from: "notifications@github.com", subject: "PR", receivedAt: "2026-06-20T00:00:00Z" },
    ] } } };
    const it0 = normalizeHandled(classified, account, typeConfig)[0];
    assert.equal(it0.group.counts.needsYou, 1);
    assert.equal(it0.group.counts.waiting, 2);
    assert.equal(it0.group.members.length, 3);
    assert.match(it0.title, /1 needs a reply or decision/);
  });

  it("stamps conversationId and automated on every member", () => {
    const classified = { categories: {
      action: { emails: [ { id: "h1", from: "wayne@brickellpay.com", subject: "decision?", receivedAt: "2026-06-20T00:00:00Z", conversationId: "cv-9" } ] },
      fyi:    { emails: [ { id: "n1", from: "noreply@brickellpay.com", subject: "alert", receivedAt: "2026-06-20T00:00:00Z", hasListUnsubscribe: true } ] },
    } };
    const it0 = normalizeHandled(classified, account, typeConfig)[0];
    const h = it0.group.members.find(m => m.emailId === "h1");
    const n = it0.group.members.find(m => m.emailId === "n1");
    assert.equal(h.conversationId, "cv-9");
    assert.equal(h.automated, false);
    assert.equal(n.conversationId, null);
    assert.equal(n.automated, true);
  });
});
