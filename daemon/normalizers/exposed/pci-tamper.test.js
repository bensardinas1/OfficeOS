import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizePciTamper } from "./pci-tamper.js";

const cfg = { senderDomains: ["brickellpay.com"], subjectMarkers: ["tamper detection"], portalUrl: "https://sandbox.payments.brickellpay.com/admin/pci/dashboard" };

const body = 'PCI Tamper Detection Alert {"severity":"HIGH","changes":[{"type":"modified","key":"criticalInputCount","oldValue":2,"newValue":0},{"type":"modified","key":"criticalContentHash","oldValue":"-15f43b28","newValue":"0"}],"compromiseIndicators":["content_injection","dom_manipulation"]} Detected Jun 17, 2026 at 20:12:58 UTC Client IP 67.38.44.241 URL https://sandbox.payments.brickellpay.com/admin/onboarding';

describe("recognizePciTamper", () => {
  it("parses severity, compromise indicators, and a stable id from the JSON body", () => {
    const f = recognizePciTamper({ from: "noreply@brickellpay.com", subject: "[PCI] Tamper Detection alert - HIGH", preview: body }, cfg);
    assert.equal(f.source, "pci_tamper");
    assert.equal(f.severity, "High");
    assert.match(f.title, /content_injection/);
    assert.match(f.identityKey, /^pci:/);
    assert.ok(/brickellpay\.com/.test(f.url));
  });

  it("reads CRITICAL severity from the JSON when present", () => {
    const crit = body.replace('"severity":"HIGH"', '"severity":"CRITICAL"');
    const f = recognizePciTamper({ from: "noreply@brickellpay.com", subject: "[PCI] Tamper Detection alert", preview: crit }, cfg);
    assert.equal(f.severity, "Critical");
  });

  it("falls back to subject severity when JSON severity is absent", () => {
    const f = recognizePciTamper({ from: "noreply@brickellpay.com", subject: "[PCI] Tamper Detection alert - HIGH", preview: "PCI Tamper Detection Alert (no json) URL https://sandbox.payments.brickellpay.com/x" }, cfg);
    assert.equal(f.severity, "High");
  });

  it("gives different ids to different change-sets, same id to identical re-alerts", () => {
    const a = recognizePciTamper({ from: "noreply@brickellpay.com", subject: "[PCI] x", preview: body }, cfg);
    const a2 = recognizePciTamper({ from: "noreply@brickellpay.com", subject: "[PCI] x", preview: body }, cfg);
    const diff = body.replace("criticalInputCount", "formCount").replace("criticalContentHash", "scriptCount");
    const b = recognizePciTamper({ from: "noreply@brickellpay.com", subject: "[PCI] x", preview: diff }, cfg);
    assert.equal(a.identityKey, a2.identityKey);     // identical re-alert merges
    assert.notEqual(a.identityKey, b.identityKey);   // different tampered keys → distinct
  });

  it("returns null when sender/subject don't match", () => {
    assert.equal(recognizePciTamper({ from: "x@y.com", subject: "hi", preview: "" }, cfg), null);
  });
});
