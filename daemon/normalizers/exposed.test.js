import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeExposed } from "./exposed.js";

const account = { id: "brickell" };
const rules = {
  atRiskSeverities: ["Critical", "High"],
  recognizers: {
    defenderCloud: { senderDomains: ["microsoft.com"], senderHints: ["mssecurity-noreply"], subjectMarkers: ["attack path"], portalUrl: "https://portal.azure.com" },
    defenderEndpoint: { senderDomains: ["microsoft.com"], senderHints: ["defender-noreply"], subjectMarkers: ["vulnerabilit"], portalUrl: "https://security.microsoft.com" },
    pciTamper: { senderDomains: ["brickellpay.com"], subjectMarkers: ["tamper detection"], portalUrl: "https://pci.example/dashboard" },
    entra: { senderDomains: ["microsoft.com"], senderHints: ["azure-noreply"], subjectMarkers: ["entra id protection"] },
  },
};

const emails = [
  { id: "a", from: "MSSecurity-noreply@microsoft.com", subject: "Microsoft Defender for Cloud found potential attack path in your environment", preview: "Risk level: Critical. Attack path ID 7a226bfd-a239-5699-a4dc-0aba63478b99", receivedAt: "2026-06-16T00:00:00Z" },
  { id: "b", from: "defender-noreply@microsoft.com", subject: "New vulnerabilities notification from Microsoft Defender for Endpoint", preview: "Vulnerability Name CVE-2026-48778 Severity High CVSS 7.8 Notepad++", receivedAt: "2026-06-09T00:00:00Z" },
  { id: "c", from: "azure-noreply@microsoft.com", subject: "Microsoft Entra ID Protection Weekly Digest", preview: "New risky users detected 0 New risky sign-ins detected 0", receivedAt: "2026-06-15T00:00:00Z" },
  { id: "d", from: "ar@globex.com", subject: "unrelated", preview: "nothing", receivedAt: "2026-06-15T00:00:00Z" },
];

describe("normalizeExposed", () => {
  it("emits findings for attack-path + CVE, suppresses the clean Entra digest and unrelated mail", () => {
    const items = normalizeExposed(emails, account, rules);
    const keys = items.map(i => i.group.rootCause).sort();
    assert.deepEqual(keys, ["attackpath:7a226bfd-a239-5699-a4dc-0aba63478b99", "cve:CVE-2026-48778"]);
  });

  it("maps Critical/High to at_risk, sets acknowledgeable + link-out source + stable id", () => {
    const items = normalizeExposed(emails, account, rules);
    const cve = items.find(i => i.group.rootCause === "cve:CVE-2026-48778");
    assert.equal(cve.jobType, "exposed");
    assert.equal(cve.status, "at_risk");
    assert.equal(cve.acknowledgeable, true);
    assert.equal(cve.id, "brickell:exposed:cve:CVE-2026-48778");
    assert.ok(cve.source.some(s => s.kind === "url" && /security\.microsoft\.com/.test(s.url)));
  });

  it("dedupes the same finding seen in two emails", () => {
    const dup = [...emails, { ...emails[1], id: "b2", receivedAt: "2026-06-10T00:00:00Z" }];
    const items = normalizeExposed(dup, account, rules);
    assert.equal(items.filter(i => i.group.rootCause === "cve:CVE-2026-48778").length, 1);
  });

  it("returns [] when nothing matches", () => {
    assert.deepEqual(normalizeExposed([emails[3]], account, rules), []);
  });
});
