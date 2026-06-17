import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recognizeNmiTicket } from "./nmi.js";

const cfg = {
  subjectPattern: "\\[NMI Ticket (\\d+)\\]",
  ticketUrlTemplate: "https://support.nmi.com/hc/requests/{ticket}",
  issueKeywords: ["Settlement Batch Failure", "Tokenization Error"],
};

describe("recognizeNmiTicket", () => {
  it("extracts ticket, issue type, and builds the ticket URL from the subject", () => {
    const r = recognizeNmiTicket({ subject: "Re: [NMI Ticket 1258855] Fw: [Merchant Notification]WARNING: Settlement Batch Failure", preview: "" }, cfg);
    assert.equal(r.ticket, "1258855");
    assert.equal(r.issueType, "Settlement Batch Failure");
    assert.equal(r.url, "https://support.nmi.com/hc/requests/1258855");
  });

  it("pulls GW ID and merchant from the body when present", () => {
    const r = recognizeNmiTicket({
      subject: "Re: [NMI Ticket 1260651] Tokenization Error - Collect.js - GW ID 1218748",
      preview: "Our customer, Path Peptides (GW ID 1218748) is seeing tokenization errors",
    }, cfg);
    assert.equal(r.ticket, "1260651");
    assert.equal(r.issueType, "Tokenization Error");
    assert.equal(r.gwId, "1218748");
    assert.equal(r.merchant, "Path Peptides");
  });

  it("returns null for a non-NMI email", () => {
    assert.equal(recognizeNmiTicket({ subject: "Lunch?", preview: "" }, cfg), null);
  });
});
