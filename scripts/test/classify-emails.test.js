import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCategories,
  resolveDownrank,
} from "../classify-emails.js";
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
