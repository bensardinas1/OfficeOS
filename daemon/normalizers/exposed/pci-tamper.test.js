import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizePciTamper } from "./pci-tamper.js";

const cfg = { senderDomains: ["brickellpay.com"], subjectMarkers: ["tamper detection"], portalUrl: "https://sandbox.payments.brickellpay.com/admin/pci/dashboard" };

const body = 'PCI Tamper Detection Alert {"severity":"HIGH","changes":[{"type":"modified","key":"criticalInputCount","oldValue":2,"newValue":0},{"type":"modified","key":"criticalContentHash","oldValue":"-15f43b28","newValue":"0"}],"compromiseIndicators":["content_injection","dom_manipulation"]} Detected Jun 17, 2026 at 20:12:58 UTC Client IP 67.38.44.241 URL https://sandbox.payments.brickellpay.com/admin/onboarding';

describe("recognizePciTamper", () => {
  it("parses severity and rolls up to one id + stable title per severity", () => {
    const f = recognizePciTamper({ from: "noreply@brickellpay.com", subject: "[PCI] Tamper Detection alert - HIGH", preview: body }, cfg);
    assert.equal(f.source, "pci_tamper");
    assert.equal(f.severity, "High");
    assert.equal(f.title, "High · PCI tamper");
    assert.equal(f.identityKey, "pci:tamper:high");
    assert.ok(/brickellpay\.com/.test(f.url));
  });

  it("reads CRITICAL severity from the JSON when present", () => {
    const crit = body.replace('"severity":"HIGH"', '"severity":"CRITICAL"');
    const f = recognizePciTamper({ from: "noreply@brickellpay.com", subject: "[PCI] Tamper Detection alert", preview: crit }, cfg);
    assert.equal(f.severity, "Critical");
    assert.equal(f.identityKey, "pci:tamper:critical");
  });

  it("falls back to subject severity when JSON severity is absent", () => {
    const f = recognizePciTamper({ from: "noreply@brickellpay.com", subject: "[PCI] Tamper Detection alert - HIGH", preview: "PCI Tamper Detection Alert (no json) URL https://sandbox.payments.brickellpay.com/x" }, cfg);
    assert.equal(f.severity, "High");
  });

  it("merges all same-severity alerts into one card and separates severities", () => {
    const a = recognizePciTamper({ from: "noreply@brickellpay.com", subject: "[PCI] x", preview: body }, cfg);
    const diffKeys = body.replace("criticalInputCount", "formCount").replace("criticalContentHash", "scriptCount");
    const a2 = recognizePciTamper({ from: "noreply@brickellpay.com", subject: "[PCI] x", preview: diffKeys }, cfg);
    const crit = recognizePciTamper({ from: "noreply@brickellpay.com", subject: "[PCI] x", preview: body.replace('"severity":"HIGH"', '"severity":"CRITICAL"') }, cfg);
    assert.equal(a.identityKey, a2.identityKey);      // same severity, different change-sets → still one card
    assert.notEqual(a.identityKey, crit.identityKey); // different severity → distinct card
  });

  it("returns null when sender/subject don't match", () => {
    assert.equal(recognizePciTamper({ from: "x@y.com", subject: "hi", preview: "" }, cfg), null);
  });
});
