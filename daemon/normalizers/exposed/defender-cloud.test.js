import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizeDefenderCloud } from "./defender-cloud.js";

const cfg = { senderDomains: ["microsoft.com"], senderHints: ["mssecurity-noreply"], subjectMarkers: ["attack path"], portalUrl: "https://portal.azure.com" };

describe("recognizeDefenderCloud", () => {
  it("recognizes an attack-path finding with severity and a stable id", () => {
    const f = recognizeDefenderCloud({
      from: "MSSecurity-noreply@microsoft.com",
      subject: "Microsoft Defender for Cloud found potential attack path in your environment",
      preview: "Internet exposed Azure VM with high severity vulnerabilities allows lateral movement. Risk level: Critical. Attack path ID 7a226bfd-a239-5699-a4dc-0aba63478b99",
    }, cfg);
    assert.equal(f.source, "defender_cloud");
    assert.equal(f.severity, "Critical");
    assert.equal(f.identityKey, "attackpath:7a226bfd-a239-5699-a4dc-0aba63478b99");
    assert.equal(f.url, "https://portal.azure.com");
    assert.match(f.title, /attack path/i);
  });

  it("returns null for a non-Defender-Cloud email", () => {
    assert.equal(recognizeDefenderCloud({ from: "x@y.com", subject: "hi", preview: "" }, cfg), null);
  });
});
