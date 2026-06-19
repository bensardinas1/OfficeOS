import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { removeSenderFromKillList } from "../killlist-remove.js";

function cfg() {
  return { companies: [ { id: "brickell", alwaysDelete: [
    { type: "email", value: "promo@x.com", label: "added from panel" },
    { type: "domain", value: "ads.example.com", label: "keep" },
  ] } ] };
}

describe("removeSenderFromKillList", () => {
  it("removes a matching email-exact rule", () => {
    const r = removeSenderFromKillList(cfg(), "brickell", "Promo@X.com");
    assert.equal(r.removed, true);
    assert.ok(!r.cfg.companies[0].alwaysDelete.some(x => x.value === "promo@x.com"));
    assert.ok(r.cfg.companies[0].alwaysDelete.some(x => x.value === "ads.example.com"));
  });
  it("is a no-op with a reason when the sender is not on the list", () => {
    const r = removeSenderFromKillList(cfg(), "brickell", "nobody@x.com");
    assert.equal(r.removed, false);
    assert.match(r.reason, /not on the kill-list/i);
  });
  it("refuses an unknown account", () => {
    assert.equal(removeSenderFromKillList(cfg(), "ghost", "x@y.com").removed, false);
  });
});
