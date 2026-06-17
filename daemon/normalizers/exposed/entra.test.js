import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizeEntra } from "./entra.js";

const cfg = { senderDomains: ["microsoft.com"], senderHints: ["azure-noreply"], subjectMarkers: ["entra id protection", "identity protection"] };

describe("recognizeEntra", () => {
  it("suppresses a clean digest (0 risky users and 0 risky sign-ins)", () => {
    const f = recognizeEntra({
      from: "azure-noreply@microsoft.com",
      subject: "Microsoft Entra ID Protection Weekly Digest",
      preview: "New risky users detected 0 New risky sign-ins detected 0",
    }, cfg);
    assert.equal(f, null);
  });

  it("surfaces a digest with non-zero risky users", () => {
    const f = recognizeEntra({
      from: "azure-noreply@microsoft.com",
      subject: "Microsoft Entra ID Protection Weekly Digest",
      preview: "New risky users detected 3 New risky sign-ins detected 0",
    }, cfg);
    assert.ok(f);
    assert.equal(f.source, "entra");
    assert.match(f.title, /3/);
  });

  it("returns null for a non-Entra email", () => {
    assert.equal(recognizeEntra({ from: "x@y.com", subject: "hi", preview: "" }, cfg), null);
  });
});
