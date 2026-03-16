import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRfc2822Message } from "../save-gmail-draft.js";

function decodeRaw(raw) {
  // Gmail uses base64url (- instead of +, _ instead of /)
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

describe("buildRfc2822Message", () => {
  it("includes To, Subject, and body in output", () => {
    const raw = buildRfc2822Message({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Hello",
      body: "Hi Alice",
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("To: alice@acme.com"));
    assert.ok(decoded.includes("Subject: Hello"));
    assert.ok(decoded.includes("Hi Alice"));
  });

  it("includes CC header when cc is provided", () => {
    const raw = buildRfc2822Message({
      to: ["alice@acme.com"],
      cc: ["carol@acme.com"],
      subject: "Test",
      body: "Hello",
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("Cc: carol@acme.com"));
  });

  it("omits CC header when cc is empty", () => {
    const raw = buildRfc2822Message({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Test",
      body: "Hello",
    });
    const decoded = decodeRaw(raw);
    assert.ok(!decoded.includes("Cc:"));
  });

  it("sets Content-Type to text/plain utf-8", () => {
    const raw = buildRfc2822Message({
      to: ["alice@acme.com"],
      cc: [],
      subject: "Test",
      body: "Hello",
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("Content-Type: text/plain; charset=utf-8"));
  });

  it("handles multiple To recipients", () => {
    const raw = buildRfc2822Message({
      to: ["alice@acme.com", "bob@acme.com"],
      cc: [],
      subject: "Test",
      body: "Hello",
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("alice@acme.com") && decoded.includes("bob@acme.com"));
  });
});
