import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractGmailBody } from "../fetch-message.js";

const b64 = (s) => Buffer.from(s, "utf-8").toString("base64");

describe("extractGmailBody", () => {
  it("prefers text/plain", () => {
    const payload = { mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { data: b64("hello plain") } },
      { mimeType: "text/html", body: { data: b64("<p>hello html</p>") } },
    ] };
    assert.equal(extractGmailBody(payload), "hello plain");
  });
  it("falls back to stripped text/html when no plain part", () => {
    const payload = { mimeType: "text/html", body: { data: b64("<p>hi <b>there</b></p>") } };
    assert.equal(extractGmailBody(payload), "hi there");
  });
  it("recurses into nested parts", () => {
    const payload = { mimeType: "multipart/mixed", parts: [
      { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/plain", body: { data: b64("nested plain") } },
      ] },
    ] };
    assert.equal(extractGmailBody(payload), "nested plain");
  });
  it("returns empty string for an empty/absent payload", () => {
    assert.equal(extractGmailBody(null), "");
    assert.equal(extractGmailBody({ mimeType: "text/plain" }), "");
  });
});
