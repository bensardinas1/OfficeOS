import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeFakeConnectors } from "./fake-connectors.js";
import { chooseConnectors } from "./wiring.js";

const here = dirname(fileURLToPath(import.meta.url));

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

  it("deleteBySenderFn returns a canned matched/trashed shape", async () => {
    const f = makeFakeConnectors();
    const r = await f.deleteBySenderFn("a", "spam@x.com");
    assert.deepEqual(r, { matched: 3, trashed: 3, failed: 0, failedIds: [], emailIds: ["f1", "f2", "f3"] });
    assert.equal(r.emailIds.length, 3);
  });
});

describe("daemon.js source contract — in-process mail connectors", () => {
  const src = readFileSync(join(here, "daemon.js"), "utf-8");

  it("imports fetch/delete/restore/body/deleteBySender from ../scripts/mail.js", () => {
    assert.match(src, /from\s+["']\.\.\/scripts\/mail\.js["']/, "must import from ../scripts/mail.js");
  });

  it("no longer subprocesses the old per-provider connector CLIs", () => {
    for (const f of ["delete-emails.js", "restore-emails.js", "fetch-message.js", "fetch-emails.js", "fetch-gmail.js"]) {
      assert.doesNotMatch(src, new RegExp(f.replace(".", "\\.")), `must not reference ${f} as a subprocess arg`);
    }
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
