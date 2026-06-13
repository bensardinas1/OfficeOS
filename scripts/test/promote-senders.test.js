import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectAutoPromotions, applyPromotions } from "../promote-senders.js";

const accounts = [
  { id: "biz", myEmail: "me@biz.com", neverDelete: [{ type: "domain", value: "partner.com" }], alwaysDelete: [{ type: "email", value: "old@spam.com" }] },
  { id: "personal", myEmail: "me@gmail.com", neverDelete: [] },
];
const H = (over) => ({ deletedCount: 6, hasListUnsubscribe: true, lastDeletedAt: "2026-06-13", ...over });

describe("selectAutoPromotions — gates", () => {
  it("promotes a bulk sender past threshold to an email-exact rule", () => {
    const out = selectAutoPromotions({ "biz:blast@vendor.com": H() }, accounts, { threshold: 5 });
    assert.deepEqual(out.biz.map(r => ({ type: r.type, value: r.value })), [{ type: "email", value: "blast@vendor.com" }]);
  });
  it("skips senders below threshold", () => {
    const out = selectAutoPromotions({ "biz:blast@vendor.com": H({ deletedCount: 4 }) }, accounts, { threshold: 5 });
    assert.equal((out.biz || []).length, 0);
  });
  it("requires list-unsubscribe by default (an individual who got deleted is not auto-killed)", () => {
    const out = selectAutoPromotions({ "biz:jane@vendor.com": H({ hasListUnsubscribe: false }) }, accounts, { threshold: 5 });
    assert.equal((out.biz || []).length, 0);
  });
  it("allows requireListUnsub:false for the agent-reviewed backfill", () => {
    const out = selectAutoPromotions({ "biz:jane@vendor.com": H({ hasListUnsubscribe: false }) }, accounts, { threshold: 3, requireListUnsub: false });
    assert.equal(out.biz.length, 1);
  });
  it("skips protected senders (neverDelete domain)", () => {
    const out = selectAutoPromotions({ "biz:ceo@partner.com": H() }, accounts, { threshold: 5 });
    assert.equal((out.biz || []).length, 0);
  });
  it("skips senders already on the kill-list", () => {
    const out = selectAutoPromotions({ "biz:old@spam.com": H() }, accounts, { threshold: 5 });
    assert.equal((out.biz || []).length, 0);
  });
  it("skips correspondents (someone the user has emailed)", () => {
    const out = selectAutoPromotions({ "biz:known@vendor.com": H() }, accounts,
      { threshold: 5, correspondentsByAccount: { biz: new Set(["known@vendor.com"]) } });
    assert.equal((out.biz || []).length, 0);
  });
  it("skips dual-use / transactional senders matching the risky pattern", () => {
    const out = selectAutoPromotions({ "personal:noreply@uber.com": H() }, accounts,
      { threshold: 5, riskyPattern: /uber\.com|paypal|ebay/i });
    assert.equal((out.personal || []).length, 0);
  });
  it("isolates by account", () => {
    const out = selectAutoPromotions({ "biz:a@v.com": H(), "personal:b@v.com": H() }, accounts, { threshold: 5 });
    assert.deepEqual(out.biz.map(r => r.value), ["a@v.com"]);
    assert.deepEqual(out.personal.map(r => r.value), ["b@v.com"]);
  });
});

describe("applyPromotions — config mutation", () => {
  it("adds new rules, dedupes against existing, reports what changed", () => {
    const cfg = { companies: [{ id: "biz", alwaysDelete: [{ type: "email", value: "old@spam.com" }] }] };
    const added = applyPromotions(cfg, { biz: [
      { type: "email", value: "old@spam.com", label: "dup" },   // already present → skip
      { type: "email", value: "NEW@spam.com", label: "x" },     // case-insensitive new
    ] });
    assert.equal(cfg.companies[0].alwaysDelete.length, 2);
    assert.deepEqual(added, [{ account: "biz", value: "new@spam.com" }]);
  });
  it("creates the alwaysDelete array when absent", () => {
    const cfg = { companies: [{ id: "biz" }] };
    applyPromotions(cfg, { biz: [{ type: "email", value: "a@b.com", label: "x" }] });
    assert.equal(cfg.companies[0].alwaysDelete.length, 1);
  });
});
