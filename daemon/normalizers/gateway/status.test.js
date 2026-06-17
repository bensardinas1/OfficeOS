import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gatewayStatus } from "./status.js";

const markers = ["closing this ticket", "has been resolved"];

describe("gatewayStatus", () => {
  it("is resolved when any message in the thread signals closure", () => {
    const members = [
      { preview: "How do we proceed?", receivedAt: "2026-06-10T00:00:00Z" },
      { preview: "As the solution has been provided, I'll be proceeding with closing this ticket.", receivedAt: "2026-06-13T00:00:00Z" },
    ];
    assert.equal(gatewayStatus(members, markers), "resolved");
  });

  it("is open when no closure signal is present", () => {
    const members = [{ preview: "Still investigating the batch", receivedAt: "2026-06-11T00:00:00Z" }];
    assert.equal(gatewayStatus(members, markers), "open");
  });
});
