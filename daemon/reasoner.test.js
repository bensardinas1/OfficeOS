import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGroupingPrompt, parseGroupingResponse } from "./reasoner.js";

const stragglers = [
  { id: "e1", from: "billing@acme.com", subject: "Overdue balance on your account" },
  { id: "e2", from: "ar@acme.com", subject: "Reminder: amount outstanding" },
  { id: "e3", from: "dunning@globex.io", subject: "Final notice" },
];

describe("buildGroupingPrompt", () => {
  it("includes each straggler's id, sender, and subject and asks for JSON", () => {
    const p = buildGroupingPrompt(stragglers);
    assert.match(p, /e1/); assert.match(p, /acme\.com/); assert.match(p, /Overdue/);
    assert.match(p, /JSON/i);
  });
});

describe("parseGroupingResponse", () => {
  it("parses a fenced or bare JSON map of emailId -> groupKey", () => {
    const fenced = "```json\n{\"e1\":\"acct:acme\",\"e2\":\"acct:acme\",\"e3\":\"acct:globex\"}\n```";
    assert.deepEqual(parseGroupingResponse(fenced), { e1: "acct:acme", e2: "acct:acme", e3: "acct:globex" });
  });
  it("returns {} on unparseable output (never throws)", () => {
    assert.deepEqual(parseGroupingResponse("the model rambled with no json"), {});
  });
});
