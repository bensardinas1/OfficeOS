import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTriage } from "./triage.js";

const account = { id: "brickell" };
const cands = [
  { number: 1, id: "e1", accountId: "brickell", provider: "outlook", sender: "Promo Co", from: "promo@x.com", subject: "Sale", receivedAt: "2026-06-10T00:00:00Z" },
  { number: 2, id: "e2", accountId: "brickell", provider: "outlook", sender: "News", from: "news@y.com", subject: "Digest", receivedAt: "2026-06-12T00:00:00Z" },
  { number: 3, id: "e9", accountId: "other", provider: "gmail", sender: "X", from: "x@z.com", subject: "nope", receivedAt: "2026-06-11T00:00:00Z" },
];

describe("normalizeTriage", () => {
  it("emits one Cleanup item for the account's candidates, newest-first", () => {
    const items = normalizeTriage(cands, account);
    assert.equal(items.length, 1);
    const it0 = items[0];
    assert.equal(it0.id, "brickell:triage");
    assert.equal(it0.jobType, "triage");
    assert.equal(it0.status, "ok");
    assert.match(it0.title, /2 to clean up/);
    assert.equal(it0.group.members.length, 2);
    assert.equal(it0.group.members[0].emailId, "e2");
    assert.equal(it0.group.members[0].from, "news@y.com");
    assert.equal(it0.group.members[0].fromName, "News");
    assert.ok(!it0.group.members.some(m => m.emailId === "e9"));
  });
  it("returns [] when the account has no candidates", () => {
    assert.deepEqual(normalizeTriage(cands, { id: "empty" }), []);
    assert.deepEqual(normalizeTriage([], account), []);
    assert.deepEqual(normalizeTriage(null, account), []);
  });
  it("caps at 50 and reports moreCount", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, accountId: "brickell", sender: "S", from: "s@x.com", subject: `s${i}`, receivedAt: `2026-06-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z` }));
    const it0 = normalizeTriage(many, account)[0];
    assert.equal(it0.group.members.length, 50);
    assert.equal(it0.group.moreCount, 10);
  });
});
