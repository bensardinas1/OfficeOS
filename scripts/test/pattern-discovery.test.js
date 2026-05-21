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
});
