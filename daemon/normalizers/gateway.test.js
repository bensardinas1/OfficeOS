import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeGateway } from "./gateway.js";
import * as nmiMod from "./gateway/nmi.js";

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
    assert.equal(open.acknowledgeable, true);
  });

  it("returns [] when no NMI emails are present", () => {
    assert.deepEqual(normalizeGateway([emails[3]], account, rules), []);
  });

  it("supports a second processor via an injected recognizer registry", () => {
    const fakeRec = (e) => e.subject.includes("[ZZ ") ? { ticket: "9", issueType: "Decline", url: "https://zz.example/9" } : null;
    const rules2 = { recognizers: {
      nmi: { subjectPattern: "\\[NMI Ticket (\\d+)\\]", ticketUrlTemplate: "https://support.nmi.com/hc/requests/{ticket}", issueKeywords: ["Settlement Batch Failure"], resolvedMarkers: ["closing this ticket"] },
      zz: { resolvedMarkers: ["closed"] },
    } };
    const emails2 = [
      { id: "n", subject: "Re: [NMI Ticket 1258855] Settlement Batch Failure", preview: "open", receivedAt: "2026-06-10T00:00:00Z" },
      { id: "z", subject: "[ZZ 9] Decline problem", preview: "open issue", receivedAt: "2026-06-11T00:00:00Z" },
    ];
    const { recognizeNmiTicket } = nmiMod;
    const items = normalizeGateway(emails2, account, rules2, [["nmi", recognizeNmiTicket], ["zz", fakeRec]]);
    assert.ok(items.some(i => i.group.rootCause === "nmi:1258855" && i.group.processor === "nmi"));
    const zz = items.find(i => i.group.rootCause === "zz:9");
    assert.ok(zz, "second processor produced an item");
    assert.equal(zz.group.processor, "zz");
    assert.equal(zz.id, "brickell:gateway:zz:9");
    assert.match(zz.title, /ZZ #9/);
    assert.ok(zz.source.some(s => s.kind === "url" && s.url === "https://zz.example/9"));
  });
});
