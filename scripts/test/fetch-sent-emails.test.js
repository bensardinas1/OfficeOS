// scripts/test/fetch-sent-emails.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transformSentEmails, isOriginalEmail } from "../fetch-sent-emails.js";

describe("isOriginalEmail", () => {
  it("returns true for a normal sent email", () => {
    assert.equal(isOriginalEmail({ subject: "Contract Review", body: "Please review." }), true);
  });

  it("rejects forwarded emails (FW: prefix)", () => {
    assert.equal(isOriginalEmail({ subject: "FW: Meeting notes", body: "See below." }), false);
  });

  it("rejects forwarded emails (Fwd: prefix, case-insensitive)", () => {
    assert.equal(isOriginalEmail({ subject: "fwd: Budget doc", body: "FYI." }), false);
  });

  it("rejects auto-replies", () => {
    assert.equal(isOriginalEmail({ subject: "Re: Hello", body: "I am currently out of office." }), false);
  });

  it("rejects calendar accepts", () => {
    assert.equal(isOriginalEmail({ subject: "Accepted: Team Standup", body: "" }), false);
  });

  it("rejects calendar declines", () => {
    assert.equal(isOriginalEmail({ subject: "Declined: Lunch meeting", body: "" }), false);
  });

  it("rejects automatic reply markers", () => {
    assert.equal(isOriginalEmail({ subject: "Re: Question", body: "This is an automatic reply." }), false);
  });
});

describe("transformSentEmails", () => {
  const graphMessages = [
    {
      id: "sent-001",
      subject: "Contract Review",
      toRecipients: [{ emailAddress: { address: "alice@acme.com" } }],
      ccRecipients: [{ emailAddress: { address: "carol@acme.com" } }],
      sentDateTime: "2026-03-16T12:00:00Z",
      body: { content: "<p>Please review the attached.</p>", contentType: "html" },
    },
    {
      id: "sent-002",
      subject: "FW: Old document",
      toRecipients: [{ emailAddress: { address: "bob@acme.com" } }],
      ccRecipients: [],
      sentDateTime: "2026-03-16T13:00:00Z",
      body: { content: "See attached.", contentType: "text" },
    },
  ];

  it("maps sent messages to normalized schema", () => {
    const result = transformSentEmails(graphMessages);
    assert.equal(result.length, 1); // FW: email filtered out
    assert.equal(result[0].subject, "Contract Review");
    assert.deepEqual(result[0].to, ["alice@acme.com"]);
    assert.deepEqual(result[0].cc, ["carol@acme.com"]);
    assert.equal(result[0].sent, "2026-03-16T12:00:00Z");
  });

  it("strips HTML from body", () => {
    const result = transformSentEmails(graphMessages);
    assert.ok(!result[0].body.includes("<p>"));
    assert.ok(result[0].body.includes("Please review the attached."));
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(transformSentEmails([]), []);
    assert.deepEqual(transformSentEmails(null), []);
  });

  it("handles messages with undefined body", () => {
    const result = transformSentEmails([{
      id: "sent-003",
      subject: "Quick note",
      toRecipients: [{ emailAddress: { address: "alice@acme.com" } }],
      ccRecipients: [],
      sentDateTime: "2026-03-16T14:00:00Z",
      body: undefined,
    }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].body, "");
  });
});
