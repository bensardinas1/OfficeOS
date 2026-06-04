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
  detectBulkSignals,
  senderRuleApplies,
  matchesScamPattern,
  matchesDeletionPattern,
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

describe("detectBulkSignals", () => {
  const userEmail = "user@testbiz.com";

  it("returns score 0 for non-bulk email", () => {
    const result = detectBulkSignals(emails.fromInternalDomain, userEmail);
    assert.equal(result.score, 0);
    assert.deepEqual(result.signals, []);
  });

  it("detects List-Unsubscribe header", () => {
    const result = detectBulkSignals(emails.bulkWithUnsubscribe, userEmail);
    assert.ok(result.signals.includes("list-unsubscribe"));
    assert.ok(result.score >= 1);
  });

  it("detects Precedence: bulk", () => {
    const result = detectBulkSignals(emails.bulkWithPrecedence, userEmail);
    assert.ok(result.signals.includes("precedence"));
    assert.ok(result.score >= 1);
  });

  it("detects Gmail CATEGORY_PROMOTIONS", () => {
    const result = detectBulkSignals(emails.bulkGmailPromo, userEmail);
    assert.ok(result.signals.includes("gmail-category"));
    assert.ok(result.score >= 1);
  });

  it("detects BCC (user email not in To or CC)", () => {
    const result = detectBulkSignals(emails.bulkBccDetected, userEmail);
    assert.ok(result.signals.includes("bcc"));
    assert.ok(result.score >= 1);
  });

  it("detects marketing subdomain (mail.)", () => {
    const result = detectBulkSignals(emails.bulkMarketingSubdomain, userEmail);
    assert.ok(result.signals.includes("marketing-subdomain"));
    assert.ok(result.score >= 1);
  });

  it("scores multiple signals additively", () => {
    const result = detectBulkSignals(emails.bulkTwoSignals, userEmail);
    assert.equal(result.score, 2);
    assert.ok(result.signals.includes("list-unsubscribe"));
    assert.ok(result.signals.includes("bcc"));
  });

  it("scores three signals", () => {
    const result = detectBulkSignals(emails.bulkThreeSignals, userEmail);
    assert.equal(result.score, 3);
  });

  it("does not flag direct email to user as BCC", () => {
    const directEmail = { ...emails.fyi, toRecipients: "user@testbiz.com", ccRecipients: "" };
    const result = detectBulkSignals(directEmail, userEmail);
    assert.ok(!result.signals.includes("bcc"));
  });
});

// Helper: run the classify() pipeline using fixture data (avoids reading live config files)
function classifyWithFixtures(emailBatch, account, typeConfig) {
  const categories = resolveCategories(typeConfig, account);
  const downrankList = resolveDownrank(typeConfig, account);
  const result = {
    accountId: account.id,
    accountName: account.name,
    accountType: account.accountType,
    categories: {},
    deletionCandidates: [],
  };
  for (const cat of categories) {
    result.categories[cat.id] = { label: cat.label, hidden: cat.hidden || false, emails: [] };
  }
  for (const email of emailBatch) {
    const categoryId = classifyEmail(email, account, typeConfig, categories, downrankList);
    if (!result.categories[categoryId]) {
      result.categories[categoryId] = { label: categoryId, hidden: false, emails: [] };
    }
    result.categories[categoryId].emails.push(email);
    if (categoryId === "ignore") result.deletionCandidates.push(email);
  }
  return result;
}

describe("classifyEmail — bulk signal integration", () => {
  const categories = resolveCategories(businessTypeConfig, businessAccount);
  const downrankList = resolveDownrank(businessTypeConfig, businessAccount);

  it("classifies 2-signal bulk email as ignore at threshold 2", () => {
    const cat = classifyEmail(emails.bulkTwoSignals, businessAccount, businessTypeConfig, categories, downrankList);
    assert.equal(cat, "ignore");
  });

  it("classifies 1-signal bulk email as fyi at threshold 2 (below threshold)", () => {
    const cat = classifyEmail(emails.bulkWithUnsubscribe, businessAccount, businessTypeConfig, categories, downrankList);
    assert.equal(cat, "fyi");
  });

  it("classifies 3-signal bulk email as ignore at threshold 2", () => {
    const cat = classifyEmail(emails.bulkThreeSignals, businessAccount, businessTypeConfig, categories, downrankList);
    assert.equal(cat, "ignore");
  });

  it("does NOT reclassify protected sender even with bulk signals", () => {
    const cat = classifyEmail(emails.bulkFromProtectedSender, businessAccount, businessTypeConfig, categories, downrankList);
    assert.equal(cat, "action"); // testbiz.com is a prioritySender domain
  });

  it("classifies 1-signal bulk email as ignore at threshold 1", () => {
    const aggressiveTypeConfig = { ...businessTypeConfig, bulkSignalThreshold: 1 };
    const cat = classifyEmail(emails.bulkWithUnsubscribe, businessAccount, aggressiveTypeConfig, categories, downrankList);
    assert.equal(cat, "ignore");
  });

  it("respects account-level threshold override", () => {
    const accountWithOverride = { ...businessAccount, bulkSignalThreshold: 1 };
    const cat = classifyEmail(emails.bulkWithUnsubscribe, accountWithOverride, businessTypeConfig, categories, downrankList);
    assert.equal(cat, "ignore");
  });
});

describe("classify() — integration", () => {
  it("returns structured result with categories and deletionCandidates", () => {
    const emailBatch = [emails.fromInternalDomain, emails.newsletter, emails.withUrgencyFlag];
    const result = classifyWithFixtures(emailBatch, businessAccount, businessTypeConfig);

    assert.ok(result.accountId === "testbiz");
    assert.ok(result.accountName);
    assert.ok(typeof result.categories === "object");
    assert.ok(Array.isArray(result.deletionCandidates));
  });

  it("puts downranked emails in deletionCandidates", () => {
    const result = classifyWithFixtures([emails.newsletter], businessAccount, businessTypeConfig);
    assert.equal(result.deletionCandidates.length, 1);
    assert.equal(result.deletionCandidates[0].id, "e4");
  });

  it("puts priority sender in action category for business account", () => {
    const result = classifyWithFixtures([emails.fromInternalDomain], businessAccount, businessTypeConfig);
    assert.ok(result.categories.action.emails.length > 0);
  });
});

// Helper that bypasses loadConfig() by injecting account + type directly.
// Used by tests that want to test classify() behavior without filesystem config.
function classifyWithAccount(emails, account, typeConfig) {
  // Reproduce the inner logic of classify() that runs after loadConfig.
  const categories = resolveCategories(typeConfig, account);
  const downrankList = resolveDownrank(typeConfig, account);
  const policy = typeConfig.deletionPolicy || { categories: ["ignore"], patterns: [] };
  const neverDeleteList = [...(policy.neverDelete || []), ...(account.neverDelete || [])];
  const alwaysDeleteList = [...(policy.alwaysDelete || []), ...(account.alwaysDelete || [])];
  const scamPatterns = account.scamPatterns || [];
  const deletionCategoryIds = new Set(policy.categories);

  const result = { categories: {}, deletionCandidates: [], explicitDeletions: [], heuristicDeletions: [] };
  for (const cat of categories) result.categories[cat.id] = { label: cat.label, emails: [] };

  for (const email of emails) {
    let categoryId = classifyEmail(email, account, typeConfig, categories, downrankList);
    const alwaysDeleteApplies = alwaysDeleteList.some(r => senderRuleApplies(email, r));
    const scamApplies = scamPatterns.some(p => matchesScamPattern(email, p));
    const isProtected = matchesSender(email, neverDeleteList);
    const forceDelete = (alwaysDeleteApplies || scamApplies) && !isProtected;
    if (forceDelete) categoryId = "ignore";
    if (!result.categories[categoryId]) result.categories[categoryId] = { label: categoryId, emails: [] };
    result.categories[categoryId].emails.push(email);
    if (forceDelete) {
      result.deletionCandidates.push(email);
      result.explicitDeletions.push(email);
    } else if (isProtected) {
      // protected
    } else if (deletionCategoryIds.has(categoryId) || matchesDeletionPattern(email, policy.patterns || [])) {
      result.deletionCandidates.push(email);
      result.heuristicDeletions.push(email);
    }
  }
  return result;
}

describe("senderRuleApplies — unless clause on alwaysDelete", () => {
  const ebayMarketingRule = {
    type: "name",
    value: "eBay",
    label: "eBay marketing",
    unless: {
      subjectContains: ["delivered", "out for delivery", "order", "security", "buyer", "seller"]
    }
  };

  it("returns true when sender matches and unless is not present", () => {
    const rule = { type: "name", value: "eBay", label: "eBay" };
    const email = { fromName: "eBay", subject: "Big sale this week" };
    assert.equal(senderRuleApplies(email, rule), true);
  });

  it("returns false when sender matches but unless.subjectContains matches", () => {
    const email = { fromName: "eBay", subject: "Your order is OUT FOR DELIVERY" };
    assert.equal(senderRuleApplies(email, ebayMarketingRule), false);
  });

  it("returns true when sender matches and unless.subjectContains does not match", () => {
    const email = { fromName: "eBay", subject: "Deal Days — extra 20% off" };
    assert.equal(senderRuleApplies(email, ebayMarketingRule), true);
  });

  it("returns false when sender does not match (regardless of unless)", () => {
    const email = { fromName: "Amazon", subject: "Your order is delivered" };
    assert.equal(senderRuleApplies(email, ebayMarketingRule), false);
  });

  it("unless.subjectContains is case-insensitive", () => {
    const email = { fromName: "ebay", subject: "ORDER confirmed" };
    assert.equal(senderRuleApplies(email, ebayMarketingRule), false);
  });
});

describe("classify-emails — unless clause on personal alwaysDelete", () => {
  const personalAccountWithEbayUnless = {
    ...personalAccount,
    alwaysDelete: [
      {
        type: "name",
        value: "eBay",
        label: "eBay marketing",
        unless: { subjectContains: ["delivered", "order", "security"] }
      }
    ]
  };

  it("keeps eBay transactional email out of deletion candidates", () => {
    const emails = [
      { id: "1", fromName: "eBay", from: "noreply@ebay.com", subject: "Your order is delivered" }
    ];
    const result = classifyWithAccount(emails, personalAccountWithEbayUnless, personalTypeConfig);
    assert.equal(result.deletionCandidates.length, 0);
  });

  it("deletes eBay promotional email", () => {
    const emails = [
      { id: "1", fromName: "eBay", from: "noreply@ebay.com", subject: "Flash deal — 50% off" }
    ];
    const result = classifyWithAccount(emails, personalAccountWithEbayUnless, personalTypeConfig);
    assert.equal(result.deletionCandidates.length, 1);
  });
});

describe("matchesScamPattern", () => {
  const annualReportScam = {
    label: "Annual Report filing scam",
    subjectAll: ["annual report"],
    senderAllowlist: ["sunbiz.org"],
    action: "delete"
  };

  it("matches when subject contains all subjectAll terms and sender not in allowlist", () => {
    const email = {
      from: "renew@flcorpfiling.com",
      subject: "2026 Annual Report Filing Notice"
    };
    assert.equal(matchesScamPattern(email, annualReportScam), true);
  });

  it("does not match when sender is in allowlist", () => {
    const email = {
      from: "noreply@sunbiz.org",
      subject: "Annual Report Reminder"
    };
    assert.equal(matchesScamPattern(email, annualReportScam), false);
  });

  it("does not match when subject is missing a subjectAll term", () => {
    const email = {
      from: "renew@flcorpfiling.com",
      subject: "Corporate Filing Reminder"
    };
    assert.equal(matchesScamPattern(email, annualReportScam), false);
  });

  it("matches all subjectAll terms (multi-term)", () => {
    const pattern = { subjectAll: ["annual report", "filing"], senderAllowlist: [] };
    const email1 = { from: "x@y.com", subject: "Annual Report — filing due" };
    const email2 = { from: "x@y.com", subject: "Annual Report" };
    assert.equal(matchesScamPattern(email1, pattern), true);
    assert.equal(matchesScamPattern(email2, pattern), false);
  });

  it("is case-insensitive on subject and sender domain", () => {
    const email = { from: "Renew@FLCorpFiling.COM", subject: "ANNUAL REPORT 2026" };
    assert.equal(matchesScamPattern(email, annualReportScam), true);
  });

  it("empty subjectAll never matches (defensive)", () => {
    const pattern = { subjectAll: [], senderAllowlist: ["sunbiz.org"] };
    const email = { from: "anything@x.com", subject: "Anything" };
    assert.equal(matchesScamPattern(email, pattern), false);
  });
});

describe("classify-emails — scamPatterns force into deletion", () => {
  const summitWithScam = {
    id: "summitmiami",
    name: "Summit Miami",
    accountType: "business",
    provider: "outlook",
    myEmail: "ben@summit.com",
    prioritySenders: [],
    urgencyRules: { flags: [] },
    downrank: [],
    alwaysDelete: [],
    neverDelete: [],
    scamPatterns: [{
      label: "Annual Report scam",
      subjectAll: ["annual report"],
      senderAllowlist: ["sunbiz.org"],
      action: "delete"
    }]
  };

  it("deletes scam pattern hit from rotating domain", () => {
    const emails = [
      { id: "1", from: "renew@corporateusafilings.com", fromName: "Filing Co", subject: "2026 Annual Report Filing Notice" }
    ];
    const result = classifyWithAccount(emails, summitWithScam, businessTypeConfig);
    assert.equal(result.deletionCandidates.length, 1);
    assert.equal(result.categories.ignore.emails.length, 1);
  });

  it("does not delete from allowlisted sender", () => {
    const emails = [
      { id: "1", from: "noreply@sunbiz.org", fromName: "Sunbiz", subject: "Annual Report Reminder" }
    ];
    const result = classifyWithAccount(emails, summitWithScam, businessTypeConfig);
    assert.equal(result.deletionCandidates.length, 0);
  });

  it("neverDelete wins over scamPatterns (protection precedence)", () => {
    const account = {
      ...summitWithScam,
      neverDelete: [{ type: "domain", value: "flcorpfiling.com", label: "test override" }]
    };
    const emails = [
      { id: "1", from: "renew@flcorpfiling.com", fromName: "Filing Co", subject: "Annual Report 2026" }
    ];
    const result = classifyWithAccount(emails, account, businessTypeConfig);
    assert.equal(result.deletionCandidates.length, 0);
  });
});

describe("classify — explicit vs heuristic deletion tagging", () => {
  const account = {
    id: "brickellpay",
    name: "Brickell Pay",
    accountType: "business",
    provider: "outlook",
    myEmail: "ben@brickellpay.com",
    prioritySenders: [],
    urgencyRules: { flags: [] },
    downrank: [],
    alwaysDelete: [{ type: "name", value: "SpamCo", label: "spam" }],
    neverDelete: [],
    scamPatterns: [{ label: "AR scam", subjectAll: ["annual report"], senderAllowlist: ["sunbiz.org"], action: "delete" }],
  };
  const typeConfig = {
    triageCategories: [
      { id: "action", label: "ACTION", actionable: true },
      { id: "fyi", label: "FYI" },
      { id: "ignore", label: "IGNORE", hidden: true },
    ],
    downrankDefaults: [],
    bulkSignalThreshold: 1,
    deletionPolicy: { categories: ["ignore"], patterns: ["limited time offer"], neverDelete: [], alwaysDelete: [] },
  };

  it("tags alwaysDelete hits as explicit", () => {
    const emails = [{ id: "e1", fromName: "SpamCo", from: "x@spamco.com", subject: "buy now" }];
    const r = classifyWithAccount(emails, account, typeConfig);
    assert.equal(r.explicitDeletions.length, 1);
    assert.equal(r.heuristicDeletions.length, 0);
    assert.equal(r.deletionCandidates.length, 1);
  });

  it("tags scamPattern hits as explicit", () => {
    const emails = [{ id: "e1", from: "x@flcorpfiling.com", fromName: "Filing Co", subject: "Annual Report Notice" }];
    const r = classifyWithAccount(emails, account, typeConfig);
    assert.equal(r.explicitDeletions.length, 1);
    assert.equal(r.heuristicDeletions.length, 0);
  });

  it("tags bulk-signal / pattern deletions as heuristic", () => {
    const emails = [{ id: "e1", from: "noreply@news.example.com", fromName: "Newsletter", subject: "limited time offer", hasListUnsubscribe: true }];
    const r = classifyWithAccount(emails, account, typeConfig);
    assert.equal(r.explicitDeletions.length, 0);
    assert.equal(r.heuristicDeletions.length, 1);
    assert.equal(r.deletionCandidates.length, 1);
  });

  it("keeps survivors out of both deletion lists", () => {
    const emails = [{ id: "e1", from: "partner@brickellpay.com", fromName: "Partner", subject: "Re: contract question" }];
    const r = classifyWithAccount(emails, account, typeConfig);
    assert.equal(r.explicitDeletions.length, 0);
    assert.equal(r.heuristicDeletions.length, 0);
  });
});
