import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(scripts, f), "utf-8");

const SEND = [/\bsendMail\b/i, /\/sendMail\b/i, /messages\.send\b/i, /\.sendMail\s*\(/i, /users\.messages\.send\b/i];
const PERM_DELETE = [/messages\.delete\b/i, /messages\.batchDelete\b/i, /\bbatchDelete\b/i, /\.api\([^)]*\)\.delete\s*\(/i];

describe("connector rails guard — drafts never send", () => {
  for (const f of ["save-draft.js", "save-gmail-draft.js"]) {
    it(`${f} contains no send-mail API`, () => {
      const src = read(f);
      const hits = SEND.filter(rx => rx.test(src)).map(String);
      assert.deepEqual(hits, [], `${f} must not reference a send API: ${hits.join(", ")}`);
    });
  }
});

describe("connector rails guard — deletes are soft-delete only", () => {
  it("delete-emails.js soft-deletes (move to deleteditems) and never permanent-deletes", () => {
    const src = read("delete-emails.js");
    assert.match(src, /deleteditems/i, "must move to deleteditems (soft delete)");
    const hits = PERM_DELETE.filter(rx => rx.test(src)).map(String);
    assert.deepEqual(hits, [], `permanent-delete reference(s): ${hits.join(", ")}`);
  });
  it("delete-gmail-emails.js trashes and never permanent-deletes", () => {
    const src = read("delete-gmail-emails.js");
    assert.match(src, /\btrash\b/i, "must use users.messages.trash (soft delete)");
    const hits = PERM_DELETE.filter(rx => rx.test(src)).map(String);
    assert.deepEqual(hits, [], `permanent-delete reference(s): ${hits.join(", ")}`);
  });
});
