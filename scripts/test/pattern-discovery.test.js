import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverAutoTrash,
  discoverScamPatterns,
  discoverMemoryBackfill,
  proposalId,
  isPendingProposal
} from "../pattern-discovery.js";

describe("proposalId", () => {
  it("generates stable id from timestamp and counter", () => {
    const id = proposalId("2026-05-21T06:00:00Z", 1);
    assert.equal(id, "p-2026-05-21-001");
  });
  it("pads counter to 3 digits", () => {
    assert.equal(proposalId("2026-05-21T06:00:00Z", 42), "p-2026-05-21-042");
  });
});

describe("isPendingProposal", () => {
  it("returns true when a pending proposal targets the same config path with matching payload value", () => {
    const proposals = [
      { id: "p-1", target: "companies.personal.alwaysDelete", payload: { value: "foo@x.com" }, status: "pending" }
    ];
    assert.equal(isPendingProposal(proposals, "companies.personal.alwaysDelete", "foo@x.com"), true);
  });
  it("returns false when proposal is approved/declined", () => {
    const proposals = [
      { id: "p-1", target: "companies.personal.alwaysDelete", payload: { value: "foo@x.com" }, status: "approved" }
    ];
    assert.equal(isPendingProposal(proposals, "companies.personal.alwaysDelete", "foo@x.com"), false);
  });
});

describe("discoverAutoTrash", () => {
  it("emits proposal when sender-history has >=5 deletes + list-unsubscribe + not protected", () => {
    const history = {
      "personal:noreply@bizjournals.com": {
        deletedCount: 7,
        hasListUnsubscribe: true,
        lastDeletedAt: "2026-05-21T06:00:00Z"
      }
    };
    const accounts = [{ id: "personal", neverDelete: [], prioritySenders: [] }];
    const proposals = discoverAutoTrash(history, accounts, [], { now: "2026-05-21T06:00:00Z" });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].target, "companies.personal.alwaysDelete");
    assert.equal(proposals[0].payload.value, "noreply@bizjournals.com");
    assert.equal(proposals[0].payload.type, "email");
  });

  it("does not propose when sender is in neverDelete", () => {
    const history = {
      "personal:noreply@bizjournals.com": { deletedCount: 9, hasListUnsubscribe: true, lastDeletedAt: "..." }
    };
    const accounts = [{ id: "personal", neverDelete: [{ type: "domain", value: "bizjournals.com" }], prioritySenders: [] }];
    const proposals = discoverAutoTrash(history, accounts, [], { now: "..." });
    assert.equal(proposals.length, 0);
  });

  it("does not re-propose when pending proposal already exists", () => {
    const history = {
      "personal:noreply@bizjournals.com": { deletedCount: 7, hasListUnsubscribe: true, lastDeletedAt: "..." }
    };
    const accounts = [{ id: "personal", neverDelete: [], prioritySenders: [] }];
    const pending = [
      { id: "p-1", target: "companies.personal.alwaysDelete", payload: { value: "noreply@bizjournals.com" }, status: "pending" }
    ];
    const proposals = discoverAutoTrash(history, accounts, pending, { now: "..." });
    assert.equal(proposals.length, 0);
  });

  it("does not propose under threshold", () => {
    const history = { "personal:foo@x.com": { deletedCount: 3, hasListUnsubscribe: true, lastDeletedAt: "..." } };
    const accounts = [{ id: "personal", neverDelete: [], prioritySenders: [] }];
    assert.equal(discoverAutoTrash(history, accounts, [], { now: "..." }).length, 0);
  });
});

describe("discoverScamPatterns", () => {
  it("emits proposal when >=3 deletions match fuzzy subject across >=2 domains in 30d", () => {
    const recentDeletions = [
      { accountId: "summitmiami", subject: "Annual Report Filing Notice", senderDomain: "flcorpfiling.com", deletedAt: "2026-05-15T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report 2026", senderDomain: "corporateusafilings.com", deletedAt: "2026-05-18T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report Reminder", senderDomain: "myfloridacorpfilings.com", deletedAt: "2026-05-20T00:00:00Z" }
    ];
    const accounts = [{ id: "summitmiami", neverDelete: [] }];
    const proposals = discoverScamPatterns(recentDeletions, accounts, [], { now: "2026-05-21T00:00:00Z" });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].target, "companies.summitmiami.scamPatterns");
    assert.ok(proposals[0].payload.subjectAll.includes("annual report"));
    assert.deepEqual(proposals[0].payload.senderAllowlist, []);
  });

  it("does not emit when fewer than 2 distinct domains", () => {
    const recentDeletions = [
      { accountId: "summitmiami", subject: "Annual Report Filing", senderDomain: "flcorpfiling.com", deletedAt: "2026-05-15T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report 2026", senderDomain: "flcorpfiling.com", deletedAt: "2026-05-18T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report Reminder", senderDomain: "flcorpfiling.com", deletedAt: "2026-05-20T00:00:00Z" }
    ];
    const proposals = discoverScamPatterns(recentDeletions, [{ id: "summitmiami", neverDelete: [] }], [], { now: "2026-05-21T00:00:00Z" });
    assert.equal(proposals.length, 0);
  });

  it("ignores deletions older than 30d", () => {
    const recentDeletions = [
      { accountId: "summitmiami", subject: "Annual Report Filing", senderDomain: "a.com", deletedAt: "2026-03-01T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report 2026", senderDomain: "b.com", deletedAt: "2026-03-02T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report Reminder", senderDomain: "c.com", deletedAt: "2026-03-03T00:00:00Z" }
    ];
    const proposals = discoverScamPatterns(recentDeletions, [{ id: "summitmiami", neverDelete: [] }], [], { now: "2026-05-21T00:00:00Z" });
    assert.equal(proposals.length, 0);
  });

  it("does not re-propose when pending proposal already exists for same pattern", () => {
    const recentDeletions = [
      { accountId: "summitmiami", subject: "Annual Report Filing", senderDomain: "a.com", deletedAt: "2026-05-15T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report 2026", senderDomain: "b.com", deletedAt: "2026-05-18T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report Reminder", senderDomain: "c.com", deletedAt: "2026-05-20T00:00:00Z" }
    ];
    const pending = [
      { id: "p-x", target: "companies.summitmiami.scamPatterns", payload: { subjectAll: ["annual report"] }, status: "pending" }
    ];
    const proposals = discoverScamPatterns(recentDeletions, [{ id: "summitmiami", neverDelete: [] }], pending, { now: "2026-05-21T00:00:00Z" });
    assert.equal(proposals.length, 0);
  });
});

describe("discoverMemoryBackfill", () => {
  let tmpDir;
  let memoryDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-backfill-test-"));
    memoryDir = join(tmpDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("proposes neverDelete entry for a feedback_*.md that references a sender not in any config neverDelete", () => {
    writeFileSync(join(memoryDir, "feedback_equinox_account.md"),
      "---\nnode_type: memory\ntype: feedback\n---\n\n" +
      "noreply@equinox.com account info emails are keeps (user is an Equinox member).\n"
    );
    const accounts = [{ id: "personal", neverDelete: [] }];
    const proposals = discoverMemoryBackfill(memoryDir, accounts, [], { now: "2026-05-21T06:00:00Z" });
    assert.ok(proposals.length >= 1);
    const equinoxProposal = proposals.find(p => JSON.stringify(p.payload).toLowerCase().includes("equinox"));
    assert.ok(equinoxProposal, "should propose an equinox-related rule");
  });

  it("does not propose when memory rule is already represented in config", () => {
    writeFileSync(join(memoryDir, "feedback_equinox_account.md"),
      "noreply@equinox.com account info emails are keeps.\n"
    );
    const accounts = [{ id: "personal", neverDelete: [{ type: "domain", value: "equinox.com" }] }];
    const proposals = discoverMemoryBackfill(memoryDir, accounts, [], { now: "2026-05-21T06:00:00Z" });
    const equinoxProposal = proposals.find(p => JSON.stringify(p.payload).toLowerCase().includes("equinox"));
    assert.equal(equinoxProposal, undefined);
  });

  it("routes memory backfill to the account whose memoryKeywords match", () => {
    writeFileSync(join(memoryDir, "feedback_acme.md"),
      "noreply@acme.example.com — Acme Corp client emails are keeps.\n"
    );
    const accounts = [
      { id: "personal", accountType: "personal", neverDelete: [], memoryKeywords: [] },
      { id: "acmebusiness", accountType: "business", neverDelete: [], memoryKeywords: ["acme corp", "acme client"] }
    ];
    const proposals = discoverMemoryBackfill(memoryDir, accounts, [], { now: "2026-05-21T06:00:00Z" });
    const acmeProposal = proposals.find(p => p.target.includes("acmebusiness"));
    assert.ok(acmeProposal, "should route to acmebusiness based on memoryKeywords");
  });

  it("falls back to first personal account when no keywords match", () => {
    writeFileSync(join(memoryDir, "feedback_mystery.md"),
      "noreply@mystery.com — no keywords here.\n"
    );
    const accounts = [
      { id: "bp", accountType: "business", neverDelete: [], memoryKeywords: ["payments"] },
      { id: "personal", accountType: "personal", neverDelete: [], memoryKeywords: [] }
    ];
    const proposals = discoverMemoryBackfill(memoryDir, accounts, [], { now: "2026-05-21T06:00:00Z" });
    const fallback = proposals.find(p => p.target.includes("personal"));
    assert.ok(fallback, "should fall back to the personal account");
  });
});

describe("proposal counter does not collide when same snapshot is passed twice", () => {
  it("nextCounterFor-based counter starts from existing max for that date", () => {
    const history = {
      "personal:foo@x.com": { deletedCount: 7, hasListUnsubscribe: true, lastDeletedAt: "..." },
      "personal:bar@x.com": { deletedCount: 6, hasListUnsubscribe: true, lastDeletedAt: "..." }
    };
    const accounts = [{ id: "personal", neverDelete: [], prioritySenders: [] }];
    // Pre-existing proposals for today already used 001 and 002
    const pending = [
      { id: "p-2026-05-21-001", target: "companies.personal.alwaysDelete", payload: { type: "email", value: "old@x.com" }, status: "approved" },
      { id: "p-2026-05-21-002", target: "companies.personal.alwaysDelete", payload: { type: "email", value: "older@x.com" }, status: "declined" }
    ];
    const result = discoverAutoTrash(history, accounts, pending, { now: "2026-05-21T06:00:00Z" });
    assert.equal(result.length, 2);
    // IDs should be 003 and 004 — strictly greater than max existing counter
    const ids = result.map(p => p.id).sort();
    assert.equal(ids[0], "p-2026-05-21-003");
    assert.equal(ids[1], "p-2026-05-21-004");
  });
});

describe("isPendingProposal — exact field equality", () => {
  it("returns true on exact value match (alwaysDelete payload)", () => {
    const proposals = [
      { id: "p-1", target: "companies.personal.alwaysDelete", payload: { type: "email", value: "foo@x.com" }, status: "pending" }
    ];
    assert.equal(isPendingProposal(proposals, "companies.personal.alwaysDelete", "foo@x.com"), true);
  });

  it("returns false on substring-only match (not exact)", () => {
    const proposals = [
      { id: "p-1", target: "companies.personal.alwaysDelete", payload: { type: "name", value: "annual reporting strategy" }, status: "pending" }
    ];
    // Substring "annual report" is inside but should not match exactly
    assert.equal(isPendingProposal(proposals, "companies.personal.alwaysDelete", "annual report"), false);
  });

  it("returns true for scamPatterns when subjectAll contains exact phrase", () => {
    const proposals = [
      { id: "p-1", target: "companies.summitmiami.scamPatterns", payload: { subjectAll: ["annual report"], senderAllowlist: [] }, status: "pending" }
    ];
    assert.equal(isPendingProposal(proposals, "companies.summitmiami.scamPatterns", "annual report"), true);
  });

  it("returns false when target does not match", () => {
    const proposals = [
      { id: "p-1", target: "companies.personal.alwaysDelete", payload: { value: "foo@x.com" }, status: "pending" }
    ];
    assert.equal(isPendingProposal(proposals, "companies.summitmiami.scamPatterns", "foo@x.com"), false);
  });
});

describe("discoverScamPatterns — over-broad single-word patterns", () => {
  // Real-world false positives observed on 2026-05-23 live run:
  // ["with"], ["inside"], ["about"], ["save"], ["benjamin"] all proposed
  // because the STOPWORDS list was too sparse AND because single-term
  // intersections were emitted. Fix: expand stopwords, require >=2 terms.

  it("does NOT propose when the intersected pattern is a single stopword", () => {
    // Three subjects from three domains that share only the stopword "save"
    const recentDeletions = [
      { accountId: "personal", subject: "Save 20% on running shoes", senderDomain: "nike.com", deletedAt: "2026-05-22T00:00:00Z" },
      { accountId: "personal", subject: "Save the date — annual gala", senderDomain: "charity.org", deletedAt: "2026-05-22T01:00:00Z" },
      { accountId: "personal", subject: "Save your spot — free webinar", senderDomain: "marketing.io", deletedAt: "2026-05-22T02:00:00Z" }
    ];
    const proposals = discoverScamPatterns(recentDeletions, [{ id: "personal", neverDelete: [] }], [], { now: "2026-05-23T00:00:00Z" });
    assert.equal(proposals.length, 0, "should not propose any rule when the only commonality is a stopword");
  });

  it("does NOT propose when the intersected pattern is a single non-stopword content term", () => {
    // Three subjects that share exactly one content term ("widget") but nothing else
    const recentDeletions = [
      { accountId: "personal", subject: "Widget order confirmation", senderDomain: "a.com", deletedAt: "2026-05-22T00:00:00Z" },
      { accountId: "personal", subject: "Widget recall notice", senderDomain: "b.com", deletedAt: "2026-05-22T01:00:00Z" },
      { accountId: "personal", subject: "Widget delivery update", senderDomain: "c.com", deletedAt: "2026-05-22T02:00:00Z" }
    ];
    const proposals = discoverScamPatterns(recentDeletions, [{ id: "personal", neverDelete: [] }], [], { now: "2026-05-23T00:00:00Z" });
    assert.equal(proposals.length, 0, "should not propose a single-term pattern even if the term is non-stopword");
  });

  it("DOES still propose when at least 2 content terms intersect (Annual Report scam still works)", () => {
    const recentDeletions = [
      { accountId: "summitmiami", subject: "Annual Report Filing Notice", senderDomain: "flcorpfiling.com", deletedAt: "2026-05-15T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report 2026 — Action Required", senderDomain: "corporateusafilings.com", deletedAt: "2026-05-18T00:00:00Z" },
      { accountId: "summitmiami", subject: "Annual Report Reminder for Your LLC", senderDomain: "myfloridacorpfilings.com", deletedAt: "2026-05-20T00:00:00Z" }
    ];
    const proposals = discoverScamPatterns(recentDeletions, [{ id: "summitmiami", neverDelete: [] }], [], { now: "2026-05-21T00:00:00Z" });
    assert.equal(proposals.length, 1, "Annual Report scam should still be detected (multi-term intersection)");
    assert.equal(proposals[0].payload.subjectAll[0], "annual report");
  });

  // Pin specific stopwords that bit us in the 2026-05-23 live run
  for (const stopword of ["with", "inside", "about", "save"]) {
    it(`filters "${stopword}" as a stopword in single-term intersections`, () => {
      const recentDeletions = [
        { accountId: "personal", subject: `Email ${stopword} alpha one`, senderDomain: "a.com", deletedAt: "2026-05-22T00:00:00Z" },
        { accountId: "personal", subject: `Notice ${stopword} bravo two`, senderDomain: "b.com", deletedAt: "2026-05-22T01:00:00Z" },
        { accountId: "personal", subject: `Update ${stopword} charlie three`, senderDomain: "c.com", deletedAt: "2026-05-22T02:00:00Z" }
      ];
      const proposals = discoverScamPatterns(recentDeletions, [{ id: "personal", neverDelete: [] }], [], { now: "2026-05-23T00:00:00Z" });
      assert.equal(proposals.length, 0, `"${stopword}" should be filtered by STOPWORDS, leaving no intersection`);
    });
  }
});
