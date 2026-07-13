import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFakeConnectors } from "./fake-connectors.js";
import { chooseConnectors } from "./wiring.js";

describe("fake connectors", () => {
  it("return canned successes and a throwing fetchFn", async () => {
    const f = makeFakeConnectors();
    assert.deepEqual(await f.deleteFn("a", ["1", "2"]), { trashed: 2, failed: 0 });
    assert.deepEqual(await f.restoreFn("a", ["1"]), { restored: 1, failed: 0 });
    assert.equal((await f.killlistFn("a", "s@x.com")).added, true);
    assert.equal((await f.killlistRemoveFn("a", "s@x.com")).removed, true);
    assert.equal((await f.runTriageFn(null, null)).ok, true);
    assert.match((await f.fetchBodyFn("a", "e1")).body, /e1/);
    await assert.rejects(() => f.fetchFn("a", "inbox", 24), /fake mode/);
  });
});

describe("chooseConnectors", () => {
  const real = { tag: "real" }, fake = { tag: "fake" };
  it("uses real connectors unless the env var is exactly '1'", () => {
    assert.equal(chooseConnectors({}, real, fake).tag, "real");
    assert.equal(chooseConnectors({ OFFICEOS_FAKE_CONNECTORS: "" }, real, fake).tag, "real");
    assert.equal(chooseConnectors({ OFFICEOS_FAKE_CONNECTORS: "true" }, real, fake).tag, "real");
    assert.equal(chooseConnectors({ OFFICEOS_FAKE_CONNECTORS: "1" }, real, fake).tag, "fake");
  });
});
