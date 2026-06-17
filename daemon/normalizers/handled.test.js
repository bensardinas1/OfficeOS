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
  it("emits one summary item per account with needs-you and waiting counts", () => {
    const items = normalizeHandled(classifiedWith({ action: 2, fyi: 3, news: 1, ignore: 5 }), account, typeConfig);
    assert.equal(items.length, 1);
    const it0 = items[0];
    assert.equal(it0.id, "brickell:handled");
    assert.equal(it0.jobType, "handled");
    assert.equal(it0.status, "ok");
    assert.match(it0.title, /2 need you/);
    assert.match(it0.title, /4 waiting/);
  });

  it("says inbox clear when nothing is actionable or waiting", () => {
    const items = normalizeHandled(classifiedWith({ ignore: 4 }), account, typeConfig);
    assert.match(items[0].title, /clear/i);
    assert.equal(items[0].group.members.length, 0);
  });

  it("carries the counts in group for the UI", () => {
    const items = normalizeHandled(classifiedWith({ action: 1, fyi: 2 }), account, typeConfig);
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
});
