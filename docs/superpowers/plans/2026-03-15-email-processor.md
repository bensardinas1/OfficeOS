# Email Processor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all email classification, noise filtering, and deletion candidate logic out of skill files and into `scripts/classify-emails.js` — a reusable processor script callable from both the CLI and a future UI.

**Architecture:** `classify-emails.js` exports a `classify(emails, accountId)` function that loads config, resolves categories and downrank rules, classifies each email, applies noise filters, and returns structured JSON. A CLI wrapper reads raw email JSON from stdin and writes results to stdout. Both `email-triage.md` and `orchestrators/triage.md` are updated to call this script instead of embedding logic.

**Tech Stack:** Node.js 24 (ESM), `node:test` (built-in test runner), `node:fs`, `node:path`

---

## Chunk 1: Infrastructure + Config Helpers

### Task 1: Test infrastructure

**Files:**
- Modify: `package.json`
- Create: `scripts/test/fixtures/accounts.js`
- Create: `scripts/test/fixtures/emails.js`

- [ ] **Step 1: Add test script to package.json**

```json
"scripts": {
  "fetch-emails": "node scripts/fetch-emails.js",
  "test-auth": "node scripts/test-auth.js",
  "test": "node --test scripts/test/**/*.test.js"
}
```

- [ ] **Step 2: Create account fixtures**

Create `scripts/test/fixtures/accounts.js`:

```js
export const businessTypeConfig = {
  tone: "professional",
  triageCategories: [
    { id: "action", label: "ACTION REQUIRED", description: "Needs a response or decision" },
    { id: "fyi", label: "FYI / READ", description: "Informational, no action needed" },
    { id: "news", label: "NEWS / MARKET", description: "Industry or market updates" },
    { id: "ignore", label: "IGNORE", hidden: true }
  ],
  downrankDefaults: ["bulk email", "newsletters", "marketing", "solicitations", "unsubscribe", "promotional"],
  noiseFilters: null,
  dailyBrief: { section: "main" },
  taskCapture: "auto"
};

export const personalTypeConfig = {
  tone: "casual",
  triageCategories: [
    { id: "respond", label: "RESPOND", description: "Needs a reply" },
    { id: "bills", label: "BILLS / FINANCE", description: "Bills due, statements, bank alerts" },
    { id: "appointments", label: "APPOINTMENTS", description: "Medical, dental, personal services" },
    { id: "shopping", label: "SHOPPING / ORDERS", description: "Order confirmations, shipping" },
    { id: "subscriptions", label: "SUBSCRIPTIONS / RENEWALS", description: "Renewal notices" },
    { id: "newsletters", label: "NEWSLETTERS", description: "Opted-in reads" },
    { id: "ignore", label: "IGNORE", hidden: true }
  ],
  downrankDefaults: [
    "promotional", "unsubscribe", "deal alert", "limited time", "flash sale",
    "exclusive offer", "free shipping", "items you might like"
  ],
  noiseFilters: {
    signals_keep: ["confirmation", "receipt", "shipped", "delivered", "reminder",
                   "appointment", "invoice", "due", "renewal", "booking", "payment"],
    signals_reject: ["promotion", "deal", "offer", "recommended", "trending",
                     "you might like", "earn", "reward points", "upgrade"]
  },
  dailyBrief: { section: "personal-appendix" },
  taskCapture: "manual"
};

export const businessAccount = {
  id: "testbiz",
  name: "Test Business",
  accountType: "business",
  provider: "outlook",
  prioritySenders: [
    { type: "domain", value: "testbiz.com", label: "Internal" },
    { type: "name", value: "Jane Partner", label: "Partner" }
  ],
  urgencyRules: {
    flags: ["urgent", "deadline", "review", "terminated"]
  },
  downrank: ["solicitation"],
  categoryOverrides: []
};

export const personalAccount = {
  id: "testpersonal",
  name: "Personal",
  accountType: "personal",
  provider: "gmail",
  prioritySenders: [],
  urgencyRules: { flags: [] },
  downrank: [],
  categoryOverrides: [
    {
      id: "iaido",
      label: "IAIDO",
      description: "Iaido study and competition",
      prioritySenders: [{ type: "domain", value: "auskf.org", label: "National federation" }],
      urgencyRules: { flags: ["tournament", "registration", "deadline", "grading"] },
      downrank: ["merchandise"]
    }
  ]
};
```

- [ ] **Step 3: Create email fixtures**

Create `scripts/test/fixtures/emails.js`:

```js
export const emails = {
  // Business emails
  fromInternalDomain: {
    id: "e1", subject: "Q2 Report", from: "alice@testbiz.com",
    fromName: "Alice Smith", preview: "Please review the attached Q2 report", received: "2026-03-14T10:00:00Z"
  },
  fromPrioritySenderByName: {
    id: "e2", subject: "Call me", from: "jane@external.com",
    fromName: "Jane Partner", preview: "Can we talk?", received: "2026-03-14T10:01:00Z"
  },
  withUrgencyFlag: {
    id: "e3", subject: "Account terminated", from: "processor@bank.com",
    fromName: "Bank", preview: "Account has been terminated effective immediately", received: "2026-03-14T10:02:00Z"
  },
  newsletter: {
    id: "e4", subject: "Weekly IT Newsletter", from: "news@substack.com",
    fromName: "IT News", preview: "Top articles this week", received: "2026-03-14T10:03:00Z"
  },
  marketing: {
    id: "e5", subject: "Drive revenue with our product", from: "sales@vendor.com",
    fromName: "Vendor", preview: "Promotional offer inside", received: "2026-03-14T10:04:00Z"
  },
  downrankedByAccount: {
    id: "e6", subject: "Solicitation for your business", from: "cold@spam.com",
    fromName: "Spam Co", preview: "solicitation for your attention", received: "2026-03-14T10:05:00Z"
  },
  fyi: {
    id: "e7", subject: "FYI: Office closed Monday", from: "admin@other.com",
    fromName: "Admin", preview: "Just letting you know the office is closed", received: "2026-03-14T10:06:00Z"
  },
  // Personal emails
  chaseStatement: {
    id: "p1", subject: "Your statement is ready", from: "no.reply@chase.com",
    fromName: "Chase", preview: "Statement balance due on 04/10/2026 payment required", received: "2026-03-14T11:00:00Z"
  },
  uberEatsDeal: {
    id: "p2", subject: "50% off your next order — deal expires tonight",
    from: "promotions@uber.com", fromName: "Uber Eats",
    preview: "Exclusive deal offer: 50% off", received: "2026-03-14T11:01:00Z"
  },
  iaidoFromFederation: {
    id: "p3", subject: "2026 Tournament Registration", from: "events@auskf.org",
    fromName: "AUSKF", preview: "Registration deadline for the national tournament", received: "2026-03-14T11:02:00Z"
  },
  iaidoMerchandise: {
    id: "p4", subject: "New merchandise available", from: "shop@auskf.org",
    fromName: "AUSKF Shop", preview: "New merchandise in the store", received: "2026-03-14T11:03:00Z"
  },
  shippingConfirmation: {
    id: "p5", subject: "Your order has shipped", from: "orders@amazon.com",
    fromName: "Amazon", preview: "confirmation: your package has been shipped and delivered", received: "2026-03-14T11:04:00Z"
  },
  retailPromo: {
    id: "p6", subject: "New arrivals — items you might like",
    from: "promo@store.com", fromName: "Store",
    preview: "Recommended for you: new arrivals", received: "2026-03-14T11:05:00Z"
  }
};
```

- [ ] **Step 4: Run test suite to confirm infrastructure works**

```bash
cd "D:\OneDrive - Brickell Payments (WORKFORCE)\Documents\OfficeOS"
npm test
```

Expected: "no test files found" or similar — no failures.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/test/
git commit -m "test: add test infrastructure and fixtures for classify-emails"
```

---

### Task 2: Config resolution helpers

**Files:**
- Create: `scripts/classify-emails.js` (skeleton + config helpers only)
- Create: `scripts/test/classify-emails.test.js` (config resolution tests only)

- [ ] **Step 1: Write failing tests for resolveCategories and resolveDownrank**

Create `scripts/test/classify-emails.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test
```

Expected: `ERR_MODULE_NOT_FOUND` or similar — classify-emails.js doesn't exist yet.

- [ ] **Step 3: Implement skeleton + config helpers**

Create `scripts/classify-emails.js`:

```js
/**
 * classify-emails.js
 *
 * Processor: classifies a raw email array for a given account.
 *
 * CLI usage:
 *   node scripts/fetch-emails.js <accountId> 24 inbox | node scripts/classify-emails.js <accountId>
 *
 * Exports:
 *   classify(emails, accountId) → ClassificationResult
 *   resolveCategories(typeConfig, account) → Category[]
 *   resolveDownrank(typeConfig, account) → string[]
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const companies = JSON.parse(
    readFileSync(join(__dirname, "../config/companies.json"), "utf-8")
  );
  const accountTypes = JSON.parse(
    readFileSync(join(__dirname, "../config/account-types.json"), "utf-8")
  );
  return { companies, accountTypes };
}

export function resolveCategories(typeConfig, account) {
  let categories = [...typeConfig.triageCategories];
  for (const override of (account.categoryOverrides || [])) {
    const idx = categories.findIndex(c => c.id === override.id);
    if (idx >= 0) {
      categories[idx] = override;
    } else {
      categories.push(override);
    }
  }
  return categories;
}

export function resolveDownrank(typeConfig, account) {
  return [
    ...(typeConfig.downrankDefaults || []),
    ...(account.downrank || []),
  ];
}
```

- [ ] **Step 4: Run tests — config helpers should pass**

```bash
npm test
```

Expected: `resolveCategories` and `resolveDownrank` tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/classify-emails.js scripts/test/classify-emails.test.js
git commit -m "feat: add resolveCategories and resolveDownrank with tests"
```

---

## Chunk 2: Matching Helpers + Email Classification

### Task 3: Sender and content matching helpers

**Files:**
- Modify: `scripts/classify-emails.js`
- Modify: `scripts/test/classify-emails.test.js`

- [ ] **Step 1: Write failing tests for matchesSender, matchesDownrank, matchesUrgencyFlags**

Append to `scripts/test/classify-emails.test.js`:

```js
import {
  resolveCategories,
  resolveDownrank,
  matchesSender,
  matchesDownrank,
  matchesUrgencyFlags,
} from "../classify-emails.js";
import { emails } from "./fixtures/emails.js";

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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test
```

Expected: import errors for the new exports.

- [ ] **Step 3: Implement matching helpers**

Append to `scripts/classify-emails.js`:

```js
export function matchesSender(email, senders) {
  const fromEmail = (email.from || "").toLowerCase();
  const fromName = (email.fromName || "").toLowerCase();
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();

  for (const sender of senders) {
    if (sender.type === "domain") {
      const domain = fromEmail.split("@")[1];
      if (domain === sender.value.toLowerCase()) return true;
    } else if (sender.type === "name") {
      if (fromName.includes(sender.value.toLowerCase())) return true;
    } else if (sender.type === "email") {
      if (fromEmail === sender.value.toLowerCase()) return true;
    } else if (sender.type === "keyword") {
      if (text.includes(sender.value.toLowerCase())) return true;
    }
  }
  return false;
}

export function matchesDownrank(email, downrankList) {
  const text = `${email.subject || ""} ${email.fromName || ""} ${email.from || ""} ${email.preview || ""}`.toLowerCase();
  return downrankList.some(term => text.includes(term.toLowerCase()));
}

export function matchesUrgencyFlags(email, flags) {
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();
  return flags.some(flag => text.includes(flag.toLowerCase()));
}
```

- [ ] **Step 4: Run tests — all matching helpers should pass**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/classify-emails.js scripts/test/classify-emails.test.js
git commit -m "feat: add matchesSender, matchesDownrank, matchesUrgencyFlags with tests"
```

---

### Task 4: Business email classification

**Files:**
- Modify: `scripts/classify-emails.js`
- Modify: `scripts/test/classify-emails.test.js`

- [ ] **Step 1: Write failing tests for classifyEmail (business)**

Append to `scripts/test/classify-emails.test.js`:

```js
import {
  resolveCategories, resolveDownrank, matchesSender,
  matchesDownrank, matchesUrgencyFlags, classifyEmail,
} from "../classify-emails.js";

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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test
```

Expected: import error for `classifyEmail`.

- [ ] **Step 3: Implement classifyEmail**

Append to `scripts/classify-emails.js`:

```js
export function classifyEmail(email, account, typeConfig, categories, downrankList) {
  // 1. Downrank check (type defaults + account-level) → IGNORE
  if (matchesDownrank(email, downrankList)) return "ignore";

  // 2. Rich category overrides — check each for its own senders, urgency flags, and downrank
  for (const cat of categories) {
    if (cat.hidden) continue;
    if (cat.downrank && matchesDownrank(email, cat.downrank)) return "ignore";
    if (cat.prioritySenders?.length && matchesSender(email, cat.prioritySenders)) return cat.id;
    if (cat.urgencyRules?.flags?.length && matchesUrgencyFlags(email, cat.urgencyRules.flags)) return cat.id;
  }

  // 3. Account-level priority senders → action / respond
  if (account.prioritySenders?.length && matchesSender(email, account.prioritySenders)) {
    const actionCat = categories.find(c => c.id === "action" || c.id === "respond");
    if (actionCat) return actionCat.id;
  }

  // 4. Account-level urgency flags → action / respond
  if (account.urgencyRules?.flags?.length && matchesUrgencyFlags(email, account.urgencyRules.flags)) {
    const actionCat = categories.find(c => c.id === "action" || c.id === "respond");
    if (actionCat) return actionCat.id;
  }

  // 5. Default by account type
  if (typeConfig === null || account.accountType === "personal") {
    return classifyPersonalEmail(email, categories);
  }
  return "fyi";
}

function classifyPersonalEmail(email, categories) {
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();

  if (/statement|bill|invoice|payment.due|balance.due|autopay|account.alert|due.date/.test(text)) return "bills";
  if (/appointment|your.visit|check.?up|scheduled|reminder|seeing.you/.test(text)) return "appointments";
  if (/booking|itinerary|flight|hotel|reservation|check.?in|boarding|gate.change/.test(text)) return "travel";
  if (/order|shipped|delivered|tracking|return|refund|receipt/.test(text)) return "shopping";
  if (/subscription|renewal|renew|expires|membership|plan.change/.test(text)) return "subscriptions";
  if (/gym|workout|fitness|class|wellness/.test(text)) return "fitness";
  if (/invited|invitation|rsvp|party|gathering/.test(text)) return "social";

  // Default personal fallback
  const newsletterCat = categories.find(c => c.id === "newsletters");
  return newsletterCat ? "newsletters" : (categories.find(c => !c.hidden)?.id ?? "ignore");
}
```

- [ ] **Step 4: Run tests — business classification should pass**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/classify-emails.js scripts/test/classify-emails.test.js
git commit -m "feat: implement classifyEmail for business and personal accounts"
```

---

### Task 5: Personal email classification + noise filter

**Files:**
- Modify: `scripts/classify-emails.js`
- Modify: `scripts/test/classify-emails.test.js`

- [ ] **Step 1: Write failing tests for personal classification and applyNoiseFilter**

Append to `scripts/test/classify-emails.test.js`:

```js
import {
  resolveCategories, resolveDownrank, classifyEmail, applyNoiseFilter,
} from "../classify-emails.js";

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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test
```

Expected: import error for `applyNoiseFilter`.

- [ ] **Step 3: Implement applyNoiseFilter**

Append to `scripts/classify-emails.js`:

```js
export function applyNoiseFilter(email, noiseFilters) {
  if (!noiseFilters) return false;
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();
  const matchesReject = noiseFilters.signals_reject.some(s => text.includes(s));
  const matchesKeep = noiseFilters.signals_keep.some(s => text.includes(s));
  if (matchesReject && !matchesKeep) return true;
  return false;
}
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/classify-emails.js scripts/test/classify-emails.test.js
git commit -m "feat: add applyNoiseFilter with tests"
```

---

## Chunk 3: Full Pipeline + CLI + Skill Updates

### Task 6: classify() — full pipeline

**Files:**
- Modify: `scripts/classify-emails.js`
- Modify: `scripts/test/classify-emails.test.js`

- [ ] **Step 1: Write failing tests for classify()**

Append to `scripts/test/classify-emails.test.js`:

```js
import { classify } from "../classify-emails.js";

// classify() reads config files — we need to test with real account IDs
// Use a lightweight integration test against the actual config
describe("classify() — integration", () => {
  it("returns structured result with categories and deletionCandidates", () => {
    const emailBatch = [emails.fromInternalDomain, emails.newsletter, emails.withUrgencyFlag];
    const result = classify(emailBatch, "healthcarema");

    assert.ok(result.accountId === "healthcarema");
    assert.ok(result.accountName);
    assert.ok(typeof result.categories === "object");
    assert.ok(Array.isArray(result.deletionCandidates));
  });

  it("puts downranked emails in deletionCandidates", () => {
    const result = classify([emails.newsletter], "healthcarema");
    assert.equal(result.deletionCandidates.length, 1);
    assert.equal(result.deletionCandidates[0].id, "e4");
  });

  it("puts priority sender in action category for business account", () => {
    const result = classify([emails.fromInternalDomain], "healthcarema");
    assert.ok(result.categories.action.emails.length > 0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test
```

Expected: import error for `classify`.

- [ ] **Step 3: Implement classify()**

Append to `scripts/classify-emails.js`:

```js
export function classify(emails, accountId) {
  const { companies, accountTypes } = loadConfig();
  const account = companies.companies.find(c => c.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const typeKey = account.accountType || "business";
  const typeConfig = accountTypes[typeKey];
  if (!typeConfig) throw new Error(`Account type not found: ${typeKey}`);

  const categories = resolveCategories(typeConfig, account);
  const downrankList = resolveDownrank(typeConfig, account);
  const noiseFilters = typeConfig.noiseFilters;

  // Initialize result
  const result = {
    accountId,
    accountName: account.name,
    accountType: typeKey,
    categories: {},
    deletionCandidates: [],
  };

  for (const cat of categories) {
    result.categories[cat.id] = { label: cat.label, hidden: cat.hidden || false, emails: [] };
  }

  // Classify each email
  for (const email of emails) {
    let categoryId = classifyEmail(email, account, typeConfig, categories, downrankList);

    // Noise filter second pass
    if (categoryId !== "ignore" && noiseFilters) {
      if (applyNoiseFilter(email, noiseFilters)) categoryId = "ignore";
    }

    if (!result.categories[categoryId]) {
      result.categories[categoryId] = { label: categoryId, hidden: false, emails: [] };
    }
    result.categories[categoryId].emails.push(email);

    if (categoryId === "ignore") {
      result.deletionCandidates.push(email);
    }
  }

  return result;
}
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/classify-emails.js scripts/test/classify-emails.test.js
git commit -m "feat: implement classify() full pipeline with integration tests"
```

---

### Task 7: CLI entrypoint

**Files:**
- Modify: `scripts/classify-emails.js`

- [ ] **Step 1: Append CLI entrypoint at bottom of classify-emails.js**

```js
// CLI entrypoint — only runs when executed directly, not when imported
if (process.argv[1].endsWith("classify-emails.js")) {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error("Usage: node scripts/fetch-emails.js <accountId> 24 inbox | node scripts/classify-emails.js <accountId>");
    process.exit(1);
  }

  let raw = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", chunk => { raw += chunk; });
  process.stdin.on("end", () => {
    try {
      const emails = JSON.parse(raw);
      const result = classify(emails, accountId);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("Error:", err.message);
      process.exit(1);
    }
  });
}
```

- [ ] **Step 2: Smoke test the CLI end-to-end**

```bash
cd "D:\OneDrive - Brickell Payments (WORKFORCE)\Documents\OfficeOS"
node scripts/fetch-emails.js healthcarema 24 inbox | node scripts/classify-emails.js healthcarema
```

Expected: JSON output with `accountId`, `categories`, `deletionCandidates`.

- [ ] **Step 3: Commit**

```bash
git add scripts/classify-emails.js
git commit -m "feat: add CLI entrypoint to classify-emails.js"
```

---

### Task 8: Gmail deletion script

**Context:** `scripts/delete-emails.js` handles Outlook (Graph API). Gmail has no delete tool in the MCP — a separate script using the Gmail API is needed. Uses OAuth device flow (same pattern as `graph-client.js`) with tokens cached in `data/`.

**Files:**
- Create: `scripts/gmail-client.js`
- Create: `scripts/delete-gmail-emails.js`
- Modify: `package.json` (add `googleapis` dependency)
- Modify: `.env.example` (document new env vars)

- [ ] **Step 1: Install googleapis**

```bash
cd "D:\OneDrive - Brickell Payments (WORKFORCE)\Documents\OfficeOS"
npm install googleapis
```

- [ ] **Step 2: Add Gmail OAuth env vars to .env.example**

Append to `.env.example`:

```bash
# Gmail API — for deletion script (get from Google Cloud Console)
GMAIL_CLIENT_ID=your-client-id
GMAIL_CLIENT_SECRET=your-client-secret
# Refresh token is stored automatically in data/.gmail-token-cache.json after first auth
```

- [ ] **Step 3: Add Gmail credentials to .env**

In `.env`, add `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` from the Google Cloud Console project that owns the `ben@sardinasfamily.com` OAuth credentials. (If no project exists yet, create one at console.cloud.google.com, enable Gmail API, create OAuth 2.0 Desktop credentials.)

- [ ] **Step 4: Create gmail-client.js**

Create `scripts/gmail-client.js`:

```js
/**
 * gmail-client.js
 *
 * Builds an authenticated Gmail API client using OAuth 2.0.
 * On first run, prints an auth URL for the user to visit and paste the code.
 * Tokens are cached in data/.gmail-token-cache.json and refreshed automatically.
 */

import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = join(__dirname, "../data/.gmail-token-cache.json");
const DATA_DIR = join(__dirname, "../data");

function loadTokenCache() {
  if (existsSync(TOKEN_PATH)) return JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
  return null;
}

function saveTokenCache(tokens) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

async function promptUser(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

export async function buildGmailClient() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env");
  }

  const oauth2 = new google.auth.OAuth2(
    clientId,
    clientSecret,
    "urn:ietf:wg:oauth:2.0:oob"  // Desktop/CLI out-of-band redirect
  );

  const cached = loadTokenCache();
  if (cached) {
    oauth2.setCredentials(cached);
    // Refresh if expired
    if (cached.expiry_date && Date.now() > cached.expiry_date - 60000) {
      const { credentials } = await oauth2.refreshAccessToken();
      saveTokenCache(credentials);
      oauth2.setCredentials(credentials);
    }
  } else {
    // First-time auth flow
    const authUrl = oauth2.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/gmail.modify"],
    });
    console.error("\nOpen this URL to authorize Gmail access:\n");
    console.error(authUrl);
    console.error("");
    const code = await promptUser("Paste the authorization code: ");
    const { tokens } = await oauth2.getToken(code);
    saveTokenCache(tokens);
    oauth2.setCredentials(tokens);
  }

  return google.gmail({ version: "v1", auth: oauth2 });
}
```

- [ ] **Step 5: Create delete-gmail-emails.js**

Create `scripts/delete-gmail-emails.js`:

```js
/**
 * delete-gmail-emails.js <messageId1> [messageId2 ...]
 *
 * Moves the specified Gmail messages to trash.
 * Uses batch delete for efficiency.
 *
 * Usage:
 *   node scripts/delete-gmail-emails.js <id1> <id2> ...
 */

import { buildGmailClient } from "./gmail-client.js";

const messageIds = process.argv.slice(2);

if (messageIds.length === 0) {
  console.error("Usage: node scripts/delete-gmail-emails.js <messageId1> [messageId2 ...]");
  process.exit(1);
}

const gmail = await buildGmailClient();

try {
  await gmail.users.messages.batchDelete({
    userId: "me",
    requestBody: { ids: messageIds },
  });
  console.log(`Done: ${messageIds.length} deleted.`);
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
```

- [ ] **Step 6: Smoke test**

```bash
# First run will prompt for OAuth authorization
node scripts/delete-gmail-emails.js --help 2>&1 || true
```

If credentials are in `.env`, it will print the auth URL. Complete the OAuth flow once — subsequent runs use cached tokens.

- [ ] **Step 7: Commit**

```bash
git add scripts/gmail-client.js scripts/delete-gmail-emails.js .env.example package.json package-lock.json
git commit -m "feat: add Gmail deletion script with OAuth device flow"
```

---

### Task 9: Update skills to call classify-emails.js

**Files:**
- Modify: `.claude/commands/email/email-triage.md`
- Modify: `.claude/commands/orchestrators/triage.md`

- [ ] **Step 1: Update email-triage.md**

Replace steps 5–7 (normalize, classify, apply noise filters) with:

```markdown
5. **Run the processor** — pipe fetched emails through `classify-emails.js`:
   - Outlook: `node scripts/fetch-emails.js {account.id} 24 inbox | node scripts/classify-emails.js {account.id}`
   - Gmail: pass MCP results as JSON to stdin of `node scripts/classify-emails.js {account.id}`
   The processor returns `{ accountId, accountName, categories, deletionCandidates }`.

6. **Output** — render the processor's structured result. Group by resolved categories in array order,
   skipping categories marked `hidden: true`. For each visible category with emails:

   ### [{account.name}] {category.label}
   For each: **[From]** Subject — one line on what's needed and suggested next step
   Lead with the most urgent. Skip empty categories.

7. **Deletion candidates** — after all category output, add a divider and list every email
   in `deletionCandidates`. Number them sequentially, one line each: sender name — subject.
   End with: "Reply with numbers or ranges to delete (e.g. 'delete 1-12, 15'), or 'delete all'."
   When approved, call `node scripts/delete-emails.js {account.id} {id1} {id2} ...`.
```

- [ ] **Step 2: Update orchestrators/triage.md**

Replace steps 5–6 (normalize + classify) with:

```markdown
5. **Run the processor for each account** — for each account, pipe emails through classify-emails.js:
   - Outlook: `node scripts/fetch-emails.js {account.id} 24 inbox | node scripts/classify-emails.js {account.id}`
   - Gmail: pass MCP results as JSON to stdin of `node scripts/classify-emails.js {account.id}`
   Each call returns `{ accountId, accountName, accountType, categories, deletionCandidates }`.
   Collect all results. The processor handles all classification, noise filtering, and deletion detection.
```

Remove the inline classification/noise filter logic from the remaining steps — reference only the structured result from the processor.

- [ ] **Step 3: Verify skills reference no classification logic**

Read both updated skill files and confirm no category matching rules, downrank logic, or noise filter signals appear inline.

- [ ] **Step 4: Update skill deletion step for Gmail accounts**

In `email-triage.md`, update the deletion step to route by provider:

```markdown
When approved:
- Outlook accounts: `node scripts/delete-emails.js {account.id} {id1} {id2} ...`
- Gmail accounts: `node scripts/delete-gmail-emails.js {id1} {id2} ...`
```

Apply the same routing in `orchestrators/triage.md`.

- [ ] **Step 5: Commit**

```bash
git add .claude/commands/email/email-triage.md .claude/commands/orchestrators/triage.md
git commit -m "refactor: update skills to delegate classification to classify-emails.js"
```

---

## Summary

After this plan is complete:

| Layer | File | Responsibility |
|---|---|---|
| Connector | `scripts/fetch-emails.js` | Fetch raw emails from Outlook |
| Processor | `scripts/classify-emails.js` | Classify, filter, identify deletion candidates |
| Connector | `scripts/delete-emails.js` | Delete Outlook emails by ID (Graph API) |
| Connector | `scripts/delete-gmail-emails.js` | Delete Gmail messages by ID (Gmail API) |
| Auth | `scripts/gmail-client.js` | Gmail OAuth client with token caching |
| Skill | `.claude/commands/email/email-triage.md` | Thin shell: invoke scripts, render text |
| Orchestrator | `.claude/commands/orchestrators/triage.md` | Loop accounts, invoke same scripts, aggregate |

Both skills call the same processor. Zero logic duplication. UI-ready.
