import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCardToken, vendorDomain, groupKey } from "./grouping.js";

describe("extractCardToken", () => {
  it("pulls the last four from 'card ending in 4821'", () => {
    assert.equal(extractCardToken("Your card ending in 4821 was declined"), "card_4821");
  });
  it("pulls the last four from masked forms like ****4821 and x-4821", () => {
    assert.equal(extractCardToken("Card ****4821 expired"), "card_4821");
    assert.equal(extractCardToken("card xxxx4821 on file"), "card_4821");
  });
  it("returns null when there is no card reference", () => {
    assert.equal(extractCardToken("Invoice overdue, please remit"), null);
  });
});

describe("vendorDomain", () => {
  it("returns the domain portion of an address", () => {
    assert.equal(vendorDomain("billing@acme.com"), "acme.com");
  });
  it("returns null for a malformed address", () => {
    assert.equal(vendorDomain("not-an-email"), null);
  });
});

describe("groupKey", () => {
  it("prefers the card token when grouping order is [card, vendorDomain]", () => {
    const email = { from: "billing@acme.com", subject: "card ending in 4821 declined", preview: "" };
    assert.equal(groupKey(email, ["card", "vendorDomain"]), "card_4821");
  });
  it("falls back to vendor domain when no card token is present", () => {
    const email = { from: "billing@acme.com", subject: "payment past due", preview: "" };
    assert.equal(groupKey(email, ["card", "vendorDomain"]), "vendor:acme.com");
  });
  it("returns a stable fallback when nothing matches", () => {
    const email = { from: "bad", subject: "", preview: "" };
    assert.equal(groupKey(email, ["card", "vendorDomain"]), "ungrouped");
  });
});
