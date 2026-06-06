import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBundle, collectPages } from "../build-bundle.js";

describe("collectPages — paginates until past the window", () => {
  it("collects across pages and stops when items predate `since`", async () => {
    const pages = [
      [{ id: "1", receivedAt: "2026-06-05T10:00:00Z" }, { id: "2", receivedAt: "2026-06-05T09:00:00Z" }],
      [{ id: "3", receivedAt: "2026-06-04T10:00:00Z" }, { id: "4", receivedAt: "2026-05-01T00:00:00Z" }],
    ];
    let p = 0;
    const fetchPage = async () => ({ items: pages[p], nextToken: p + 1 < pages.length ? String(++p) : null });
    const out = await collectPages(fetchPage, { sinceMs: new Date("2026-06-01T00:00:00Z").getTime(), dateOf: e => e.receivedAt });
    assert.deepEqual(out.map(e => e.id), ["1", "2", "3"]);
  });
});

describe("buildBundle — assembly + funnel", () => {
  function deps() {
    return {
      accounts: [
        { id: "biz", accountType: "business" },
        { id: "personal", accountType: "personal" },
      ],
      fetchAllFn: async (accountId) => {
        if (accountId === "biz") return [
          { id: "k1", from: "real@x.com", fromName: "Real", subject: "Re: contract", preview: "hi", receivedAt: "2026-06-05T10:00:00Z", hasListUnsubscribe: false },
          { id: "d1", from: "spam@x.com", fromName: "Spam", subject: "buy", preview: "", receivedAt: "2026-06-05T09:00:00Z", hasListUnsubscribe: true },
          ...Array.from({ length: 4 }, (_, i) => ({ id: "al" + i, from: "defender@microsoft.com", fromName: "Defender", subject: `Attack path #${i}`, preview: "alert", receivedAt: "2026-06-05T08:00:00Z", hasListUnsubscribe: false })),
        ];
        return [{ id: "p1", from: "n@y.com", fromName: "N", subject: "news", preview: "digest", receivedAt: "2026-06-05T07:00:00Z", hasListUnsubscribe: true }];
      },
      classifyFn: (emails) => {
        const r = { categories: {}, deletionCandidates: [], explicitDeletions: [], heuristicDeletions: [] };
        for (const e of emails) {
          if (e.id === "d1") { r.deletionCandidates.push(e); r.explicitDeletions.push(e); }
          else if (e.id.startsWith("al")) { r.deletionCandidates.push(e); r.heuristicDeletions.push(e); }
          else if (e.id === "p1") { r.deletionCandidates.push(e); r.heuristicDeletions.push(e); }
        }
        return r;
      },
      now: "2026-06-05T12:00:00Z",
    };
  }

  it("produces bundle, emailsById (with account), and a reconciling funnel", async () => {
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: deps() });
    assert.equal(out.emailsById["k1"].account, "biz");
    assert.equal(out.emailsById["al0"].account, "biz");
    const f = out.funnel;
    assert.equal(f.fetched, f.explicitDropped + f.survivors + f.heuristicCandidates);
    assert.equal(f.explicitDropped, 1);
    assert.equal(f.survivors, 1);
    assert.equal(f.heuristicCandidates, 5);
    assert.ok(f.collapsed.savedJudgments >= 3, "the 4-alert batch saved >=3 judgments");
    assert.ok(f.reasoningUnits < f.survivors + f.heuristicCandidates, "collapse reduced reasoning units");
  });

  it("warns and continues when one account's fetch throws (no full abort)", async () => {
    const d = {
      accounts: [{ id: "biz", accountType: "business" }, { id: "personal", accountType: "personal" }],
      now: "2026-06-05T12:00:00Z",
      fetchAllFn: async (accountId) => {
        if (accountId === "biz") throw new Error("token expired");
        return [{ id: "p1", from: "n@y.com", fromName: "N", subject: "news", preview: "x", receivedAt: "2026-06-05T07:00:00Z", hasListUnsubscribe: false }];
      },
      classifyFn: () => ({ categories: {}, deletionCandidates: [], explicitDeletions: [], heuristicDeletions: [] }),
    };
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: d });
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /biz.*token expired/);
    // personal still processed → p1 a survivor in the bundle
    assert.ok(out.bundle.find(b => b.msgid === "p1"), "surviving account still built");
    assert.equal(out.funnel.fetched, 1, "only the succeeding account counted");
  });

  it("tags bundle items survivor vs heuristic-delete-candidate and marks representatives", async () => {
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: deps() });
    const k1 = out.bundle.find(b => b.msgid === "k1");
    assert.equal(k1.tag, "survivor");
    const al = out.bundle.filter(b => b.msgid.startsWith("al"));
    assert.ok(al.every(b => b.tag === "heuristic-delete-candidate"));
    assert.equal(al.filter(b => b.group.isRepresentative).length, 1, "exactly one representative in the alert batch");
  });
});

describe("buildBundle — alert-batch surfaces a noise-class proposal", () => {
  function depsBatch() {
    return {
      accounts: [{ id: "biz", accountType: "business" }],
      now: "2026-06-05T12:00:00Z",
      fetchAllFn: async () => Array.from({ length: 5 }, (_, i) => ({
        id: "al" + i, from: "defender@microsoft.com", fromName: "Defender",
        subject: `Attack path #${i}`, preview: "alert", receivedAt: "2026-06-05T08:00:00Z", hasListUnsubscribe: false,
      })),
      classifyFn: (emails) => {
        const r = { categories: {}, deletionCandidates: [], explicitDeletions: [], heuristicDeletions: [] };
        for (const e of emails) { r.deletionCandidates.push(e); r.heuristicDeletions.push(e); }
        return r;
      },
    };
  }
  it("proposes an alwaysDelete for the batch sender, with no pre-existing pending proposal", async () => {
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: depsBatch(), pendingProposals: [] });
    assert.ok(Array.isArray(out.proposals));
    const p = out.proposals.find(p => p.payload && p.payload.value === "defender@microsoft.com");
    assert.ok(p, "proposed alwaysDelete for the batch sender");
    assert.equal(p.target, "companies.biz.alwaysDelete");
    assert.equal(p.status, "pending");
  });
  it("does not re-propose when a pending proposal already covers the sender", async () => {
    const pending = [{ id: "p-1", target: "companies.biz.alwaysDelete", payload: { type: "email", value: "defender@microsoft.com" }, status: "pending" }];
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: depsBatch(), pendingProposals: pending });
    assert.equal((out.proposals || []).length, 0);
  });
  it("assigns proposal IDs that don't collide with same-day existing proposals", async () => {
    const pending = [
      { id: "p-2026-06-05-005", target: "companies.biz.scamPatterns", payload: { subjectAll: ["x"] }, status: "approved" },
    ];
    const out = await buildBundle({ since: "2026-06-01T00:00:00Z", deps: depsBatch(), pendingProposals: pending });
    const p = out.proposals.find(p => p.payload.value === "defender@microsoft.com");
    assert.ok(p, "proposal created");
    assert.equal(p.id, "p-2026-06-05-006", "next id continues from same-day max (006), not length+1 (002)");
  });
});
