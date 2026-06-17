import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withinLookback, prepareEmails } from "./prepare.js";

const now = Date.parse("2026-06-17T00:00:00Z");

describe("withinLookback", () => {
  it("keeps recent, drops old, fail-opens on missing window or timestamp", () => {
    assert.equal(withinLookback({ received: "2026-06-16T00:00:00Z" }, 168, now), true);   // 1d old, 7d window
    assert.equal(withinLookback({ received: "2026-06-01T00:00:00Z" }, 168, now), false);  // 16d old, 7d window
    assert.equal(withinLookback({ received: "2026-06-01T00:00:00Z" }, 0, now), true);     // no window
    assert.equal(withinLookback({}, 168, now), true);                                     // no timestamp → keep
  });
});

describe("prepareEmails", () => {
  it("filters by lookback and aliases body into preview", () => {
    const emails = [
      { id: "a", received: "2026-06-16T00:00:00Z", preview: "short", body: "FULL BODY TEXT" },
      { id: "b", received: "2026-05-01T00:00:00Z", preview: "old", body: "old body" },
    ];
    const out = prepareEmails(emails, { lookbackHours: 168, nowMs: now });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "a");
    assert.equal(out[0].preview, "FULL BODY TEXT");      // body aliased into preview
    assert.equal(emails[0].preview, "short");            // input not mutated
  });
  it("keeps preview when no body present", () => {
    const out = prepareEmails([{ id: "a", received: "2026-06-16T00:00:00Z", preview: "p" }], { lookbackHours: 168, nowMs: now });
    assert.equal(out[0].preview, "p");
  });
});
