import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapGmailMessage } from "../gmail-client.js";
import { detectBulkSignals } from "../classify-emails.js";

// A Gmail users.messages.get resource (the `res.data` object).
function resource(over = {}) {
  return {
    id: "g1", threadId: "t1", internalDate: "1717000000000", snippet: "hello there",
    labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
    payload: { headers: [
      { name: "From", value: "Deals Team <deals@shop.com>" },
      { name: "Subject", value: "Big Sale" },
      { name: "Date", value: "Wed, 29 May 2024 12:00:00 +0000" },
      { name: "List-Unsubscribe", value: "<mailto:u@shop.com>" },
      { name: "Precedence", value: "Bulk" },
      { name: "To", value: "list@shop.com" },
      { name: "Cc", value: "" },
    ] },
    ...over,
  };
}

describe("mapGmailMessage — hydrates bulk signals", () => {
  it("extracts subject/from/fromName, categories (CATEGORY_* only), precedence, recipients", () => {
    const e = mapGmailMessage(resource());
    assert.equal(e.id, "g1");
    assert.equal(e.threadId, "t1");
    assert.equal(e.subject, "Big Sale");
    assert.equal(e.from, "deals@shop.com");
    assert.equal(e.fromName, "Deals Team");
    assert.equal(e.hasListUnsubscribe, true);
    assert.equal(e.precedence, "bulk");
    assert.equal(e.toRecipients, "list@shop.com");
    assert.equal(e.ccRecipients, "");
    assert.deepEqual(e.gmailCategories, ["CATEGORY_PROMOTIONS"]); // INBOX/UNREAD dropped
    assert.equal(e.isRead, false); // UNREAD present
    assert.equal(e.importance, "normal");
  });

  it("parses a bare-address From (no display name)", () => {
    const e = mapGmailMessage(resource({ payload: { headers: [{ name: "From", value: "solo@x.com" }] } }));
    assert.equal(e.from, "solo@x.com");
    assert.equal(e.fromName, "");
  });

  it("receivedAt from internalDate; falls back to Date header when internalDate absent", () => {
    const withId = mapGmailMessage(resource());
    assert.equal(withId.receivedAt, new Date(1717000000000).toISOString());
    const noId = mapGmailMessage(resource({ internalDate: undefined }));
    assert.equal(noId.receivedAt, new Date("Wed, 29 May 2024 12:00:00 +0000").toISOString());
    assert.equal(noId.received, new Date("Wed, 29 May 2024 12:00:00 +0000").toISOString());
  });

  it("flags IMPORTANT and missing labels safely", () => {
    const imp = mapGmailMessage(resource({ labelIds: ["INBOX", "IMPORTANT"] }));
    assert.equal(imp.importance, "high");
    assert.equal(imp.isRead, true); // no UNREAD
    const bare = mapGmailMessage({ id: "g2", payload: { headers: [] } });
    assert.equal(bare.hasListUnsubscribe, false);
    assert.equal(bare.precedence, "");
    assert.equal(bare.toRecipients, "");
    assert.deepEqual(bare.gmailCategories, []);
    assert.equal(bare.importance, "normal");
    assert.equal(bare.isRead, true);
  });

  it("applies opts.previewLimit to the snippet", () => {
    const e = mapGmailMessage(resource({ snippet: "x".repeat(500) }), { previewLimit: 300 });
    assert.equal(e.preview.length, 300);
    const full = mapGmailMessage(resource({ snippet: "x".repeat(500) }));
    assert.equal(full.preview.length, 500);
  });

  it("hydrated signals let a bulk Gmail message reach detectBulkSignals score >=3", () => {
    // CATEGORY_PROMOTIONS + List-Unsubscribe + Precedence:bulk + user-not-in-To = 4 signals.
    const e = mapGmailMessage(resource());
    const { score } = detectBulkSignals(e, "me@personal.com");
    assert.ok(score >= 3, `expected >=3 bulk signals, got ${score}`);
  });
});
