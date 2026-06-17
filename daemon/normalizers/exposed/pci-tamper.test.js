import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizePciTamper } from "./pci-tamper.js";

const cfg = { senderDomains: ["brickellpay.com"], subjectMarkers: ["tamper detection"], portalUrl: "https://sandbox.payments.brickellpay.com/admin/pci/dashboard" };

describe("recognizePciTamper", () => {
  it("recognizes a PCI tamper alert with severity, type, and a deduped id", () => {
    const f = recognizePciTamper({
      from: "noreply@brickellpay.com",
      subject: "[PCI] Tamper Detection alert - HIGH",
      preview: "PCI Tamper Detection Alert SEVERITY HIGH TYPE CONTENT_MODIFICATION URL https://sandbox.payments.brickellpay.com/admin/pci/dashboard",
    }, cfg);
    assert.equal(f.source, "pci_tamper");
    assert.equal(f.severity, "High");
    assert.match(f.identityKey, /^pci:/);
    assert.match(f.title, /tamper/i);
    assert.ok(/brickellpay\.com/.test(f.url));
  });

  it("returns null when sender or subject doesn't match", () => {
    assert.equal(recognizePciTamper({ from: "x@y.com", subject: "hi", preview: "" }, cfg), null);
  });
});
