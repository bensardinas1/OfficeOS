import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOutlookMessageBody } from "../save-draft.js";

describe("buildOutlookMessageBody", () => {
  it("sets subject, HTML body, and toRecipients", () => {
    const payload = buildOutlookMessageBody({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Following up",
      body: "Hi Alice,\n\nJust checking in.\n\nRegards,\n\nBen",
    });
    assert.equal(payload.subject, "Following up");
    assert.equal(payload.body.contentType, "HTML");
    assert.ok(payload.body.content.includes("Just checking in."));
    assert.equal(payload.toRecipients.length, 1);
    assert.equal(payload.toRecipients[0].emailAddress.address, "alice@acme.com");
  });

  it("converts plain text body to HTML preserving line breaks", () => {
    const payload = buildOutlookMessageBody({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Test",
      body: "Line one\n\nLine two",
    });
    assert.ok(payload.body.content.includes("<br>") || payload.body.content.includes("<p>"));
  });

  it("includes cc recipients when provided", () => {
    const payload = buildOutlookMessageBody({
      to: ["alice@acme.com"],
      cc: ["carol@acme.com", "dave@acme.com"],
      subject: "Test",
      body: "Hello",
    });
    assert.equal(payload.ccRecipients.length, 2);
    assert.equal(payload.ccRecipients[0].emailAddress.address, "carol@acme.com");
  });

  it("produces empty ccRecipients when cc is empty", () => {
    const payload = buildOutlookMessageBody({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Test",
      body: "Hello",
    });
    assert.deepEqual(payload.ccRecipients, []);
  });

  it("marks message as draft", () => {
    const payload = buildOutlookMessageBody({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Test",
      body: "Hello",
    });
    assert.equal(payload.isDraft, true);
  });
});
