import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizeSecureframe } from "./secureframe.js";

const cfg = {
  senderDomains: ["secureframe.com"],
  baseUrl: "https://app.secureframe.com",
  actionRequiredMarkers: ["action required"],
  commentMarkers: ["new comment", "added a new comment"],
  resolvedMarkers: ["ready for review", "test passed"],
};

describe("recognizeSecureframe", () => {
  it("recognizes an action-required email and extracts the test name", () => {
    const r = recognizeSecureframe({
      from: "hello@secureframe.com",
      subject: "Your auditor marked a test as Action required",
      preview: "Your auditor manually updated the test Load balancers for cloud infrastructure traffic (Azure) to Action required. Please review.",
    }, cfg);
    assert.equal(r.subType, "action_required");
    assert.equal(r.testName, "Load balancers for cloud infrastructure traffic (Azure)");
    assert.equal(r.url, "https://app.secureframe.com");
  });

  it("recognizes a comment/upload request", () => {
    const r = recognizeSecureframe({
      from: "hello@secureframe.com",
      subject: "New comment from your auditor",
      preview: "Your auditor added a new comment on the test Load balancers for cloud infrastructure traffic (Azure). Please upload screenshots / configs.",
    }, cfg);
    assert.equal(r.subType, "comment");
    assert.equal(r.testName, "Load balancers for cloud infrastructure traffic (Azure)");
  });

  it("prefers a secureframe URL from the body when present", () => {
    const r = recognizeSecureframe({
      from: "hello@secureframe.com",
      subject: "Your auditor marked a test as Action required",
      preview: "updated the test Foo to Action required. View test: https://app.secureframe.com/tests/abc123",
    }, cfg);
    assert.equal(r.url, "https://app.secureframe.com/tests/abc123");
  });

  it("returns null for a non-Secureframe email", () => {
    assert.equal(recognizeSecureframe({ from: "ar@globex.com", subject: "hi", preview: "" }, cfg), null);
  });
});
