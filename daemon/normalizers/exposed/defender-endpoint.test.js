import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizeDefenderEndpoint } from "./defender-endpoint.js";

const cfg = { senderDomains: ["microsoft.com"], senderHints: ["defender-noreply"], subjectMarkers: ["vulnerabilit"], portalUrl: "https://security.microsoft.com" };

describe("recognizeDefenderEndpoint", () => {
  it("recognizes a CVE finding deduped by CVE id", () => {
    const f = recognizeDefenderEndpoint({
      from: "defender-noreply@microsoft.com",
      subject: "New vulnerabilities notification from Microsoft Defender for Endpoint",
      preview: "Vulnerability Name CVE-2026-48778 Severity High CVSS 7.8 Affected products Notepad++",
    }, cfg);
    assert.equal(f.source, "defender_endpoint");
    assert.equal(f.severity, "High");
    assert.equal(f.identityKey, "cve:CVE-2026-48778");
    assert.match(f.title, /CVE-2026-48778/);
    assert.equal(f.url, "https://security.microsoft.com");
  });

  it("returns null for a non-Defender-Endpoint email", () => {
    assert.equal(recognizeDefenderEndpoint({ from: "x@y.com", subject: "hi", preview: "" }, cfg), null);
  });
});
