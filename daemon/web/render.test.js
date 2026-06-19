import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderHeader, renderItemCard, renderAccountSection, renderDetailPanel, renderUndoBar, relativeTime, safeUrl } from "./render.js";

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
  it("shows the jobType chip, primary sender, message count, and a Details button", () => {
    const gw = {
      id: "brickell:gateway:nmi:1260651", account: "brickell", jobType: "gateway",
      title: "NMI #1260651 · Tokenization Error", status: "at_risk",
      group: { rootCause: "nmi:1260651", members: [{ subject: "Re: [NMI Ticket 1260651]", emailId: "c", from: "support@nmi.com", fromName: "NMI Support", receivedAt: "2026-06-18T10:00:00Z" }] },
      display: { primarySender: "NMI Support", messageCount: 1, latestDate: "2026-06-18T10:00:00Z", accountLabel: "Brickell Pay", accountType: "business" },
      source: [{ kind: "url", url: "https://support.nmi.com/hc/requests/1260651" }], proposals: [],
    };
    const html = renderItemCard(gw, Date.parse("2026-06-18T12:00:00Z"));
    assert.match(html, /class="chip">gateway</);
    assert.match(html, /NMI Support/);
    assert.match(html, /1 message/);
    assert.match(html, /2h ago/);
    assert.match(html, /data-detail="brickell:gateway:nmi:1260651"/);
  });
  it("does not render member subjects on the card (they belong in the detail panel)", () => {
    const gw = {
      id: "x", account: "brickell", jobType: "gateway", title: "T", status: "ok",
      group: { rootCause: "r", members: [{ subject: "SECRET-SUBJECT", emailId: "c", from: "a@b.com", fromName: "Bee" }] },
      display: { primarySender: "Bee", messageCount: 1, latestDate: null, accountLabel: "Brickell Pay" },
      source: [], proposals: [],
    };
    assert.doesNotMatch(renderItemCard(gw, 0), /SECRET-SUBJECT/);
  });
  it("labels the draft_chase approve action in plain language (not the raw id)", () => {
    const html = renderItemCard(item);
    assert.match(html, /✓ Draft a follow-up email/);
    assert.doesNotMatch(html, /Approve draft_chase/);
  });
  it("renders a SUMMARY chip and the subtitle for a handled summary tile", () => {
    const handled = {
      id: "brickell:handled", account: "brickell", jobType: "handled",
      title: "99 need a reply or decision", subtitle: "+ 73 informational", status: "ok",
      group: { rootCause: "handled", members: [] }, display: { messageCount: 0, latestDate: null }, source: [], proposals: [],
    };
    const html = renderItemCard(handled, 0);
    assert.match(html, /class="chip">summary</);   // CSS uppercases to SUMMARY
    assert.doesNotMatch(html, /class="chip">handled</);
    assert.match(html, /99 need a reply or decision/);
    assert.match(html, /\+ 73 informational/);
  });
  it("escapes HTML in display.primarySender (untrusted sender name)", () => {
    const evil = { ...item, jobType: "gateway",
      display: { primarySender: "<img src=x onerror=alert(1)>", messageCount: 1, latestDate: null },
      proposals: [], source: [] };
    const html = renderItemCard(evil, 0);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img/);
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

describe("renderDetailPanel", () => {
  const item = {
    id: "brickell:gateway:nmi:1260651", account: "brickell", jobType: "gateway",
    title: "NMI #1260651 · Tokenization Error", status: "at_risk",
    display: { accountLabel: "Brickell Pay", accountType: "business" },
    group: { rootCause: "nmi:1260651", merchant: "Path Peptides", members: [
      { subject: "First message", from: "support@nmi.com", fromName: "NMI Support", emailId: "a", receivedAt: "2026-06-17T00:00:00Z" },
      { subject: "Second message", from: "support@nmi.com", fromName: "NMI Support", emailId: "b", receivedAt: "2026-06-18T00:00:00Z" },
    ] },
    source: [{ kind: "url", url: "https://support.nmi.com/hc/requests/1260651" }, { kind: "thread", emailId: "a" }],
  };
  it("renders inbox label, root cause, status, job-specific fields, messages, and a safe link-out", () => {
    const html = renderDetailPanel(item, Date.parse("2026-06-18T12:00:00Z"));
    assert.match(html, /Brickell Pay/);
    assert.match(html, /nmi:1260651/);
    assert.match(html, /at risk/);
    assert.match(html, /Path Peptides/);
    assert.match(html, /First message/);
    assert.match(html, /Second message/);
    assert.match(html, /NMI Support/);
    assert.match(html, /href="https:\/\/support\.nmi\.com\/hc\/requests\/1260651"/);
    assert.match(html, /data-detail-close/);
  });
  it("orders messages newest-first", () => {
    const html = renderDetailPanel(item, Date.parse("2026-06-18T12:00:00Z"));
    assert.ok(html.indexOf("Second message") < html.indexOf("First message"),
      "the 06-18 message should render before the 06-17 message");
  });
  it("rejects a non-http link-out and escapes message subjects + sender names", () => {
    const evil = { ...item, source: [{ kind: "url", url: "javascript:alert(1)" }],
      group: { ...item.group, members: [{ subject: "<img src=x onerror=alert(1)>", fromName: "<script>alert(2)</script>", from: "a@b.com", emailId: "a", receivedAt: "2026-06-18T00:00:00Z" }] } };
    const html = renderDetailPanel(evil, 0);
    assert.doesNotMatch(html, /javascript:alert/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;img/);
    assert.match(html, /&lt;script/);
  });
  it("returns empty string for a null item", () => {
    assert.equal(renderDetailPanel(null, 0), "");
  });
  it("renders a lazy body placeholder per message keyed by emailId", () => {
    const html = renderDetailPanel(item, Date.parse("2026-06-18T12:00:00Z"));
    assert.match(html, /data-body-for="a"/);
    assert.match(html, /data-body-for="b"/);
    assert.match(html, /bodyload/);
  });
});

describe("renderAccountSection", () => {
  const group = {
    account: "brickell", label: "Brickell Pay", accountType: "business", atRiskCount: 2,
    items: [
      { id: "i1", account: "brickell", jobType: "gateway", title: "Item one", status: "at_risk", group: { rootCause: "r1", members: [] }, display: { primarySender: "NMI", messageCount: 1, latestDate: null }, source: [], proposals: [] },
    ],
  };
  it("renders a collapse header with label, type, and need-you count, plus the cards when expanded", () => {
    const html = renderAccountSection(group, false, 0);
    assert.match(html, /data-collapse="brickell"/);
    assert.match(html, /Brickell Pay/);
    assert.match(html, /business/);
    assert.match(html, /2 need you/);
    assert.match(html, /Item one/);
  });
  it("omits the card body when collapsed", () => {
    const html = renderAccountSection(group, true, 0);
    assert.match(html, /data-collapse="brickell"/);
    assert.doesNotMatch(html, /Item one/);
  });
});

describe("renderUndoBar", () => {
  it("renders the label and an Undo button when an undo is offered", () => {
    const html = renderUndoBar({ label: "Dismissed", undoUrl: "/proposals/p1/reopen" });
    assert.match(html, /Dismissed/);
    assert.match(html, /data-undo/);
  });
  it("renders nothing when there is no undo", () => {
    assert.equal(renderUndoBar(null), "");
  });
  it("escapes the label", () => {
    assert.match(renderUndoBar({ label: "<img src=x>", undoUrl: "/x" }), /&lt;img/);
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
  it("treats the 7-day boundary as exclusive (falls to short date)", () => {
    assert.equal(relativeTime("2026-06-11T12:00:00Z", now), "Jun 11");
  });
  it("returns empty string for missing/invalid input", () => {
    assert.equal(relativeTime(null, now), "");
    assert.equal(relativeTime("not-a-date", now), "");
  });
});
