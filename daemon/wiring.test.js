import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCtxFor, resolvePollMs } from "./wiring.js";

const companies = { companies: [
  { id: "brickell", provider: "outlook", links: { billing_portal: "https://pay.example/portal" }, pollMinutes: 10 },
  { id: "personal", provider: "gmail" },
] };

describe("resolvePollMs", () => {
  it("uses per-account pollMinutes when present", () => {
    assert.equal(resolvePollMs(companies.companies[0], 15), 10 * 60 * 1000);
  });
  it("falls back to the default when absent", () => {
    assert.equal(resolvePollMs(companies.companies[1], 15), 15 * 60 * 1000);
  });
});

describe("buildCtxFor", () => {
  it("returns the account and a saveDraftFn for a proposal's account", () => {
    const saveDraftFn = async () => ({ draftId: "d1" });
    const ctxFor = buildCtxFor(companies.companies, () => saveDraftFn);
    const ctx = ctxFor({ params: { account: "brickell" } });
    assert.equal(ctx.account.id, "brickell");
    assert.equal(typeof ctx.saveDraftFn, "function");
  });
  it("throws for an unknown account", () => {
    const ctxFor = buildCtxFor(companies.companies, () => async () => ({}));
    assert.throws(() => ctxFor({ params: { account: "ghost" } }), /unknown account/i);
  });
});
