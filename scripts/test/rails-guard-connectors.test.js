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

describe("connector rails guard — fetch-message is read-only", () => {
  it("fetch-message.js never sends or permanent-deletes", () => {
    const src = read("fetch-message.js");
    const hits = [...SEND, ...PERM_DELETE].filter(rx => rx.test(src)).map(String);
    assert.deepEqual(hits, [], `read-only connector must not send/delete: ${hits.join(", ")}`);
    assert.doesNotMatch(src, /\/move\b/, "must not move/delete messages");
  });
});

describe("connector rails guard — killlist-add writes config only", () => {
  it("killlist-add.js never sends or deletes mail", () => {
    const src = read("killlist-add.js");
    const hits = [...SEND, ...PERM_DELETE].filter(rx => rx.test(src)).map(String);
    assert.deepEqual(hits, [], `kill-list connector must not send/delete: ${hits.join(", ")}`);
    assert.doesNotMatch(src, /deleteditems|messages\.trash|\/move\b/, "must not touch mail at all");
  });
});

describe("connector rails guard — mail.js (unified connector) never sends/permanent-deletes, guards wired", () => {
  it("mail.js soft-deletes only, refuses via isProtectedSender, and never sends", () => {
    const src = read("mail.js");
    assert.match(src, /deleteditems/i, "must move to deleteditems (soft delete)");
    assert.match(src, /isProtectedSender/, "must wire the protected-sender guard");
    assert.match(src, /verifyGmailAccount/, "must verify the authenticated Gmail session matches the account (client-factory guard)");
    const hits = [...SEND, ...PERM_DELETE, /\bpermanentDelete\b/i].filter(rx => rx.test(src)).map(String);
    assert.deepEqual(hits, [], `mail.js must not reference a send/permanent-delete API: ${hits.join(", ")}`);
  });
});

describe("connector rails guard — restore + killlist-remove", () => {
  for (const f of ["restore-emails.js", "restore-gmail-emails.js"]) {
    it(`${f} restores (move/untrash) and never sends or permanent-deletes`, () => {
      const src = read(f);
      const hits = [...SEND, ...PERM_DELETE].filter(rx => rx.test(src)).map(String);
      assert.deepEqual(hits, [], `${f} must not send/permanent-delete: ${hits.join(", ")}`);
    });
  }
  it("killlist-remove.js never touches mail", () => {
    const src = read("killlist-remove.js");
    const hits = [...SEND, ...PERM_DELETE].filter(rx => rx.test(src)).map(String);
    assert.deepEqual(hits, [], `must not send/delete: ${hits.join(", ")}`);
    assert.doesNotMatch(src, /deleteditems|messages\.trash|\/move\b/, "config-only");
  });
});
