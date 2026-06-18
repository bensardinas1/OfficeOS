import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAudit } from "./audit.js";

const account = { id: "brickell" };
const rules = { recognizers: { secureframe: {
  senderDomains: ["secureframe.com"], baseUrl: "https://app.secureframe.com",
  actionRequiredMarkers: ["action required"], commentMarkers: ["new comment", "added a new comment"],
  resolvedMarkers: ["ready for review"],
} } };

const emails = [
  { id: "a", from: "hello@secureframe.com", fromName: "Secureframe", subject: "Your auditor marked a test as Action required",
    preview: "Your auditor manually updated the test Load balancers for cloud infrastructure traffic (Azure) to Action required.", receivedAt: "2026-06-15T00:00:00Z" },
  { id: "b", from: "hello@secureframe.com", fromName: "Secureframe", subject: "New comment from your auditor",
    preview: "Your auditor added a new comment on the test Load balancers for cloud infrastructure traffic (Azure). Please upload screenshots.", receivedAt: "2026-06-16T00:00:00Z" },
  { id: "c", from: "ar@globex.com", subject: "unrelated", preview: "nothing", receivedAt: "2026-06-16T00:00:00Z" },
];

describe("normalizeAudit", () => {
  it("groups both auditor emails for one test into a single at_risk item", () => {
    const items = normalizeAudit(emails, account, rules);
    assert.equal(items.length, 1);
    const it0 = items[0];
    assert.equal(it0.jobType, "audit");
    assert.equal(it0.status, "at_risk");
    assert.match(it0.id, /^brickell:audit:/);
    assert.match(it0.title, /Load balancers/);
    assert.equal(it0.group.members.length, 2);
    assert.ok(it0.source.some(s => s.kind === "url" && /secureframe\.com/.test(s.url)));
    assert.equal(it0.acknowledgeable, true);
  });

  it("carries member sender + date through for tile context", () => {
    const m = normalizeAudit(emails, account, rules)[0].group.members.find(x => x.emailId === "a");
    assert.equal(m.from, "hello@secureframe.com");
    assert.equal(m.fromName, "Secureframe");
    assert.equal(m.receivedAt, "2026-06-15T00:00:00Z");
  });

  it("returns [] when there are no Secureframe emails", () => {
    assert.deepEqual(normalizeAudit([emails[2]], account, rules), []);
  });
});
