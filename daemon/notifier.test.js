import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideNotification, buildToastPowerShell, notify } from "./notifier.js";

describe("decideNotification", () => {
  it("notifies about newly at-risk items", () => {
    const note = decideNotification({ newAtRisk: [{ title: "2 failed payments — one root cause" }], staleFlips: [] });
    assert.ok(note);
    assert.match(note.title, /need you|OfficeOS/i);
    assert.match(note.body, /2 failed payments/);
  });
  it("notifies when an account goes stale", () => {
    const note = decideNotification({ newAtRisk: [], staleFlips: ["summit"] });
    assert.ok(note);
    assert.match(note.body, /summit/i);
  });
  it("returns null when nothing is toast-worthy", () => {
    assert.equal(decideNotification({ newAtRisk: [], staleFlips: [] }), null);
  });
});

describe("notify (no-op paths)", () => {
  it("returns nothing-toast-worthy on an empty diff (no spawn)", () => {
    assert.deepEqual(notify({ newAtRisk: [], staleFlips: [] }), { shown: false, reason: "nothing-toast-worthy" });
  });
  it("returns not-windows on a non-win32 platform (no spawn)", () => {
    const r = notify({ newAtRisk: [{ title: "x" }], staleFlips: [] }, { platform: "linux" });
    assert.equal(r.shown, false);
    assert.equal(r.reason, "not-windows");
  });
});

describe("buildToastPowerShell", () => {
  it("produces a script embedding the title and body, no send/delete tokens", () => {
    const ps = buildToastPowerShell("OfficeOS — 2 need you", 'card "4821" <x>');
    assert.match(ps, /ToastNotificationManager/);
    assert.match(ps, /OfficeOS/);
    assert.doesNotMatch(ps, /sendMail|messages\.send|messages\.delete/i);
  });
  it("escapes single quotes to prevent script breakout", () => {
    const ps = buildToastPowerShell("it's fine", "a'b");
    assert.match(ps, /it''s fine/);
    assert.match(ps, /a''b/);
  });
});
