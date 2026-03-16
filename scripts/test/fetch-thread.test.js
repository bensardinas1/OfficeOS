import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transformGraphMessages } from "../fetch-thread.js";

const graphMessages = [
  {
    id: "msg-001",
    conversationId: "thread-xyz",
    subject: "Re: Contract Review",
    from: { emailAddress: { name: "Alice", address: "alice@acme.com" } },
    toRecipients: [{ emailAddress: { name: "Ben", address: "ben@example.com" } }],
    ccRecipients: [],
    receivedDateTime: "2026-03-16T10:00:00Z",
    body: { content: "<p>Please review the attached.</p>", contentType: "html" },
  },
  {
    id: "msg-002",
    conversationId: "thread-xyz",
    subject: "Re: Contract Review",
    from: { emailAddress: { name: "Ben", address: "ben@example.com" } },
    toRecipients: [{ emailAddress: { name: "Alice", address: "alice@acme.com" } }],
    ccRecipients: [{ emailAddress: { name: "Carol", address: "carol@acme.com" } }],
    receivedDateTime: "2026-03-16T11:00:00Z",
    body: { content: "<p>Will do.</p>", contentType: "html" },
  },
];

describe("transformGraphMessages", () => {
  it("returns threadId and subject from first message", () => {
    const result = transformGraphMessages(graphMessages);
    assert.equal(result.threadId, "thread-xyz");
    assert.equal(result.subject, "Re: Contract Review");
  });

  it("maps each message to normalized schema", () => {
    const result = transformGraphMessages(graphMessages);
    assert.equal(result.messages.length, 2);
    const first = result.messages[0];
    assert.equal(first.messageId, "msg-001");
    assert.equal(first.from, "alice@acme.com");
    assert.equal(first.fromName, "Alice");
    assert.deepEqual(first.to, ["ben@example.com"]);
    assert.equal(first.received, "2026-03-16T10:00:00Z");
    assert.ok(first.body.includes("Please review"));
  });

  it("includes cc recipients", () => {
    const result = transformGraphMessages(graphMessages);
    const second = result.messages[1];
    assert.deepEqual(second.cc, ["carol@acme.com"]);
  });

  it("strips html tags from body", () => {
    const result = transformGraphMessages(graphMessages);
    assert.ok(!result.messages[0].body.includes("<p>"));
    assert.ok(result.messages[0].body.includes("Please review the attached."));
  });

  it("returns messages in received order (oldest first)", () => {
    const reversed = [graphMessages[1], graphMessages[0]];
    const result = transformGraphMessages(reversed);
    assert.equal(result.messages[0].messageId, "msg-001");
  });

  it("returns empty result for empty messages array", () => {
    const result = transformGraphMessages([]);
    assert.equal(result.threadId, null);
    assert.deepEqual(result.messages, []);
  });
});
