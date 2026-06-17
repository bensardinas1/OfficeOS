import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runNormalizers } from "./index.js";

const account = { id: "brickell", links: { billing_portal: "https://pay.example/portal" } };
const typeConfig = {
  triageCategories: [{ id: "action", actionable: true }, { id: "fyi" }, { id: "ignore", hidden: true }],
  jobTypes: {
    owed_risk: { sourceCategories: ["action"], failureSignals: ["payment failed", "was declined"], grouping: { order: ["card", "vendorDomain"] }, threshold: { atRiskMembers: 1 } },
    handled: {},
  },
};
const classified = { categories: {
  action: { emails: [
    { id: "e1", from: "billing@acme.com", fromName: "Acme", subject: "Payment failed — card ending in 4821", preview: "" },
    { id: "e2", from: "ar@acme.com", fromName: "Acme", subject: "Your card ending in 4821 was declined", preview: "" },
  ] },
  fyi: { emails: [{ id: "f1" }, { id: "f2" }] },
} };

describe("runNormalizers", () => {
  it("runs every configured job-type and returns the union of items", async () => {
    const items = await runNormalizers(classified, account, typeConfig);
    assert.ok(items.some(i => i.jobType === "owed_risk" && i.group.rootCause === "card_4821"));
    assert.ok(items.some(i => i.jobType === "handled" && i.id === "brickell:handled"));
  });

  it("skips unknown job-types without throwing", async () => {
    const cfg = { ...typeConfig, jobTypes: { ...typeConfig.jobTypes, mystery: {} } };
    const items = await runNormalizers(classified, account, cfg);
    assert.ok(items.length >= 2);
  });

  it("does not call the reasoner when there are no ungrouped stragglers", async () => {
    let called = false;
    const reasonerFn = () => { called = true; return {}; };
    const items = await runNormalizers(classified, account, typeConfig, { reasonerFn });
    assert.ok(items.length >= 2);
    assert.equal(called, false);
  });

  it("runs the gateway job when configured", async () => {
    const cfg = {
      triageCategories: [{ id: "action", actionable: true }, { id: "ignore", hidden: true }],
      jobTypes: { gateway: { sourceCategories: ["action"], recognizers: { nmi: {
        subjectPattern: "\\[NMI Ticket (\\d+)\\]",
        ticketUrlTemplate: "https://support.nmi.com/hc/requests/{ticket}",
        issueKeywords: ["Settlement Batch Failure"],
        resolvedMarkers: ["closing this ticket"],
      } } } },
    };
    const classified = { categories: { action: { emails: [
      { id: "x", subject: "Re: [NMI Ticket 1258855] Settlement Batch Failure", preview: "open issue", receivedAt: "2026-06-10T00:00:00Z" },
    ] } } };
    const items = await runNormalizers(classified, { id: "brickell" }, cfg);
    assert.ok(items.some(i => i.jobType === "gateway" && i.group.rootCause === "nmi:1258855"));
  });
});
