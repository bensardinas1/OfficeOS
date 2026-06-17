import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderHeader, renderItemCard, safeUrl } from "./render.js";

const item = {
  id: "brickell:owed_risk:card_4821", account: "brickell",
  title: "2 failed payments — one root cause", status: "at_risk",
  group: { rootCause: "card_4821", members: [{ vendor: "Acme" }, { vendor: "Globex" }] },
  source: [{ kind: "url", url: "https://pay.example/portal" }],
  proposals: [{ id: "brickell:owed_risk:card_4821::draft_chase", action: "draft_chase", state: "pending", preview: { drafts: [{}, {}] } }],
};

describe("renderHeader", () => {
  it("shows the needs-you count and a stale warning when present", () => {
    assert.match(renderHeader({ needsYouCount: 3, pendingCount: 2, staleAccounts: [] }), /3/);
    assert.match(renderHeader({ needsYouCount: 0, pendingCount: 0, staleAccounts: ["summit"] }), /summit/i);
  });
});

describe("renderItemCard", () => {
  it("renders the title, root cause, and an approve button wired to the pending proposal id", () => {
    const html = renderItemCard(item);
    assert.match(html, /one root cause/);
    assert.match(html, /card_4821/);
    assert.match(html, /data-approve="brickell:owed_risk:card_4821::draft_chase"/);
    assert.match(html, /data-route="https:\/\/pay\.example\/portal"/);
  });
  it("escapes HTML in titles to prevent injection", () => {
    const evil = { ...item, title: "<img src=x onerror=alert(1)>", proposals: [], source: [] };
    const html = renderItemCard(evil);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img/);
  });
  it("does not render a javascript: url as a route link", () => {
    const evil = { ...item, source: [{ kind: "url", url: "javascript:alert(1)" }] };
    const html = renderItemCard(evil);
    assert.doesNotMatch(html, /javascript:alert/);
    assert.doesNotMatch(html, /data-route=/);
  });
  it("renders an https route link normally", () => {
    const html = renderItemCard(item);
    assert.match(html, /data-route="https:\/\/pay\.example\/portal"/);
  });
});

describe("safeUrl", () => {
  it("allows http(s) and rejects everything else", () => {
    assert.equal(safeUrl("https://x.com"), "https://x.com");
    assert.equal(safeUrl("http://x.com"), "http://x.com");
    assert.equal(safeUrl("javascript:alert(1)"), null);
    assert.equal(safeUrl("data:text/html,x"), null);
    assert.equal(safeUrl(undefined), null);
  });
});
