import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksAutomated, findAccount, isProtectedSender, MARKETING_SUBDOMAINS } from "../sender-guards.js";

describe("looksAutomated", () => {
  it("flags common automated local-parts", () => {
    for (const a of ["noreply@x.com", "no-reply@x.com", "donotreply@x.com", "notifications@x.com", "alert@x.com", "mailer-daemon@x.com", "billing.noreply@x.com", "alerts+sec@x.com"])
      assert.equal(looksAutomated(a, false), true, a);
  });
  it("does not flag human/processor local-parts", () => {
    for (const a of ["jared.kernodle@p.com", "luis@brickellpay.com", "support@tsys.com", "defender@microsoft.com"])
      assert.equal(looksAutomated(a, false), false, a);
  });
  it("treats List-Unsubscribe as automated regardless of local-part", () => {
    assert.equal(looksAutomated("jane@vendor.com", true), true);
  });
});

describe("findAccount", () => {
  it("finds by id, undefined when absent", () => {
    const accts = [{ id: "a" }, { id: "b" }];
    assert.equal(findAccount(accts, "b").id, "b");
    assert.equal(findAccount(accts, "z"), undefined);
    assert.equal(findAccount(undefined, "a"), undefined);
  });
});

describe("isProtectedSender", () => {
  const account = { myEmail: "me@brickellpay.com", prioritySenders: [{ type: "email", value: "partner@bigco.com" }], neverDelete: [{ type: "domain", value: "processor.com" }] };
  it("protects internal domain, priority email, neverDelete domain", () => {
    assert.equal(isProtectedSender(account, "noreply@brickellpay.com"), true);
    assert.equal(isProtectedSender(account, "partner@bigco.com"), true);
    assert.equal(isProtectedSender(account, "alerts@processor.com"), true);
  });
  it("does not protect unrelated sender or missing account", () => {
    assert.equal(isProtectedSender(account, "noreply@random.com"), false);
    assert.equal(isProtectedSender(undefined, "noreply@x.com"), false);
  });
});

describe("looksAutomated with marketing subdomains", () => {
  it("treats marketing-subdomain senders as automated (signal in the domain)", () => {
    for (const a of [
      "capitalone@notification.capitalone.com",
      "americanexpress@welcome.americanexpress.com",
      "team@alerts.vendor.io",
      "x@e.chase.com",
    ]) assert.equal(looksAutomated(a, false), true, a);
  });

  it("plain domains stay human", () => {
    for (const a of ["jane@vendor.com", "luis@brickell.example", "ben@enterprise-co.com"]) {
      assert.equal(looksAutomated(a, false), false, a);
    }
  });

  it("exports the shared MARKETING_SUBDOMAINS list", () => {
    assert.ok(Array.isArray(MARKETING_SUBDOMAINS));
    assert.ok(MARKETING_SUBDOMAINS.includes("notification."));
    assert.ok(MARKETING_SUBDOMAINS.includes("noreply."));
  });
});
