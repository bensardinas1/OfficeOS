import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("account-types.example owed_risk schema", () => {
  it("business type declares an owed_risk job with detection + grouping rules", () => {
    const cfg = JSON.parse(readFileSync(join(root, "config/account-types.example.json"), "utf-8"));
    const job = cfg.business.jobTypes?.owed_risk;
    assert.ok(job, "business.jobTypes.owed_risk must exist");
    assert.ok(Array.isArray(job.sourceCategories) && job.sourceCategories.length > 0);
    assert.ok(Array.isArray(job.failureSignals) && job.failureSignals.length > 0);
    assert.ok(job.grouping && Array.isArray(job.grouping.order));
  });
});
