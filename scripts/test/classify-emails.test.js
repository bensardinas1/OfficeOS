import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCategories,
  resolveDownrank,
  matchesSender,
  matchesDownrank,
  matchesUrgencyFlags,
  classifyEmail,
  applyNoiseFilter,
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

describe("classifyEmail — business account", () => {
  const categories = resolveCategories(businessTypeConfig, businessAccount);
  const downrankList = resolveDownrank(businessTypeConfig, businessAccount);

  it("classifies internal domain sender as action", () => {
    const cat = classifyEmail(emails.fromInternalDomain, businessAccount, businessTypeConfig, categories, downrankList);
    assert.equal(cat, "action");
  });

  it("classifies priority sender by name as action", () => {
    const cat = classifyEmail(emails.fromPrioritySenderByName, businessAccount, businessTypeConfig, categories, downrankList);
    assert.equal(cat, "action");
  });

  it("classifies urgency flag email as action", () => {
    const cat = classifyEmail(emails.withUrgencyFlag, businessAccount, businessTypeConfig, categories, downrankList);
    assert.equal(cat, "action");
  });

  it("classifies newsletter as ignore", () => {
    const cat = classifyEmail(emails.newsletter, businessAccount, businessTypeConfig, categories, downrankList);
    assert.equal(cat, "ignore");
  });

  it("classifies account-level downranked email as ignore", () => {
    const cat = classifyEmail(emails.downrankedByAccount, businessAccount, businessTypeConfig, categories, downrankList);
    assert.equal(cat, "ignore");
  });

  it("classifies neutral email as fyi", () => {
    const cat = classifyEmail(emails.fyi, businessAccount, businessTypeConfig, categories, downrankList);
    assert.equal(cat, "fyi");
  });
});

describe("classifyEmail — personal account", () => {
  const categories = resolveCategories(personalTypeConfig, personalAccount);
  const downrankList = resolveDownrank(personalTypeConfig, personalAccount);

  it("classifies Chase statement as bills", () => {
    const cat = classifyEmail(emails.chaseStatement, personalAccount, personalTypeConfig, categories, downrankList);
    assert.equal(cat, "bills");
  });

  it("classifies AUSKF federation email as iaido", () => {
    const cat = classifyEmail(emails.iaidoFromFederation, personalAccount, personalTypeConfig, categories, downrankList);
    assert.equal(cat, "iaido");
  });

  it("classifies AUSKF merchandise as ignore (category-level downrank)", () => {
    const cat = classifyEmail(emails.iaidoMerchandise, personalAccount, personalTypeConfig, categories, downrankList);
    assert.equal(cat, "ignore");
  });

  it("classifies deal email as ignore via type downrank", () => {
    const cat = classifyEmail(emails.uberEatsDeal, personalAccount, personalTypeConfig, categories, downrankList);
    assert.equal(cat, "ignore");
  });

  it("classifies shipping confirmation as shopping", () => {
    const cat = classifyEmail(emails.shippingConfirmation, personalAccount, personalTypeConfig, categories, downrankList);
    assert.equal(cat, "shopping");
  });
});

describe("applyNoiseFilter", () => {
  const { noiseFilters } = personalTypeConfig;

  it("returns true (should ignore) when email matches reject and not keep", () => {
    // retail promo: matches 'recommended', 'you might like' — no keep signals
    assert.ok(applyNoiseFilter(emails.retailPromo, noiseFilters));
  });

  it("returns false (keep) when email matches keep signal", () => {
    // shipping confirmation: matches 'shipped', 'delivered' — keep wins
    assert.ok(!applyNoiseFilter(emails.shippingConfirmation, noiseFilters));
  });

  it("returns false (keep) when email matches both keep and reject", () => {
    const email = {
      subject: "Your order shipped — plus recommended items",
      preview: "confirmation: shipped. Also: items you might like",
      from: "store@example.com", fromName: "Store"
    };
    assert.ok(!applyNoiseFilter(email, noiseFilters));
  });

  it("returns false when noiseFilters is null", () => {
    assert.ok(!applyNoiseFilter(emails.newsletter, null));
  });
});
