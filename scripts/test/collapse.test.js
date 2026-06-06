import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupForReasoning, subjectSkeleton, normalizePreview } from "../collapse.js";

const E = (over) => ({ msgid: "m" + Math.random().toString(36).slice(2), from: "a@x.com", fromName: "A", subject: "s", preview: "p", account: "acc", tag: "survivor", ...over });

describe("subjectSkeleton", () => {
  it("strips trailing ids/numbers/dates to a stable skeleton", () => {
    assert.equal(subjectSkeleton("Potential attack path #12345"), subjectSkeleton("Potential attack path #99999"));
    assert.equal(subjectSkeleton("Invoice 2026-05-01"), subjectSkeleton("Invoice 2026-06-30"));
  });
  it("keeps distinct subjects distinct", () => {
    assert.notEqual(subjectSkeleton("Quarterly review"), subjectSkeleton("Annual review"));
  });
});

describe("groupForReasoning — exact-dup", () => {
  it("groups identical (from,subject) with near-identical preview across accounts", () => {
    const items = [
      E({ msgid: "a", from: "nejm@x.com", subject: "This Week at NEJM", preview: "Lead article ...", account: "brickellpay" }),
      E({ msgid: "b", from: "nejm@x.com", subject: "This Week at NEJM", preview: "Lead article ...", account: "personal" }),
    ];
    const { groups, byMsgid } = groupForReasoning(items);
    const g = groups.find(g => g.kind === "exact-dup");
    assert.ok(g, "exact-dup group formed");
    assert.equal(g.memberMsgids.length, 2);
    assert.equal(byMsgid["a"].isRepresentative !== byMsgid["b"].isRepresentative, true, "exactly one representative");
  });
  it("does NOT merge same sender with different subjects", () => {
    const items = [
      E({ msgid: "a", from: "x@x.com", subject: "Topic one" }),
      E({ msgid: "b", from: "x@x.com", subject: "Topic two" }),
    ];
    const { groups } = groupForReasoning(items);
    assert.equal(groups.filter(g => g.memberMsgids.length > 1).length, 0);
  });
});

describe("groupForReasoning — alert-batch", () => {
  it("groups >=4 same-sender template emails", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      E({ msgid: "d" + i, from: "defender@microsoft.com", subject: `Potential attack path #${1000 + i}` }));
    const { groups } = groupForReasoning(items);
    const g = groups.find(g => g.kind === "alert-batch");
    assert.ok(g, "alert-batch formed");
    assert.equal(g.memberMsgids.length, 5);
  });
  it("does NOT group only 3 (below threshold)", () => {
    const items = Array.from({ length: 3 }, (_, i) =>
      E({ msgid: "d" + i, from: "defender@microsoft.com", subject: `Potential attack path #${1000 + i}` }));
    const { groups } = groupForReasoning(items);
    assert.equal(groups.filter(g => g.kind === "alert-batch").length, 0);
  });
  it("does NOT group same template across DIFFERENT senders", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      E({ msgid: "d" + i, from: `sender${i}@x.com`, subject: `Booth #${i} at SEAA` }));
    const { groups } = groupForReasoning(items);
    assert.equal(groups.filter(g => g.kind === "alert-batch").length, 0);
  });
  it("every input msgid appears in byMsgid with a group id (singletons too)", () => {
    const items = [E({ msgid: "solo", from: "u@x.com", subject: "Unique" })];
    const { byMsgid } = groupForReasoning(items);
    assert.ok(byMsgid["solo"]);
    assert.equal(byMsgid["solo"].isRepresentative, true, "a singleton is its own representative");
  });
  it("does NOT batch all-numeric/date-only subjects (empty skeleton)", () => {
    const items = [
      E({ msgid: "n0", from: "billing@x.com", subject: "1001" }),
      E({ msgid: "n1", from: "billing@x.com", subject: "1002" }),
      E({ msgid: "n2", from: "billing@x.com", subject: "2026-05-01" }),
      E({ msgid: "n3", from: "billing@x.com", subject: "2026-06-30" }),
    ];
    const { groups, byMsgid } = groupForReasoning(items);
    assert.equal(groups.filter(g => g.kind === "alert-batch").length, 0, "empty-skeleton subjects must not batch");
    // each is its own singleton representative
    assert.ok(["n0","n1","n2","n3"].every(id => byMsgid[id].isRepresentative === true));
  });
});
