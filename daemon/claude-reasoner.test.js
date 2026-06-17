import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeReasonerFn } from "./claude-reasoner.js";
import { regroupStragglers } from "./normalizers/regroup.js";

describe("makeReasonerFn", () => {
  it("builds a prompt, runs claude, and returns the parsed grouping map", async () => {
    const seen = {};
    const runClaude = (prompt) => { seen.prompt = prompt; return '{"e1":"acct:acme","e2":"acct:globex"}'; };
    const reasonerFn = makeReasonerFn(runClaude);
    const map = await reasonerFn([
      { emailId: "e1", from: "billing@acme.com", subject: "Overdue" },
      { emailId: "e2", from: "dun@globex.io", subject: "Final" },
    ]);
    assert.match(seen.prompt, /e1/);          // emailId appears in the prompt
    assert.deepEqual(map, { e1: "acct:acme", e2: "acct:globex" });
  });

  it("returns {} when claude output is unparseable (never throws)", async () => {
    const reasonerFn = makeReasonerFn(() => "no json here");
    assert.deepEqual(await reasonerFn([{ emailId: "e1" }]), {});
  });

  it("returns {} when runClaude throws (never throws)", async () => {
    const reasonerFn = makeReasonerFn(() => { throw new Error("claude missing"); });
    assert.deepEqual(await reasonerFn([{ emailId: "e1" }]), {});
  });
});

describe("end-to-end: makeReasonerFn drives regroupStragglers", () => {
  it("a claude response keyed by emailId actually splits the ungrouped item", async () => {
    const account = { id: "brickell", links: { billing_portal: "https://pay.example/portal" } };
    const rules = { threshold: { atRiskMembers: 1 } };
    const items = [{
      id: "brickell:owed_risk:ungrouped", jobType: "owed_risk", account: "brickell",
      title: "2 failed payments — one root cause", status: "at_risk",
      group: { rootCause: "ungrouped", members: [
        { vendor: "Acme", from: "billing@acme.com", subject: "Overdue", emailId: "e1" },
        { vendor: "Globex", from: "dun@globex.io", subject: "Final", emailId: "e2" },
      ] },
      source: [], proposedActions: ["draft_chase"], lastChanged: null,
    }];
    const runClaude = () => '{"e1":"acct:acme","e2":"acct:globex"}';
    const reasonerFn = makeReasonerFn(runClaude);
    const out = await regroupStragglers(items, account, rules, reasonerFn);
    assert.ok(!out.some(i => i.group.rootCause === "ungrouped"));
    assert.ok(out.some(i => i.group.rootCause === "acct:acme"));
    assert.ok(out.some(i => i.group.rootCause === "acct:globex"));
  });
});
