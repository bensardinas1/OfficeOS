import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderHeader, renderItemCard, relativeTime, safeUrl } from "./render.js";

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
  it("renders an Acknowledge button for acknowledgeable items carrying a fingerprint", () => {
    const ackable = { ...item, proposals: [], acknowledgeable: true, fingerprint: "fp1" };
    const html = renderItemCard(ackable);
    assert.match(html, /data-ack="brickell:owed_risk:card_4821"/);
    assert.match(html, /data-fp="fp1"/);
    assert.match(html, /Acknowledge/);
  });
  it("omits Acknowledge for non-acknowledgeable items", () => {
    assert.doesNotMatch(renderItemCard(item), /data-ack=/);
  });
  it("falls back to member subject when there is no vendor (gateway items), no empty commas", () => {
    const gw = {
      id: "brickell:gateway:nmi:1260651", account: "brickell",
      title: "NMI #1260651 · Tokenization Error", status: "at_risk",
      group: { rootCause: "nmi:1260651", members: [{ subject: "Re: [NMI Ticket 1260651] Tokenization Error", emailId: "c" }] },
      source: [{ kind: "url", url: "https://support.nmi.com/hc/requests/1260651" }],
      proposals: [],
    };
    const html = renderItemCard(gw);
    assert.match(html, /Tokenization Error/);
    assert.doesNotMatch(html, /· <\/div>/);   // meta is not left dangling with an empty member list
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

describe("relativeTime", () => {
  const now = Date.parse("2026-06-18T12:00:00Z");
  it("buckets seconds/minutes/hours/days and falls back to a short date", () => {
    assert.equal(relativeTime("2026-06-18T11:59:30Z", now), "just now");
    assert.equal(relativeTime("2026-06-18T11:30:00Z", now), "30m ago");
    assert.equal(relativeTime("2026-06-18T09:00:00Z", now), "3h ago");
    assert.equal(relativeTime("2026-06-16T12:00:00Z", now), "2d ago");
    assert.equal(relativeTime("2026-06-01T12:00:00Z", now), "Jun 1");
  });
  it("returns empty string for missing/invalid input", () => {
    assert.equal(relativeTime(null, now), "");
    assert.equal(relativeTime("not-a-date", now), "");
  });
});
