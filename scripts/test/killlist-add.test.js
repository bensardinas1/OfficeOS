import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addSenderToKillList } from "../killlist-add.js";

function cfg() {
  return { companies: [
    { id: "brickell", myEmail: "me@brickellpay.com", neverDelete: [], alwaysDelete: [] },
  ] };
}

describe("addSenderToKillList", () => {
  it("appends an email-exact rule for a new sender", () => {
    const r = addSenderToKillList(cfg(), "brickell", "Promo@News.Example.com");
    assert.equal(r.added, true);
    const rules = r.cfg.companies[0].alwaysDelete;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].type, "email");
    assert.equal(rules[0].value, "promo@news.example.com");
    assert.match(rules[0].label, /panel/i);
  });
  it("refuses a sender already on the kill-list (dedupe)", () => {
    const c = cfg();
    c.companies[0].alwaysDelete = [{ type: "email", value: "promo@news.example.com" }];
    const r = addSenderToKillList(c, "brickell", "promo@news.example.com");
    assert.equal(r.added, false);
    assert.match(r.reason, /already/i);
  });
  it("refuses a protected sender (own domain / neverDelete)", () => {
    const c = cfg();
    c.companies[0].neverDelete = [{ type: "domain", value: "vip.example.com" }];
    assert.equal(addSenderToKillList(c, "brickell", "ceo@vip.example.com").added, false);
    assert.equal(addSenderToKillList(c, "brickell", "x@brickellpay.com").added, false);
  });
  it("refuses a correspondent the user has emailed", () => {
    const corr = new Set(["friend@example.com"]);
    const r = addSenderToKillList(cfg(), "brickell", "friend@example.com", { correspondents: corr });
    assert.equal(r.added, false);
    assert.match(r.reason, /correspond/i);
  });
  it("refuses an unknown account", () => {
    assert.equal(addSenderToKillList(cfg(), "ghost", "x@y.com").added, false);
  });
});
