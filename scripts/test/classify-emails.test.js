import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCategories,
  resolveDownrank,
  matchesSender,
  matchesDownrank,
  matchesUrgencyFlags,
} from "../classify-emails.js";
import { emails } from "./fixtures/emails.js";
import {
  businessTypeConfig,
  personalTypeConfig,
  businessAccount,
  personalAccount,
} from "./fixtures/accounts.js";

describe("resolveCategories", () => {
  it("returns type categories unchanged when account has no overrides", () => {
    const cats = resolveCategories(businessTypeConfig, businessAccount);
    assert.equal(cats.length, businessTypeConfig.triageCategories.length);
    assert.equal(cats[0].id, "action");
  });

  it("appends new category from account categoryOverrides", () => {
    const cats = resolveCategories(personalTypeConfig, personalAccount);
    const iaidoCat = cats.find(c => c.id === "iaido");
    assert.ok(iaidoCat, "iaido category should be appended");
    assert.equal(iaidoCat.label, "IAIDO");
  });

  it("replaces existing category when override id matches", () => {
    const accountWithReplacement = {
      ...businessAccount,
      categoryOverrides: [{ id: "fyi", label: "INFO ONLY", description: "Replaced" }]
    };
    const cats = resolveCategories(businessTypeConfig, accountWithReplacement);
    const fyiCat = cats.find(c => c.id === "fyi");
    assert.equal(fyiCat.label, "INFO ONLY");
    assert.equal(cats.length, businessTypeConfig.triageCategories.length); // no new cat added
  });
});

describe("resolveDownrank", () => {
  it("combines type defaults with account-level downrank", () => {
    const list = resolveDownrank(businessTypeConfig, businessAccount);
    assert.ok(list.includes("bulk email")); // from type
    assert.ok(list.includes("solicitation")); // from account
  });

  it("returns type defaults when account has no downrank", () => {
    const account = { ...businessAccount, downrank: [] };
    const list = resolveDownrank(businessTypeConfig, account);
    assert.deepEqual(list, businessTypeConfig.downrankDefaults);
  });
});

describe("matchesSender", () => {
  it("matches by domain", () => {
    const senders = [{ type: "domain", value: "testbiz.com" }];
    assert.ok(matchesSender(emails.fromInternalDomain, senders));
  });

  it("matches by name (case-insensitive)", () => {
    const senders = [{ type: "name", value: "jane partner" }];
    assert.ok(matchesSender(emails.fromPrioritySenderByName, senders));
  });

  it("matches by keyword in subject or preview", () => {
    const senders = [{ type: "keyword", value: "terminated" }];
    assert.ok(matchesSender(emails.withUrgencyFlag, senders));
  });

  it("returns false when no match", () => {
    const senders = [{ type: "domain", value: "nowhere.com" }];
    assert.ok(!matchesSender(emails.fyi, senders));
  });
});

describe("matchesDownrank", () => {
  it("matches newsletter email against downrank list", () => {
    const list = ["newsletters", "marketing"];
    assert.ok(matchesDownrank(emails.newsletter, list));
  });

  it("returns false when no match", () => {
    const list = ["newsletters", "marketing"];
    assert.ok(!matchesDownrank(emails.fromInternalDomain, list));
  });
});

describe("matchesUrgencyFlags", () => {
  it("detects urgency flag in subject", () => {
    assert.ok(matchesUrgencyFlags(emails.withUrgencyFlag, ["terminated", "hold"]));
  });

  it("returns false when no flags match", () => {
    assert.ok(!matchesUrgencyFlags(emails.fyi, ["terminated", "hold"]));
  });
});
