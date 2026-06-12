import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAddressList, mergeCorrespondents, loadCorrespondentsFile, correspondentSet,
} from "../correspondents.js";
import { classify } from "../classify-emails.js";

describe("parseAddressList — extracts addresses from header strings", () => {
  it("handles display names, brackets, and separators", () => {
    assert.deepEqual(
      parseAddressList('George Gabela <george@partner.com>, "Doe, Jane" <jane@x.com>; bare@y.com'),
      ["george@partner.com", "jane@x.com", "bare@y.com"],
    );
  });
  it("lowercases and ignores empty/invalid segments", () => {
    assert.deepEqual(parseAddressList("FOO@Bar.COM, , not-an-address"), ["foo@bar.com"]);
  });
});

describe("mergeCorrespondents + correspondentSet", () => {
  it("normalizes, dedupes, sorts, and isolates accounts", () => {
    const map = {};
    mergeCorrespondents(map, "biz", ["B@x.com", "a@y.com", "b@X.com"]);
    mergeCorrespondents(map, "personal", ["friend@gmail.com"]);
    assert.deepEqual(map.biz, ["a@y.com", "b@x.com"]);
    assert.ok(correspondentSet(map, "biz").has("b@x.com"));
    assert.equal(correspondentSet(map, "biz").has("friend@gmail.com"), false);
    assert.ok(correspondentSet(map, "personal").has("friend@gmail.com"));
  });
});

describe("loadCorrespondentsFile — resilient file load", () => {
  it("returns {} for missing or corrupt files", () => {
    const dir = mkdtempSync(join(tmpdir(), "corr-"));
    assert.deepEqual(loadCorrespondentsFile(join(dir, "nope.json")), {});
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    assert.deepEqual(loadCorrespondentsFile(bad), {});
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("classify — sent-to correspondents are protected from heuristic deletion", () => {
  const config = {
    companies: { companies: [{ id: "biz", name: "Biz", accountType: "business", alwaysDelete: [{ type: "email", value: "blast@killed.com" }] }] },
    accountTypes: {
      business: {
        triageCategories: [
          { id: "action", label: "ACTION" }, { id: "fyi", label: "FYI" },
          { id: "news", label: "NEWS" }, { id: "ignore", label: "IGNORE", hidden: true },
        ],
        downrankDefaults: ["webinar", "newsletters"],
        deletionPolicy: { categories: ["ignore"], patterns: ["limited time offer"] },
      },
    },
  };
  const promo = (from) => ({
    id: "e1", from, fromName: "Vendor", subject: "Limited time offer just for you",
    preview: "buy now", receivedAt: "2026-06-10T10:00:00Z", hasListUnsubscribe: true,
  });

  it("flags a promo from a stranger as a heuristic deletion", () => {
    const r = classify([promo("stranger@vendor.com")], "biz", { config, correspondents: new Set() });
    assert.equal(r.heuristicDeletions.length, 1);
  });

  it("protects the same promo when the user has emailed the sender", () => {
    const r = classify([promo("known@vendor.com")], "biz", { config, correspondents: new Set(["known@vendor.com"]) });
    assert.equal(r.heuristicDeletions.length, 0);
    assert.equal(r.explicitDeletions.length, 0);
  });

  it("explicit alwaysDelete still wins over correspondence (deliberate config beats inference)", () => {
    const r = classify([promo("blast@killed.com")], "biz", { config, correspondents: new Set(["blast@killed.com"]) });
    assert.equal(r.explicitDeletions.length, 1);
  });

  it("scam patterns do NOT fire on a correspondent (attorney forwarding a filing notice)", () => {
    const scamConfig = JSON.parse(JSON.stringify(config));
    scamConfig.companies.companies[0].scamPatterns = [
      { subjectAll: ["annual report", "filing"], senderAllowlist: ["sunbiz.dos.fl.gov"] },
    ];
    const fwd = {
      id: "e2", from: "kevin@lawfirm.com", fromName: "Kevin Deeb",
      subject: "Fw: Official 2025 Annual Report Filing Notice for L23000255604",
      preview: "see attached", receivedAt: "2026-06-10T10:00:00Z", hasListUnsubscribe: false,
    };
    const asStranger = classify([fwd], "biz", { config: scamConfig, correspondents: new Set() });
    assert.equal(asStranger.explicitDeletions.length, 1, "stranger with scam-shaped subject is force-deleted");
    const asContact = classify([fwd], "biz", { config: scamConfig, correspondents: new Set(["kevin@lawfirm.com"]) });
    assert.equal(asContact.explicitDeletions.length, 0, "correspondent forwarding the same subject is protected");
  });
});
