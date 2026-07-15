import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../validate-config.js";

const TYPES = { business: {}, personal: {} };
const okAccount = (over = {}) => ({
  id: "acme", provider: "outlook", accountType: "business", myEmail: "me@acme.com", ...over,
});
const wrap = (accounts) => ({ companies: accounts });
const errorsOf = (f) => f.filter(x => x.level === "error");
const warningsOf = (f) => f.filter(x => x.level === "warning");

describe("validateConfig", () => {
  it("returns no findings for a clean config", () => {
    assert.deepEqual(validateConfig(wrap([okAccount()]), TYPES), []);
  });

  it("errors when companies.json has no companies array (and never throws)", () => {
    for (const bad of [null, {}, { companies: "x" }]) {
      const f = validateConfig(bad, TYPES);
      assert.equal(errorsOf(f).length >= 1, true, JSON.stringify(bad));
    }
  });

  it("errors on missing id, bad provider, unknown accountType, malformed myEmail", () => {
    const f = validateConfig(wrap([
      okAccount({ id: "" }),
      okAccount({ id: "b", provider: "imap" }),
      okAccount({ id: "c", accountType: "corporate" }),
      okAccount({ id: "d", myEmail: "not-an-email" }),
    ]), TYPES);
    const paths = errorsOf(f).map(x => x.path).join("|");
    assert.match(paths, /\.id/); assert.match(paths, /\.provider/);
    assert.match(paths, /\.accountType/); assert.match(paths, /\.myEmail/);
  });

  it("warns (not errors) when myEmail is absent", () => {
    const f = validateConfig(wrap([okAccount({ myEmail: undefined })]), TYPES);
    assert.equal(errorsOf(f).length, 0);
    assert.equal(warningsOf(f).length, 1);
    assert.match(f[0].path, /myEmail/);
  });

  it("errors on sender rules with unknown type or empty value, in every list", () => {
    const f = validateConfig(wrap([okAccount({
      prioritySenders: [{ type: "bogus", value: "x" }],
      neverDelete: [{ type: "email", value: "" }],
      alwaysDelete: [{ type: "domain" }],
    })]), TYPES);
    const paths = errorsOf(f).map(x => x.path).join("|");
    assert.match(paths, /prioritySenders\[0\]\.type/);
    assert.match(paths, /neverDelete\[0\]\.value/);
    assert.match(paths, /alwaysDelete\[0\]\.value/);
  });

  it("errors on non-array or non-string urgency flags", () => {
    const f1 = validateConfig(wrap([okAccount({ urgencyRules: { flags: "need" } })]), TYPES);
    assert.match(errorsOf(f1)[0].path, /urgencyRules\.flags/);
    const f2 = validateConfig(wrap([okAccount({ urgencyRules: { flags: ["ok", "", 3] } })]), TYPES);
    assert.equal(errorsOf(f2).length, 2);
  });

  it("warns on duplicate account ids", () => {
    const f = validateConfig(wrap([okAccount(), okAccount()]), TYPES);
    assert.equal(warningsOf(f).length, 1);
    assert.match(f[0].message, /duplicate/i);
  });

  it("warns when the same sender is in both alwaysDelete and neverDelete", () => {
    const f = validateConfig(wrap([okAccount({
      alwaysDelete: [{ type: "email", value: "Spam@x.com" }],
      neverDelete: [{ type: "email", value: "spam@X.com" }],
    })]), TYPES);
    assert.equal(warningsOf(f).length, 1);
    assert.match(f[0].message, /neverDelete/);
  });

  it("warns on a non-positive bulkSignalThreshold", () => {
    const f = validateConfig(wrap([okAccount({ bulkSignalThreshold: 0 })]), TYPES);
    assert.equal(warningsOf(f).length, 1);
  });

  it("validates rules inside categoryOverrides too", () => {
    const f = validateConfig(wrap([okAccount({ categoryOverrides: [
      { id: "vip", prioritySenders: [{ type: "nope", value: "x" }], urgencyRules: { flags: [""] } },
    ] })]), TYPES);
    const paths = errorsOf(f).map(x => x.path).join("|");
    assert.match(paths, /categoryOverrides\[0\]\.prioritySenders\[0\]\.type/);
    assert.match(paths, /categoryOverrides\[0\]\.urgencyRules\.flags\[0\]/);
  });

  it("survives a null account entry with a finding, not a throw", () => {
    const f = validateConfig(wrap([null, okAccount()]), TYPES);
    assert.equal(errorsOf(f).length, 1);
  });
});
