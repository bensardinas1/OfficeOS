import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveExecutor } from "./index.js";

const account = { id: "brickell", links: { billing_portal: "https://pay.example/portal" } };

describe("route executor", () => {
  it("resolves route:billing_portal to the account's portal URL", async () => {
    const exec = resolveExecutor("route:billing_portal");
    const out = await exec({ itemId: "x", action: "route:billing_portal" }, { account });
    assert.deepEqual(out, { kind: "route", url: "https://pay.example/portal" });
  });
  it("throws a clear error when the link is not configured", async () => {
    const exec = resolveExecutor("route:billing_portal");
    await assert.rejects(() => exec({ action: "route:billing_portal" }, { account: { id: "x", links: {} } }), /not configured/i);
  });
});

describe("draft_chase executor", () => {
  it("creates one draft via the injected saveDraftFn and returns ids", async () => {
    const saved = [];
    const saveDraftFn = async (acct, draft) => { saved.push([acct, draft]); return { draftId: `d${saved.length}` }; };
    const exec = resolveExecutor("draft_chase");
    const proposal = { params: { account: "brickell", drafts: [
      { to: ["a@x.com"], subject: "s", body: "b", replyToMessageId: "e1" },
    ] } };
    const out = await exec(proposal, { account, saveDraftFn });
    assert.equal(out.kind, "execute");
    assert.deepEqual(out.result.draftIds, ["d1"]);
    assert.equal(saved[0][0], "brickell");
  });
});

describe("resolveExecutor", () => {
  it("throws on an unknown action", () => {
    assert.throws(() => resolveExecutor("nope"), /unknown action/i);
  });
});
