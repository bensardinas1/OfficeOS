import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, createAckStore, applyAcks } from "./acknowledge.js";

function tmp() { return mkdtempSync(join(tmpdir(), "officeos-ack-")); }

describe("fingerprint", () => {
  it("is stable for the same salient fields and changes when status/title/rootCause change", () => {
    const a = { id: "i1", status: "at_risk", title: "x", group: { rootCause: "r" } };
    const b = { ...a };
    assert.equal(fingerprint(a), fingerprint(b));
    assert.notEqual(fingerprint(a), fingerprint({ ...a, status: "ok" }));
    assert.notEqual(fingerprint(a), fingerprint({ ...a, title: "y" }));
    assert.notEqual(fingerprint(a), fingerprint({ ...a, group: { rootCause: "s" } }));
  });
  it("ignores volatile fields like lastChanged", () => {
    const a = { id: "i1", status: "at_risk", title: "x", group: { rootCause: "r" }, lastChanged: "t1" };
    assert.equal(fingerprint(a), fingerprint({ ...a, lastChanged: "t2" }));
  });
});

describe("createAckStore", () => {
  it("records and reloads acks; corrupt file degrades to empty", () => {
    const dir = tmp();
    try {
      const s = createAckStore(dir);
      assert.deepEqual(s.getAcks(), {});
      s.recordAck("i1", "fp1", "2026-06-17T00:00:00Z");
      assert.equal(createAckStore(dir).getAcks().i1.fingerprint, "fp1");
      s.saveRaw("{ not json");
      assert.deepEqual(createAckStore(dir).getAcks(), {});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("applyAcks", () => {
  it("forces status ok + acknowledged when fingerprint matches, leaves others", () => {
    const items = [
      { id: "i1", status: "at_risk", title: "x", group: { rootCause: "r" }, fingerprint: "fp1" },
      { id: "i2", status: "at_risk", title: "y", group: { rootCause: "s" }, fingerprint: "fp2" },
    ];
    const out = applyAcks(items, { i1: { fingerprint: "fp1" } });
    assert.equal(out.find(i => i.id === "i1").status, "ok");
    assert.equal(out.find(i => i.id === "i1").acknowledged, true);
    assert.equal(out.find(i => i.id === "i2").status, "at_risk");
  });
  it("re-alerts (does not force ok) when the fingerprint changed", () => {
    const items = [{ id: "i1", status: "at_risk", title: "x", group: { rootCause: "r" }, fingerprint: "fpNEW" }];
    const out = applyAcks(items, { i1: { fingerprint: "fpOLD" } });
    assert.equal(out[0].status, "at_risk");
    assert.ok(!out[0].acknowledged);
  });
});
