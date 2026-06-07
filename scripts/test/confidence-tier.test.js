import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashMsgid, isAuditSampled, applyConfidenceTier } from "../confidence-tier.js";

// A 5-member alert-batch of candidates from an automated sender.
function batch({ mode = "shadow", score = 3, size = 5, kind = "alert-batch", tag = "heuristic-delete-candidate", from = "alerts@vendor.com" } = {}) {
  const memberMsgids = Array.from({ length: size }, (_, i) => "m" + i);
  const bundle = memberMsgids.map((id, i) => ({
    msgid: id, account: "biz", tag, from, subject: "Notice", preview: "p",
    bulkScore: i === 0 ? score : score, // rep is m0
    group: { id: "g0", kind, isRepresentative: i === 0, size },
  }));
  const groups = [{ id: "g0", kind, representativeMsgid: "m0", memberMsgids }];
  const accountsById = { biz: { id: "biz", candidateTier: { mode, scoreCutoff: 3, minGroupSize: 4, auditSamplePercent: 0 } } };
  return { bundle, groups, accountsById };
}

describe("hashMsgid / isAuditSampled — deterministic", () => {
  it("hash is stable and non-negative", () => {
    assert.equal(hashMsgid("abc"), hashMsgid("abc"));
    assert.ok(hashMsgid("abc") >= 0);
  });
  it("0% never samples; 100% always samples; same id same answer", () => {
    assert.equal(isAuditSampled("x", 0), false);
    assert.equal(isAuditSampled("x", 100), true);
    assert.equal(isAuditSampled("x", 50), isAuditSampled("x", 50));
  });
});

describe("applyConfidenceTier — eligibility", () => {
  it("eligible group (grouped + score>=cutoff + all candidates) is decided", () => {
    const { bundle, groups, accountsById } = batch();
    const { decisions } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(decisions["m0"].verdict, "trash");
    assert.equal(decisions["m0"].score, 3);
  });
  it("score below cutoff → not eligible", () => {
    const { bundle, groups, accountsById } = batch({ score: 2 });
    const { decisions, stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(decisions["m0"], undefined);
    assert.equal(stats.eligibleGroups, 0);
  });
  it("size below minGroupSize → not eligible", () => {
    const { bundle, groups, accountsById } = batch({ size: 3 });
    const { stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(stats.eligibleGroups, 0);
  });
  it("a single (ungrouped) representative → not eligible", () => {
    const bundle = [{ msgid: "s1", account: "biz", tag: "heuristic-delete-candidate", from: "alerts@vendor.com", bulkScore: 5, group: { id: "g0", kind: "single", isRepresentative: true, size: 1 } }];
    const groups = [{ id: "g0", kind: "single", representativeMsgid: "s1", memberMsgids: ["s1"] }];
    const accountsById = { biz: { id: "biz", candidateTier: { mode: "active", scoreCutoff: 3, minGroupSize: 4 } } };
    const { stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(stats.eligibleGroups, 0);
  });
  it("a survivor member in the group → never trashed (all-members-candidate rule)", () => {
    const { bundle, groups, accountsById } = batch({ mode: "active" });
    bundle[2].tag = "survivor"; // one member is a survivor
    const { decisions, tierRecords, stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(decisions["m0"], undefined);
    assert.equal(tierRecords.length, 0);
    assert.equal(stats.eligibleGroups, 0);
  });
  it("protected sender → excluded even if grouped+high-score", () => {
    const { bundle, groups, accountsById } = batch();
    accountsById.biz.myEmail = "me@vendor.com"; // sender alerts@vendor.com shares the domain
    const { stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(stats.eligibleGroups, 0);
  });
  it("no candidateTier config → no-op", () => {
    const { bundle, groups } = batch();
    const { decisions, stats } = applyConfidenceTier(bundle, groups, { biz: { id: "biz" } });
    assert.equal(decisions["m0"], undefined);
    assert.equal(stats.eligibleGroups, 0);
  });
});

describe("applyConfidenceTier — shadow mode", () => {
  it("stamps a decision but emits NO tierRecords (reasoner still judges)", () => {
    const { bundle, groups, accountsById } = batch({ mode: "shadow" });
    const { decisions, tierRecords, stats } = applyConfidenceTier(bundle, groups, accountsById);
    assert.equal(decisions["m0"].mode, "shadow");
    assert.equal(decisions["m0"].audited, false);
    assert.equal(tierRecords.length, 0);
    assert.equal(stats.eligibleGroups, 1);
    assert.equal(stats.trashedGroups, 0);
  });
});
