import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeGateway } from "./gateway.js";

const account = { id: "brickell" };
const rules = {
  recognizers: { nmi: {
    subjectPattern: "\\[NMI Ticket (\\d+)\\]",
    ticketUrlTemplate: "https://support.nmi.com/hc/requests/{ticket}",
    issueKeywords: ["Settlement Batch Failure", "Tokenization Error"],
    resolvedMarkers: ["closing this ticket"],
  } },
};

const emails = [
  { id: "a", subject: "Re: [NMI Ticket 1258855] Settlement Batch Failure", preview: "How do we proceed?", receivedAt: "2026-06-10T00:00:00Z" },
  { id: "b", subject: "Re: [NMI Ticket 1258855] Settlement Batch Failure", preview: "I'll be proceeding with closing this ticket.", receivedAt: "2026-06-13T00:00:00Z" },
  { id: "c", subject: "Re: [NMI Ticket 1260651] Tokenization Error - GW ID 1218748", preview: "Our customer, Path Peptides (GW ID 1218748) is seeing tokenization errors", receivedAt: "2026-06-11T00:00:00Z" },
  { id: "d", subject: "Team lunch", preview: "tomorrow?", receivedAt: "2026-06-12T00:00:00Z" },
];

describe("normalizeGateway", () => {
  it("groups a thread into one item per ticket and drops non-NMI mail", () => {
    const items = normalizeGateway(emails, account, rules);
    const ids = items.map(i => i.group.rootCause).sort();
    assert.deepEqual(ids, ["nmi:1258855", "nmi:1260651"]);
    const t1 = items.find(i => i.group.rootCause === "nmi:1258855");
    assert.equal(t1.group.members.length, 2);
  });

  it("marks a resolved ticket ok and an open ticket at_risk, with title + url", () => {
    const items = normalizeGateway(emails, account, rules);
    const resolved = items.find(i => i.group.rootCause === "nmi:1258855");
    const open = items.find(i => i.group.rootCause === "nmi:1260651");
    assert.equal(resolved.status, "ok");
    assert.equal(open.status, "at_risk");
    assert.equal(open.id, "brickell:gateway:nmi:1260651");
    assert.match(open.title, /1260651/);
    assert.match(open.title, /Tokenization Error/);
    assert.match(open.title, /Path Peptides|1218748/);
    assert.ok(open.source.some(s => s.kind === "url" && s.url === "https://support.nmi.com/hc/requests/1260651"));
  });

  it("returns [] when no NMI emails are present", () => {
    assert.deepEqual(normalizeGateway([emails[3]], account, rules), []);
  });
});
