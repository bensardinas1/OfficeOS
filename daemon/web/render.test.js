import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderHeader, renderItemCard, renderAccountSection, renderDetailPanel, renderUndoBar, renderNoticeBar, renderRunTriage, renderBulkBar, renderConfigWarnings, relativeTime, safeUrl } from "./render.js";

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
    assert.match(html, /data-select="item:brickell:owed_risk:card_4821"/);
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

describe("detail body scaling", () => {
  const mk = (n) => ({
    id: "brickell:handled", account: "brickell", jobType: "handled", title: "T", status: "ok",
    display: { accountLabel: "Brickell Pay" },
    group: { rootCause: "handled", moreCount: n > 50 ? n - 50 : 0, members: Array.from({ length: Math.min(n, 50) }, (_, i) => ({ subject: `s${i}`, from: `a${i}@x.com`, fromName: "X", emailId: `e${i}`, receivedAt: `2026-06-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z` })) },
    source: [], proposals: [],
  });
  it("auto-loads bodies when ≤5 messages (data-body-for, no toggle)", () => {
    const html = renderDetailPanel(mk(3), 0);
    assert.match(html, /data-body-for="e0"/);
    assert.doesNotMatch(html, /data-loadbody/);
  });
  it("uses click-to-expand when >5 messages (data-loadbody + hidden body)", () => {
    const html = renderDetailPanel(mk(8), 0);
    assert.match(html, /data-loadbody="e0"/);
    assert.match(html, /Show message/);
    assert.match(html, /data-body-for="e0" hidden/);
  });
  it("shows a '+N more' note when moreCount > 0", () => {
    assert.match(renderDetailPanel(mk(60), 0), /\+ 10 more/);
  });
});

describe("renderRunTriage", () => {
  it("renders a Run triage button, disabled+labelled while running", () => {
    assert.match(renderRunTriage(false), /data-run-triage/);
    assert.match(renderRunTriage(false), /Run triage/);
    assert.match(renderRunTriage(true), /disabled/);
    assert.match(renderRunTriage(true), /Running/);
  });
  it("renders the window override radios + days field, field disabled in default mode", () => {
    const html = renderRunTriage(false, { mode: "default", days: "10" });
    assert.match(html, /data-triage-mode="default"[^>]* checked/);
    assert.match(html, /id="triagedays"[^>]*value="10"/);
    assert.match(html, /id="triagedays"[^>]* disabled/); // field disabled when not custom
  });
  it("enables the days field and checks custom when mode is custom", () => {
    const html = renderRunTriage(false, { mode: "custom", days: "10" });
    assert.match(html, /data-triage-mode="custom"[^>]* checked/);
    assert.doesNotMatch(html.match(/id="triagedays"[^>]*>/)[0], /disabled/);
  });
  it("shows the last successful run with scope and window in days", () => {
    const html = renderRunTriage(false, { last: { at: "2026-07-15T15:07:00Z", action: "triage", account: null, result: { ok: true, lookbackHours: 720 } } });
    assert.match(html, /class="triagelast"/);
    assert.match(html, /Last triage:/);
    assert.match(html, /· all · ok \(30d\)/);
    assert.doesNotMatch(html, /failed/);
  });
  it("names the account for a per-account run and omits the window when default", () => {
    const html = renderRunTriage(false, { last: { at: "2026-07-15T15:07:00Z", account: "brickellpay", result: { ok: true, lookbackHours: null } } });
    assert.match(html, /· brickellpay · ok</);
  });
  it("shows a failed run with its error, marked and escaped", () => {
    const html = renderRunTriage(false, { last: { at: "2026-07-15T15:07:00Z", account: null, result: { error: "<boom>" } } });
    assert.match(html, /class="triagelast failed"/);
    assert.match(html, /failed: &lt;boom&gt;/);
  });
  it("renders no last-run label without an entry or with an unparseable timestamp", () => {
    assert.doesNotMatch(renderRunTriage(false, {}), /triagelast/);
    assert.doesNotMatch(renderRunTriage(false, { last: { at: "not-a-date", result: { ok: true } } }), /triagelast/);
  });
});

describe("renderBulkBar", () => {
  it("renders nothing at 0 selected", () => assert.equal(renderBulkBar(0), ""));
  it("renders count, action buttons, and Clear", () => {
    const html = renderBulkBar(3, {});
    assert.match(html, /3 selected/);
    for (const attr of ["data-bulk-approve", "data-bulk-delete", "data-bulk-kill", "data-bulk-delkill", "data-bulk-undo", "data-bulk-clear"]) assert.match(html, new RegExp(attr));
    assert.match(html, /data-token="bulk:delete"/);
  });
  it("shows armed confirm labels via the shared confirm machinery", () => {
    assert.match(renderBulkBar(2, { confirm: "bulk:delete" }), /Confirm delete\?/);
  });
  it("shows only progress while a bulk run is in flight", () => {
    const html = renderBulkBar(2, { bulkBusy: { done: 1, total: 4 } });
    assert.match(html, /Working \(1\/4\)/);
    assert.doesNotMatch(html, /data-bulk-delete/);
  });
});

describe("acted state + delete-and-kill", () => {
  const gw = {
    id: "brickell:gateway:nmi:1", account: "brickell", jobType: "gateway", title: "T", status: "at_risk",
    group: { rootCause: "r", members: [{ subject: "s", emailId: "e1", from: "support@nmi.com", fromName: "NMI" }] },
    display: { primarySender: "NMI", messageCount: 1, latestDate: null, accountLabel: "Brickell Pay" },
    source: [], proposals: [],
  };
  it("renders a Delete and Kill button on a card", () => {
    assert.match(renderItemCard(gw, 0), /data-delkill="brickell"/);
    assert.match(renderItemCard(gw, 0), /Delete and Kill/);
  });
  it("renders a Kill button on a card with data-ids for server-derivable state", () => {
    assert.match(renderItemCard(gw, 0), /data-killlist="brickell"[^>]*data-ids="e1"/);
  });
  it("dims an acted tile with a badge + Undo instead of action buttons", () => {
    const html = renderItemCard(gw, 0, { acted: { "brickell:gateway:nmi:1": { deleted: true, killed: true } } });
    assert.match(html, /class="card[^"]*acted/);
    assert.match(html, /Deleted \+ kill-listed/);
    assert.match(html, /data-undo-acted="brickell:gateway:nmi:1"/);
    assert.doesNotMatch(html, /data-delete=/);
  });
  it("dims an acted detail row with the right badge", () => {
    const html = renderDetailPanel(gw, 0, { acted: { e1: { deleted: true } } });
    assert.match(html, /data-undo-acted="e1"/);
    assert.match(html, /Deleted/);
  });
  it("derives tile acted state from member rows when every member is acted (post-reload hydration)", () => {
    const gw2 = {
      id: "brickell:gateway:nmi:2", account: "brickell", jobType: "gateway", title: "T", status: "at_risk",
      group: { rootCause: "r", members: [
        { subject: "s1", emailId: "e1", from: "support@nmi.com", fromName: "NMI" },
        { subject: "s2", emailId: "e2", from: "support@nmi.com", fromName: "NMI" },
      ] },
      display: { primarySender: "NMI", messageCount: 2, latestDate: null, accountLabel: "Brickell Pay" },
      source: [], proposals: [],
    };
    const acted = {
      e1: { deleted: true, account: "brickell", emailIds: ["e1"], deleteEntryId: "a1" },
      e2: { deleted: true, account: "brickell", emailIds: ["e2"], deleteEntryId: "a2" },
    };
    const html = renderItemCard(gw2, 0, { acted });
    assert.match(html, /class="card[^"]*acted/);
    assert.match(html, /Deleted/);
    assert.doesNotMatch(html, /data-undo-acted=/, "synthesized tile must not render a tile-level Undo");
    assert.match(html, /data-detail="/, "synthesized tile must keep Details (route to the per-row Undos)");
  });
  it("does not derive tile acted state when only some members are acted", () => {
    const gw2 = {
      id: "brickell:gateway:nmi:2", account: "brickell", jobType: "gateway", title: "T", status: "at_risk",
      group: { rootCause: "r", members: [
        { subject: "s1", emailId: "e1", from: "support@nmi.com", fromName: "NMI" },
        { subject: "s2", emailId: "e2", from: "support@nmi.com", fromName: "NMI" },
      ] },
      display: { primarySender: "NMI", messageCount: 2, latestDate: null, accountLabel: "Brickell Pay" },
      source: [], proposals: [],
    };
    const acted = { e1: { deleted: true, account: "brickell", emailIds: ["e1"], deleteEntryId: "a1" } };
    const html = renderItemCard(gw2, 0, { acted });
    assert.doesNotMatch(html, /class="card[^"]*acted/);
  });
});

describe("destructive buttons + confirm", () => {
  const gw = {
    id: "brickell:gateway:nmi:1", account: "brickell", jobType: "gateway", title: "T", status: "at_risk",
    group: { rootCause: "r", members: [{ subject: "s", emailId: "e1", from: "support@nmi.com", fromName: "NMI" }] },
    display: { primarySender: "NMI", messageCount: 1, latestDate: null, accountLabel: "Brickell Pay" },
    source: [], proposals: [],
  };
  it("renders Delete + Kill list buttons on a card", () => {
    const html = renderItemCard(gw, 0);
    assert.match(html, /data-delete="brickell"/);
    assert.match(html, /data-killlist="brickell"/);
    assert.match(html, /Delete/);
    assert.match(html, /Kill list/);
  });
  it("shows a confirm label when the confirm token matches", () => {
    const html = renderItemCard(gw, 0, { confirm: "del:tile:brickell:gateway:nmi:1" });
    assert.match(html, /Confirm/);
  });
  it("shows a disabled Working… button while the busy token matches (in flight)", () => {
    const token = "del:tile:brickell:gateway:nmi:1";
    const html = renderItemCard(gw, 0, { busy: token });
    const btn = html.match(new RegExp(`<button[^>]*data-token="${token}"[^>]*>[^<]*</button>`))[0];
    assert.match(btn, /Working…/);
    assert.match(btn, /disabled/);
    assert.doesNotMatch(btn, /Confirm/);
  });
  it("renderNoticeBar shows a message + empty when null", () => {
    assert.match(renderNoticeBar("Moved 2 to Trash"), /Moved 2 to Trash/);
    assert.equal(renderNoticeBar(null), "");
  });
});

describe("sender-clustered detail (handled/triage)", () => {
  const handled = {
    id: "brickellpay:handled", account: "brickellpay", jobType: "handled", title: "T", status: "ok",
    display: { accountLabel: "Brickell Pay" },
    group: { rootCause: "handled", members: [
      { subject: "s1", from: "noreply@brickellpay.com", fromName: "Brickell Pay", emailId: "e1", receivedAt: "2026-06-20T00:00:00Z" },
      { subject: "s2", from: "noreply@brickellpay.com", fromName: "Brickell Pay", emailId: "e2", receivedAt: "2026-06-21T00:00:00Z" },
      { subject: "s3", from: "hello@secureframe.com", fromName: "Secureframe", emailId: "e3", receivedAt: "2026-06-19T00:00:00Z" },
    ] },
    source: [], proposals: [],
  };
  it("groups by sender with a header count and per-cluster bulk buttons", () => {
    const html = renderDetailPanel(handled, 0);
    assert.match(html, /Brickell Pay \(2\)/);
    assert.match(html, /Secureframe \(1\)/);
    assert.match(html, /data-delete-sender="brickellpay" data-ids="e1,e2" data-sender="noreply@brickellpay\.com"/);
    assert.match(html, /data-token="delall:cluster:brickellpay:noreply@brickellpay\.com"/);
    assert.doesNotMatch(html, /data-delete="brickellpay"/, "cluster delete-all must not emit the old data-delete attr");
    assert.match(html, /data-killlist="brickellpay" data-ids="e1,e2" data-sender="noreply@brickellpay.com"/);
    assert.match(html, /data-delkill="brickellpay"/);
    assert.doesNotMatch(html, /del:msg:e1/);
  });
  it("keeps finding tiles flat with per-row buttons", () => {
    const gw = { id: "brickellpay:gateway:nmi:1", account: "brickellpay", jobType: "gateway", title: "T", status: "at_risk",
      group: { rootCause: "r", members: [{ subject: "s", emailId: "e1", from: "support@nmi.com", fromName: "NMI" }] }, display: {}, source: [], proposals: [] };
    assert.match(renderDetailPanel(gw, 0), /del:msg:e1/);
  });
  it("renders per-row kill buttons with data-ids in flat detail branch", () => {
    const gw = { id: "brickellpay:gateway:nmi:1", account: "brickellpay", jobType: "gateway", title: "T", status: "at_risk",
      group: { rootCause: "r", members: [{ subject: "s", emailId: "e1", from: "support@nmi.com", fromName: "NMI" }] }, display: {}, source: [], proposals: [] };
    assert.match(renderDetailPanel(gw, 0), /data-killlist="brickellpay"[^>]*data-ids="e1"/);
  });

  const convHandled = {
    id: "brickellpay:handled", account: "brickellpay", jobType: "handled", title: "T", status: "ok",
    display: { accountLabel: "Brickell Pay" },
    group: { rootCause: "handled", members: [
      { subject: "Path Peptides underwriting", from: "luis@brickellpay.com", fromName: "Luis", emailId: "c1", receivedAt: "2026-07-01T00:00:00Z", conversationId: "cv-1", automated: false },
      { subject: "RE: Path Peptides underwriting", from: "mckenna@partner.com", fromName: "McKenna", emailId: "c2", receivedAt: "2026-07-02T00:00:00Z", conversationId: "cv-1", automated: false },
      { subject: "New order #1", from: "noise@wp.com", fromName: "WP", emailId: "n1", receivedAt: "2026-07-03T00:00:00Z", conversationId: null, automated: true },
    ] },
    source: [], proposals: [],
  };
  it("renders handled drill-in as Conversations + Bulk senders with typed checkboxes", () => {
    const html = renderDetailPanel(convHandled, 0);
    assert.match(html, /Conversations/);
    assert.match(html, /Bulk senders/);
    assert.match(html, /data-select="conv:brickellpay:cv-1"/);
    assert.match(html, /Path Peptides underwriting/);
    assert.match(html, /2 messages · 2 senders/);
    assert.match(html, /data-select="cluster:brickellpay:noise@wp.com"/);
    // conversation rows keep sender attribution and appear once (not scattered into clusters)
    assert.doesNotMatch(html, /data-select="cluster:brickellpay:luis@brickellpay.com"/);
  });
  it("omits the Conversations section when all members are automated", () => {
    const noisy = { ...convHandled, group: { ...convHandled.group, members: convHandled.group.members.filter(m => m.automated) } };
    const html = renderDetailPanel(noisy, 0);
    assert.doesNotMatch(html, /Conversations/);
    assert.match(html, /Bulk senders/);
  });
  it("triage tiles keep clusters only, now with cluster checkboxes", () => {
    const tri = { ...convHandled, id: "x:triage", jobType: "triage" };
    const html = renderDetailPanel(tri, 0);
    assert.doesNotMatch(html, /Conversations/);
    assert.match(html, /data-select="cluster:brickellpay:/);
  });
});

describe("renderConfigWarnings", () => {
  const f = [
    { level: "error", path: "companies[x].provider", message: "bad provider" },
    { level: "warning", path: "companies[x].myEmail", message: "missing" },
  ];
  it("renders nothing when clean", () => {
    assert.equal(renderConfigWarnings([], false), "");
    assert.equal(renderConfigWarnings(undefined, false), "");
  });
  it("collapsed: shows the count and the toggle attr, not the details", () => {
    const html = renderConfigWarnings(f, false);
    assert.match(html, /config: 2 issues/);
    assert.match(html, /data-cfgwarn-toggle/);
    assert.doesNotMatch(html, /bad provider/);
  });
  it("open: lists each finding's path and message, marking warnings", () => {
    const html = renderConfigWarnings(f, true);
    assert.match(html, /companies\[x\]\.provider/);
    assert.match(html, /bad provider/);
    assert.match(html, /\(warning\)/);
  });
  it("singular copy for one finding, and escapes content", () => {
    const one = [{ level: "error", path: "<p>", message: "<m>" }];
    assert.match(renderConfigWarnings(one, false), /config: 1 issue\b/);
    const html = renderConfigWarnings(one, true);
    assert.doesNotMatch(html, /<p>/);
    assert.match(html, /&lt;p&gt;/);
  });
});
