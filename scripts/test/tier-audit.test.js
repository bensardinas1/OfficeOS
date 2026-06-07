import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditTier } from "../tier-audit.js";

// bundle items carrying tier verdicts (representatives), + reasoner records.
function fixture() {
  const bundle = [
    { msgid: "a", account: "biz", from: "blast@v.com", subject: "Deal", tier: { verdict: "trash" } },
    { msgid: "b", account: "biz", from: "news@v.com", subject: "Update", tier: { verdict: "trash" } },
    { msgid: "c", account: "biz", from: "x@v.com", subject: "Plain", /* no tier */ },
  ];
  return bundle;
}

describe("auditTier — confusion matrix", () => {
  it("counts agreement (tier=trash & reasoner=trash)", () => {
    const r = auditTier(fixture(), [{ msgid: "a", verdict: "trash" }, { msgid: "b", verdict: "trash" }]);
    assert.equal(r.agree, 2);
    assert.equal(r.falseTrash, 0);
    assert.equal(r.falseTrashRate, 0);
    assert.equal(r.demoteRecommended, false);
  });

  it("flags false-trash (tier=trash & reasoner=keep) and lists it in full", () => {
    const r = auditTier(fixture(), [{ msgid: "a", verdict: "trash" }, { msgid: "b", verdict: "keep" }]);
    assert.equal(r.agree, 1);
    assert.equal(r.falseTrash, 1);
    assert.equal(r.falseTrashRate, 50);
    assert.equal(r.falseTrashList.length, 1);
    assert.deepEqual(r.falseTrashList[0], { msgid: "b", account: "biz", sender: "news@v.com", subject: "Update" });
    assert.equal(r.demoteRecommended, true); // default threshold 0
  });

  it("ignores tier items the reasoner never judged (active non-audited)", () => {
    const r = auditTier(fixture(), [{ msgid: "a", verdict: "trash" }]); // b not judged
    assert.equal(r.agree, 1);
    assert.equal(r.falseTrash, 0);
  });

  it("ignores items without a tier verdict", () => {
    const r = auditTier(fixture(), [{ msgid: "c", verdict: "keep" }]);
    assert.equal(r.agree, 0);
    assert.equal(r.falseTrash, 0);
  });

  it("per-account isolation + threshold tolerance", () => {
    const bundle = [
      { msgid: "a", account: "biz", from: "x@v.com", subject: "s", tier: { verdict: "trash" } },
      { msgid: "p", account: "personal", from: "y@w.com", subject: "t", tier: { verdict: "trash" } },
    ];
    const r = auditTier(bundle, [{ msgid: "a", verdict: "keep" }, { msgid: "p", verdict: "trash" }], { demoteThresholdPercent: 60 });
    assert.equal(r.perAccount.biz.falseTrash, 1);
    assert.equal(r.perAccount.biz.falseTrashRate, 100);
    assert.equal(r.perAccount.biz.demoteRecommended, true);
    assert.equal(r.perAccount.personal.falseTrash, 0);
    assert.equal(r.perAccount.personal.demoteRecommended, false);
  });
});
