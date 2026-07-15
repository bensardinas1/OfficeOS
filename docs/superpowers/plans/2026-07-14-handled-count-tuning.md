# Handled-Count Tuning + Config Validator (Cluster C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the handled tiles' "need a reply" count honest (conversation-aware, own-mail-excluded, standing-gated keywords, domain-aware automation detection) and add a warn-and-continue config validator surfaced in the panel.

**Architecture:** Four pure-logic changes (urgency matcher, standing gate, `looksAutomated`, `countConversations`) feed the existing classify → normalize pipeline; a new pure `validateConfig` runs in the daemon each tick, its findings ride the model to a new panel warning strip. No mail-touching code paths change.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, vanilla-JS panel (no deps), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-14-handled-count-tuning-design.md`

## Global Constraints

- Soft-delete only / never auto-send — this cluster must not touch any mail-mutation path.
- Never hardcode company names, addresses, or rules in code; config stays the source of truth.
- `config/companies.json`, `config/account-types.json`, `data/` are never committed. The flag-curation config edit is a SHIP-TIME controller step, not a subagent task.
- Panel code (`daemon/web/*`) is browser vanilla JS: no Node APIs, no imports beyond sibling modules.
- Validator is warn-and-continue: it never throws, and a config problem must never stop the daemon.
- Test runner: `npm test` (which runs `node --test`). Run scoped files during tasks, full suite at the end.
- Title copy (exact): `${n} conversation${n===1?"":"s"} need${n===1?"s":""} a reply`; zero-cases stay `Nothing needs a reply` / `Inbox clear`; subtitle stays `+ N informational`.
- Work on branch `claude/hardcore-noyce-8f0bd6` (the current worktree).

---

### Task 1: Word-boundary urgency-flag matcher

**Files:**
- Modify: `scripts/classify-emails.js:124-127` (replace `matchesUrgencyFlags`)
- Test: `scripts/test/classify-emails.test.js` (append a describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `matchesUrgencyFlags(email, flags) -> boolean` (same signature, word-boundary semantics). Tasks 2 and 8 rely on these exact semantics.

Current implementation (to be replaced):

```js
export function matchesUrgencyFlags(email, flags) {
  const text = `${email.subject || ""} ${email.preview || ""}`.toLowerCase();
  return flags.some(flag => text.includes(flag.toLowerCase()));
}
```

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test/classify-emails.test.js` (import `matchesUrgencyFlags` in the existing import from `../classify-emails.js` if not already imported):

```js
describe("matchesUrgencyFlags — word-boundary semantics", () => {
  const mail = (subject, preview = "") => ({ subject, preview });

  it("matches a flag as a whole word", () => {
    assert.equal(matchesUrgencyFlags(mail("We need this today"), ["need"]), true);
    assert.equal(matchesUrgencyFlags(mail("Everything you needed"), ["need"]), false);
    assert.equal(matchesUrgencyFlags(mail("kneading dough"), ["need"]), false);
  });

  it("does not fire inside larger words (hold/shareholder, audit/auditorium)", () => {
    assert.equal(matchesUrgencyFlags(mail("shareholder update"), ["hold"]), false);
    assert.equal(matchesUrgencyFlags(mail("visit the auditorium"), ["audit"]), false);
    assert.equal(matchesUrgencyFlags(mail("account on hold"), ["hold"]), true);
  });

  it("treats punctuation and string edges as boundaries", () => {
    assert.equal(matchesUrgencyFlags(mail("Urgent: reply now"), ["urgent"]), true);
    assert.equal(matchesUrgencyFlags(mail("need-by date attached"), ["need"]), true);
    assert.equal(matchesUrgencyFlags(mail("need"), ["need"]), true);
  });

  it("matches multi-word flags as phrases across whitespace runs", () => {
    assert.equal(matchesUrgencyFlags(mail("please  call me back"), ["call me"]), true);
    assert.equal(matchesUrgencyFlags(mail("we recall memos"), ["call me"]), false);
    assert.equal(matchesUrgencyFlags(mail("ACH   hold placed"), ["ACH hold"]), true);
  });

  it("is case-insensitive in both directions", () => {
    assert.equal(matchesUrgencyFlags(mail("URGENT REPLY"), ["urgent"]), true);
    assert.equal(matchesUrgencyFlags(mail("please review the LOI"), ["Please Review"]), true);
  });

  it("escapes regex-special characters in flags", () => {
    assert.equal(matchesUrgencyFlags(mail("cost is $1.5M (final)"), ["$1.5m (final)"]), true);
    assert.equal(matchesUrgencyFlags(mail("cost is 1x5M"), ["$1.5m (final)"]), false);
  });

  it("checks preview text too, and ignores empty/whitespace flags", () => {
    assert.equal(matchesUrgencyFlags(mail("hi", "deadline is friday"), ["deadline"]), true);
    assert.equal(matchesUrgencyFlags(mail("anything at all"), [""]), false);
    assert.equal(matchesUrgencyFlags(mail("anything at all"), ["   "]), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/test/classify-emails.test.js`
Expected: FAIL — "Everything you needed" currently matches `need` (substring), empty flag currently matches everything.

- [ ] **Step 3: Implement the word-boundary matcher**

Replace `matchesUrgencyFlags` in `scripts/classify-emails.js`:

```js
// A flag matches as a whole word/phrase: "need" fires on "we need this" and
// "need-by date" but not "needed" or "kneading"; multi-word flags match as
// phrases across any whitespace run. Boundary = anything that isn't [a-z0-9].
const FLAG_REGEX_CACHE = new Map();
function urgencyFlagRegex(flag) {
  if (FLAG_REGEX_CACHE.has(flag)) return FLAG_REGEX_CACHE.get(flag);
  const words = String(flag).trim().split(/\s+/).filter(Boolean)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = words.length
    ? new RegExp(`(?<![a-z0-9])(?:${words.join("\\s+")})(?![a-z0-9])`, "i")
    : null; // empty/whitespace flag matches nothing
  FLAG_REGEX_CACHE.set(flag, re);
  return re;
}

export function matchesUrgencyFlags(email, flags) {
  const text = `${email.subject || ""} ${email.preview || ""}`;
  return flags.some(flag => {
    const re = urgencyFlagRegex(flag);
    return re ? re.test(text) : false;
  });
}
```

(Note: the `i` flag makes the `[a-z0-9]` lookarounds case-insensitive too, so "Xneed" still fails to match. The cache is safe: flag strings come from config and are few.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/test/classify-emails.test.js`
Expected: PASS, including all pre-existing tests in the file (the existing `withUrgencyFlag` fixture uses a whole-word flag and still matches).

- [ ] **Step 5: Commit**

```bash
git add scripts/classify-emails.js scripts/test/classify-emails.test.js
git commit -m "fix(classify): urgency flags match whole words/phrases, not substrings"
```

---

### Task 2: `senderHasStanding` + standing gate on keyword promotion

**Files:**
- Modify: `scripts/classify-emails.js:171-215` (`classifyEmail`) and `scripts/classify-emails.js:270` (call site in `classify`)
- Test: `scripts/test/classify-emails.test.js`

**Interfaces:**
- Consumes: `matchesSender(email, senders)` (existing), `matchesUrgencyFlags` (Task 1 semantics).
- Produces: `senderHasStanding(email, account, correspondents) -> boolean` (exported); `classifyEmail(email, account, typeConfig, categories, downrankList, correspondents = new Set())` — 6th optional param, all existing 5-arg callers keep working. `correspondents` is a `Set<string>` of lowercase addresses.

Background: `classify()` already loads the account's correspondents set (`scripts/classify-emails.js:230-231`) and uses it at line 272 (`correspondents.has(...)`) — this task threads that same set into `classifyEmail`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test/classify-emails.test.js`. The file already defines `businessAccount`, `businessTypeConfig` and a `resolveCategories`/`resolveDownrank` pattern near line 113 — reuse them; if `businessAccount.myEmail` is not set, use a local account object as below:

```js
describe("senderHasStanding — keyword promotion requires standing", () => {
  const account = {
    id: "biz", accountType: "business", myEmail: "me@mycorp.com",
    prioritySenders: [{ type: "domain", value: "partner.com" }],
    urgencyRules: { flags: ["call me", "underwriting"] },
  };
  const typeConfig = { triageCategories: [
    { id: "action", label: "Action", actionable: true },
    { id: "fyi", label: "FYI" },
  ] };
  const categories = resolveCategories(typeConfig, account);
  const downrank = resolveDownrank(typeConfig, account);
  const flagged = (from) => ({
    from, fromName: "Someone", subject: "call me about your underwriting",
    preview: "", toRecipients: "me@mycorp.com",
  });

  it("grants standing to correspondents, prioritySenders, and own domain", () => {
    assert.equal(senderHasStanding(flagged("known@vendor.com"), account, new Set(["known@vendor.com"])), true);
    assert.equal(senderHasStanding(flagged("anyone@partner.com"), account, new Set()), true);
    assert.equal(senderHasStanding(flagged("colleague@mycorp.com"), account, new Set()), true);
    assert.equal(senderHasStanding(flagged("stranger@salescorp.com"), account, new Set()), false);
  });

  it("routes a flagged email to action only when the sender has standing", () => {
    const known = classifyEmail(flagged("known@vendor.com"), account, typeConfig, categories, downrank, new Set(["known@vendor.com"]));
    assert.equal(known, "action");
    const stranger = classifyEmail(flagged("stranger@salescorp.com"), account, typeConfig, categories, downrank, new Set());
    assert.equal(stranger, "fyi"); // cold outreach cannot keyword itself into action
  });

  it("gates category-level urgencyRules the same way", () => {
    const catCfg = { triageCategories: [
      { id: "deals", label: "Deals", urgencyRules: { flags: ["underwriting"] } },
      { id: "action", label: "Action", actionable: true },
      { id: "fyi", label: "FYI" },
    ] };
    const cats = resolveCategories(catCfg, account);
    assert.equal(classifyEmail(flagged("anyone@partner.com"), account, catCfg, cats, downrank, new Set()), "deals");
    assert.equal(classifyEmail(flagged("stranger@salescorp.com"), account, catCfg, cats, downrank, new Set()), "fyi");
  });

  it("leaves direct prioritySender routing unaffected (no flags needed)", () => {
    const plain = { from: "anyone@partner.com", fromName: "P", subject: "hello", preview: "", toRecipients: "me@mycorp.com" };
    assert.equal(classifyEmail(plain, account, typeConfig, categories, downrank, new Set()), "action");
  });

  it("category prioritySenders are NOT standing-gated (explicit sender config)", () => {
    const catCfg = { triageCategories: [
      { id: "vip", label: "VIP", prioritySenders: [{ type: "email", value: "boss@elsewhere.com" }] },
      { id: "action", label: "Action", actionable: true },
      { id: "fyi", label: "FYI" },
    ] };
    const cats = resolveCategories(catCfg, account);
    const m = { from: "boss@elsewhere.com", fromName: "Boss", subject: "hi", preview: "", toRecipients: "me@mycorp.com" };
    assert.equal(classifyEmail(m, account, catCfg, cats, downrank, new Set()), "vip");
  });
});
```

Add `senderHasStanding` to the test file's import list from `../classify-emails.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/test/classify-emails.test.js`
Expected: FAIL with "senderHasStanding is not a function" (not exported yet), and the stranger case returning "action".

- [ ] **Step 3: Implement standing + gate**

In `scripts/classify-emails.js`, add after `matchesUrgencyFlags`:

```js
/**
 * A sender has "standing" when the user plausibly cares about them already:
 * they're a correspondent (user has written to them), match the account's
 * prioritySenders, or are on the user's own domain. Urgency-flag keyword
 * promotion requires standing — cold outreach can't keyword itself into
 * "needs a reply". (Direct prioritySender routing is unaffected.)
 */
export function senderHasStanding(email, account, correspondents) {
  const fromEmail = (email.from || "").toLowerCase();
  if (correspondents && correspondents.has(fromEmail)) return true;
  if (account.prioritySenders?.length && matchesSender(email, account.prioritySenders)) return true;
  const myDomain = ((account.myEmail || "").split("@")[1] || "").toLowerCase();
  const fromDomain = fromEmail.split("@")[1] || "";
  return Boolean(myDomain && fromDomain === myDomain);
}
```

Change `classifyEmail`'s signature (line 171):

```js
export function classifyEmail(email, account, typeConfig, categories, downrankList, correspondents = new Set()) {
```

In the rich-category loop (currently line 194), gate the urgency-flag branch (leave the `prioritySenders` branch above it untouched):

```js
    if (cat.urgencyRules?.flags?.length && senderHasStanding(email, account, correspondents)
        && matchesUrgencyFlags(email, cat.urgencyRules.flags)) return cat.id;
```

In the account-level urgency step (currently line 204):

```js
  // 4. Account-level urgency flags → action / respond (only for senders with standing)
  if (account.urgencyRules?.flags?.length && senderHasStanding(email, account, correspondents)
      && matchesUrgencyFlags(email, account.urgencyRules.flags)) {
```

And thread the set through at the `classify()` call site (line 270):

```js
    let categoryId = classifyEmail(email, account, typeConfig, categories, downrankList, correspondents);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/test/classify-emails.test.js`
Expected: PASS. Note: if the pre-existing `withUrgencyFlag` fixture (line ~123) uses a sender WITHOUT standing for its account, that test will now fail — inspect it; the fixture sender must gain standing to keep testing the flag path (e.g. give it the account's own domain or add its domain to the fixture account's prioritySenders). Update the fixture, not the assertion's intent.

- [ ] **Step 5: Run the neighboring suites (classify feeds them)**

Run: `node --test scripts/test/build-bundle.test.js scripts/test/confidence-tier.test.js scripts/test/morning-brief.test.js`
Expected: PASS (these consume `classify()` output shapes, not flag routing — investigate any failure before proceeding).

- [ ] **Step 6: Commit**

```bash
git add scripts/classify-emails.js scripts/test/classify-emails.test.js
git commit -m "feat(classify): urgency flags only promote senders with standing"
```

---

### Task 3: Shared MARKETING_SUBDOMAINS + domain-aware `looksAutomated`

**Files:**
- Modify: `scripts/sender-guards.js` (add exported list, extend `looksAutomated`)
- Modify: `scripts/classify-emails.js:129` (delete local list, import the shared one)
- Test: `scripts/test/sender-guards.test.js`, `scripts/test/classify-emails.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `MARKETING_SUBDOMAINS: string[]` exported from `scripts/sender-guards.js`; `looksAutomated(senderEmail, hasListUnsubscribe)` (same signature, now also true for marketing-subdomain senders). Task 4 relies on the upgraded verdict.

Callers of `looksAutomated` (all get the upgrade deliberately — spec-approved): `daemon/normalizers/handled.js` (count + member.automated → drill-in section split), `scripts/build-bundle.js:167` (alert-batch proposal guard — more automated senders become batchable, same intent).

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test/sender-guards.test.js` inside its existing describe (match the import style at the top of that file; add `MARKETING_SUBDOMAINS` to the import):

```js
  it("treats marketing-subdomain senders as automated (signal in the domain)", () => {
    for (const a of [
      "capitalone@notification.capitalone.com",
      "americanexpress@welcome.americanexpress.com",
      "team@alerts.vendor.io",
      "x@e.chase.com",
    ]) assert.equal(looksAutomated(a, false), true, a);
  });

  it("plain domains stay human", () => {
    for (const a of ["jane@vendor.com", "luis@brickell.example", "ben@enterprise-co.com"]) {
      assert.equal(looksAutomated(a, false), false, a);
    }
  });

  it("exports the shared MARKETING_SUBDOMAINS list", () => {
    assert.ok(Array.isArray(MARKETING_SUBDOMAINS));
    assert.ok(MARKETING_SUBDOMAINS.includes("notification."));
    assert.ok(MARKETING_SUBDOMAINS.includes("noreply."));
  });
```

And in `scripts/test/classify-emails.test.js` append:

```js
describe("detectBulkSignals uses the shared MARKETING_SUBDOMAINS list", () => {
  it("fires marketing-subdomain for the newly shared prefixes", () => {
    const { signals } = detectBulkSignals({ from: "x@notification.capitalone.com", subject: "s" }, "me@x.com");
    assert.ok(signals.includes("marketing-subdomain"));
  });
});
```

(Add `detectBulkSignals` to that file's imports if missing.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/test/sender-guards.test.js scripts/test/classify-emails.test.js`
Expected: FAIL — `MARKETING_SUBDOMAINS` not exported; `notification.` sender currently reads human; `notification.` prefix not in classify's local list.

- [ ] **Step 3: Implement**

In `scripts/sender-guards.js`, below `AUTOMATED_LOCALPART`:

```js
// Subdomain prefixes that mark bulk/marketing senders. Single source of truth —
// consumed here (looksAutomated) and by classify-emails' detectBulkSignals.
export const MARKETING_SUBDOMAINS = [
  "mail.", "email.", "news.", "marketing.", "updates.", "info.", "noreply.",
  "notification.", "notifications.", "welcome.", "alerts.", "reply.", "e.",
];

export function looksAutomated(senderEmail, hasListUnsubscribe) {
  if (hasListUnsubscribe) return true;
  const addr = String(senderEmail || "").toLowerCase();
  const local = addr.split("@")[0] || "";
  if (AUTOMATED_LOCALPART.test(local)) return true;
  const domain = addr.split("@")[1] || "";
  return MARKETING_SUBDOMAINS.some(prefix => domain.startsWith(prefix));
}
```

In `scripts/classify-emails.js`: delete line 129 (`const MARKETING_SUBDOMAINS = [...]`) and add to the imports at the top:

```js
import { MARKETING_SUBDOMAINS } from "./sender-guards.js";
```

(`sender-guards.js` imports nothing from `classify-emails.js` — no cycle.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/test/sender-guards.test.js scripts/test/classify-emails.test.js scripts/test/build-bundle.test.js daemon/normalizers/handled.test.js`
Expected: PASS. (`handled.test.js` line 83 already expects `notifications@github.com` automated via local-part — unaffected.)

- [ ] **Step 5: Commit**

```bash
git add scripts/sender-guards.js scripts/classify-emails.js scripts/test/sender-guards.test.js scripts/test/classify-emails.test.js
git commit -m "feat(guards): looksAutomated recognizes marketing subdomains; share the prefix list"
```

---

### Task 4: `countConversations` + conversation-denominated handled tile

**Files:**
- Modify: `daemon/normalizers/handled.js`
- Test: `daemon/normalizers/handled.test.js`

**Interfaces:**
- Consumes: `looksAutomated` (Task 3 verdict), `withinLookback` (existing).
- Produces: `countConversations(actionableEmails, myEmail) -> { needsYou, waiting }` (exported from `daemon/normalizers/handled.js`; conversation counts). `normalizeHandled` keeps its signature; `group.counts.needsYou` becomes conversation-denominated; title copy changes to `N conversation(s) need(s) a reply`.

Semantics (from the spec):
- Group actionable-category emails by `conversationId`; missing id → singleton keyed by email id.
- Newest **non-automated** message decides: from `myEmail` (case-insensitive) → the conversation is waiting; otherwise → needsYou. Automated-only conversations → waiting (one each).
- Non-actionable categories still add to `waiting` per-message.

- [ ] **Step 1: Rewrite the failing tests**

In `daemon/normalizers/handled.test.js`: update the FOUR existing title/count assertions to the new copy and semantics, and append the new describe. The full set of edits:

1. Line 29-30 (`leads with the actionable count…`): the fixture's action emails have no `from`/`conversationId` → 2 singleton human conversations. New assertions:
```js
    assert.equal(it0.title, "2 conversations need a reply");
    assert.equal(it0.subtitle, "+ 4 informational");
```
2. Line 49 (`uses singular…`): `assert.equal(items[0].title, "1 conversation needs a reply");`
3. Line 89 (automated/no-reply test): `assert.match(it0.title, /1 conversation needs a reply/);` — counts stay `{needsYou: 1, waiting: 2}` (two automated singletons → waiting).
4. Everything else (lookback, members, cap, conversationId stamping, inbox-clear) is unchanged.

Append:

```js
import { countConversations } from "./handled.js"; // merge into the existing import

describe("countConversations", () => {
  const me = "me@corp.com";
  const m = (id, from, receivedAt, extra = {}) => ({ id, from, receivedAt, ...extra });

  it("counts a thread once regardless of message volume", () => {
    const emails = [
      m("a1", "client@x.com", "2026-07-01T10:00:00Z", { conversationId: "cv1" }),
      m("a2", "client@x.com", "2026-07-01T11:00:00Z", { conversationId: "cv1" }),
      m("a3", "client@x.com", "2026-07-01T12:00:00Z", { conversationId: "cv1" }),
    ];
    assert.deepEqual(countConversations(emails, me), { needsYou: 1, waiting: 0 });
  });

  it("a thread where I had the last (human) word is waiting, not needsYou", () => {
    const emails = [
      m("a1", "client@x.com", "2026-07-01T10:00:00Z", { conversationId: "cv1" }),
      m("a2", "me@corp.com", "2026-07-01T12:00:00Z", { conversationId: "cv1" }),
    ];
    assert.deepEqual(countConversations(emails, me), { needsYou: 0, waiting: 1 });
  });

  it("an automated message after my reply does not flip the thread back", () => {
    const emails = [
      m("a1", "client@x.com", "2026-07-01T10:00:00Z", { conversationId: "cv1" }),
      m("a2", "me@corp.com", "2026-07-01T12:00:00Z", { conversationId: "cv1" }),
      m("a3", "noreply@x.com", "2026-07-01T13:00:00Z", { conversationId: "cv1" }),
    ];
    assert.deepEqual(countConversations(emails, me), { needsYou: 0, waiting: 1 });
  });

  it("my own solo mail never needs me", () => {
    const emails = [m("a1", "ME@corp.com", "2026-07-01T10:00:00Z")];
    assert.deepEqual(countConversations(emails, me), { needsYou: 0, waiting: 1 });
  });

  it("automated-only conversations are waiting", () => {
    const emails = [
      m("a1", "noreply@x.com", "2026-07-01T10:00:00Z", { conversationId: "cv1" }),
      m("a2", "b@y.com", "2026-07-01T10:00:00Z", { hasListUnsubscribe: true, conversationId: "cv2" }),
    ];
    assert.deepEqual(countConversations(emails, me), { needsYou: 0, waiting: 2 });
  });

  it("missing conversationId falls back to per-email singletons", () => {
    const emails = [m("a1", "x@a.com", "2026-07-01T10:00:00Z"), m("a2", "y@b.com", "2026-07-01T10:00:00Z")];
    assert.deepEqual(countConversations(emails, me), { needsYou: 2, waiting: 0 });
  });

  it("tolerates missing receivedAt and missing myEmail", () => {
    const emails = [m("a1", "x@a.com", undefined, { conversationId: "cv1" }), m("a2", "me@corp.com", undefined, { conversationId: "cv1" })];
    const r = countConversations(emails, undefined);
    assert.equal(r.needsYou + r.waiting, 1); // one conversation, counted exactly once
  });

  it("supports the legacy `received` field for ordering", () => {
    const emails = [
      { id: "a1", from: "client@x.com", received: "2026-07-01T10:00:00Z", conversationId: "cv1" },
      { id: "a2", from: "me@corp.com", received: "2026-07-02T10:00:00Z", conversationId: "cv1" },
    ];
    assert.deepEqual(countConversations(emails, me), { needsYou: 0, waiting: 1 });
  });
});

describe("normalizeHandled — conversation-aware integration", () => {
  it("a multi-message thread I answered last counts zero; a fresh thread counts one", () => {
    const classified = { categories: { action: { emails: [
      { id: "t1a", from: "client@x.com", receivedAt: "2026-07-01T10:00:00Z", conversationId: "cvA" },
      { id: "t1b", from: "me@corp.com", receivedAt: "2026-07-01T12:00:00Z", conversationId: "cvA" },
      { id: "t2a", from: "other@y.com", receivedAt: "2026-07-01T11:00:00Z", conversationId: "cvB" },
    ] } } };
    const it0 = normalizeHandled(classified, { id: "biz", myEmail: "me@corp.com" }, typeConfig)[0];
    assert.deepEqual(it0.group.counts, { needsYou: 1, waiting: 1 });
    assert.equal(it0.title, "1 conversation needs a reply");
    assert.equal(it0.subtitle, "+ 1 informational");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test daemon/normalizers/handled.test.js`
Expected: FAIL — `countConversations` not exported; old title copy.

- [ ] **Step 3: Implement**

Rewrite `daemon/normalizers/handled.js`'s counting (keep the file header comment, `actionableIds`, member building, CAP, sort — only the counting and title change):

```js
/**
 * Conversation-aware counting: the honest "needs a reply" number is distinct
 * THREADS awaiting the user, not messages. A thread where the user's own mail
 * is the newest human message is handled; automated messages never decide.
 */
export function countConversations(actionableEmails, myEmail) {
  const me = String(myEmail || "").toLowerCase();
  const byConv = new Map();
  for (const e of actionableEmails) {
    const key = e.conversationId || `solo:${e.id}`;
    if (!byConv.has(key)) byConv.set(key, []);
    byConv.get(key).push(e);
  }
  let needsYou = 0, waiting = 0;
  for (const msgs of byConv.values()) {
    const humans = msgs.filter(x => !looksAutomated(x.from, x.hasListUnsubscribe));
    if (!humans.length) { waiting++; continue; }
    humans.sort((a, b) => String(a.receivedAt || a.received || "").localeCompare(String(b.receivedAt || b.received || "")));
    const newest = humans[humans.length - 1];
    if (me && (newest.from || "").toLowerCase() === me) waiting++;
    else needsYou++;
  }
  return { needsYou, waiting };
}
```

In `normalizeHandled`, replace the per-email counting loop body: collect actionable emails instead of counting inline —

```js
  let waiting = 0;
  const actionableEmails = [];
  const all = [];
  for (const [id, bucket] of Object.entries(classified.categories || {})) {
    if (id === "ignore") continue;
    const emails = (bucket.emails || []).filter(e => !lookbackHours || withinLookback(e, lookbackHours, nowMs));
    if (actionable.has(id)) actionableEmails.push(...emails);
    else waiting += emails.length;
    for (const e of emails) all.push({
      subject: e.subject, from: e.from, fromName: e.fromName,
      receivedAt: e.receivedAt || e.received, emailId: e.id,
      conversationId: e.conversationId || null,
      automated: looksAutomated(e.from, e.hasListUnsubscribe),
    });
  }
  const conv = countConversations(actionableEmails, account.myEmail);
  const needsYou = conv.needsYou;
  waiting += conv.waiting;
```

And the title:

```js
  const title = needsYou > 0
    ? `${needsYou} conversation${needsYou === 1 ? "" : "s"} need${needsYou === 1 ? "s" : ""} a reply`
    : (waiting > 0 ? "Nothing needs a reply" : "Inbox clear");
```

(Member `automated` stamping stays exactly as-is — it feeds the drill-in split.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test daemon/normalizers/handled.test.js daemon/scheduler.test.js daemon/web/view-model.test.js`
Expected: PASS (scheduler/view-model don't assert handled titles; investigate any failure).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/handled.js daemon/normalizers/handled.test.js
git commit -m "feat(handled): conversation-aware needsYou — threads, not messages; own last word = handled"
```

---

### Task 5: Pure config validator + classifier hardening

**Files:**
- Create: `scripts/validate-config.js`
- Modify: `scripts/classify-emails.js:53-71` (`matchesSender` skips malformed rules)
- Test: `scripts/test/validate-config.test.js`, `scripts/test/classify-emails.test.js`

**Interfaces:**
- Consumes: nothing (pure, no I/O).
- Produces: `validateConfig(companies, accountTypes) -> Array<{level: "error"|"warning", path: string, message: string}>`. Task 6 calls it in the daemon; Task 7 renders its findings. Never throws. Also: `matchesSender` tolerates malformed rules (skip, don't throw).

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/validate-config.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../validate-config.js";

const TYPES = { business: {}, personal: {} };
const okAccount = (over = {}) => ({
  id: "acme", provider: "outlook", accountType: "business", myEmail: "me@acme.com", ...over,
});
const wrap = (accounts) => ({ companies: accounts });
const errorsOf = (f) => f.filter(x => x.level === "error");
const warningsOf = (f) => f.filter(x => x.level === "warning");

describe("validateConfig", () => {
  it("returns no findings for a clean config", () => {
    assert.deepEqual(validateConfig(wrap([okAccount()]), TYPES), []);
  });

  it("errors when companies.json has no companies array (and never throws)", () => {
    for (const bad of [null, {}, { companies: "x" }]) {
      const f = validateConfig(bad, TYPES);
      assert.equal(errorsOf(f).length >= 1, true, JSON.stringify(bad));
    }
  });

  it("errors on missing id, bad provider, unknown accountType, malformed myEmail", () => {
    const f = validateConfig(wrap([
      okAccount({ id: "" }),
      okAccount({ id: "b", provider: "imap" }),
      okAccount({ id: "c", accountType: "corporate" }),
      okAccount({ id: "d", myEmail: "not-an-email" }),
    ]), TYPES);
    const paths = errorsOf(f).map(x => x.path).join("|");
    assert.match(paths, /\.id/); assert.match(paths, /\.provider/);
    assert.match(paths, /\.accountType/); assert.match(paths, /\.myEmail/);
  });

  it("warns (not errors) when myEmail is absent", () => {
    const f = validateConfig(wrap([okAccount({ myEmail: undefined })]), TYPES);
    assert.equal(errorsOf(f).length, 0);
    assert.equal(warningsOf(f).length, 1);
    assert.match(f[0].path, /myEmail/);
  });

  it("errors on sender rules with unknown type or empty value, in every list", () => {
    const f = validateConfig(wrap([okAccount({
      prioritySenders: [{ type: "bogus", value: "x" }],
      neverDelete: [{ type: "email", value: "" }],
      alwaysDelete: [{ type: "domain" }],
    })]), TYPES);
    const paths = errorsOf(f).map(x => x.path).join("|");
    assert.match(paths, /prioritySenders\[0\]\.type/);
    assert.match(paths, /neverDelete\[0\]\.value/);
    assert.match(paths, /alwaysDelete\[0\]\.value/);
  });

  it("errors on non-array or non-string urgency flags", () => {
    const f1 = validateConfig(wrap([okAccount({ urgencyRules: { flags: "need" } })]), TYPES);
    assert.match(errorsOf(f1)[0].path, /urgencyRules\.flags/);
    const f2 = validateConfig(wrap([okAccount({ urgencyRules: { flags: ["ok", "", 3] } })]), TYPES);
    assert.equal(errorsOf(f2).length, 2);
  });

  it("warns on duplicate account ids", () => {
    const f = validateConfig(wrap([okAccount(), okAccount()]), TYPES);
    assert.equal(warningsOf(f).length, 1);
    assert.match(f[0].message, /duplicate/i);
  });

  it("warns when the same sender is in both alwaysDelete and neverDelete", () => {
    const f = validateConfig(wrap([okAccount({
      alwaysDelete: [{ type: "email", value: "Spam@x.com" }],
      neverDelete: [{ type: "email", value: "spam@X.com" }],
    })]), TYPES);
    assert.equal(warningsOf(f).length, 1);
    assert.match(f[0].message, /neverDelete/);
  });

  it("warns on a non-positive bulkSignalThreshold", () => {
    const f = validateConfig(wrap([okAccount({ bulkSignalThreshold: 0 })]), TYPES);
    assert.equal(warningsOf(f).length, 1);
  });

  it("validates rules inside categoryOverrides too", () => {
    const f = validateConfig(wrap([okAccount({ categoryOverrides: [
      { id: "vip", prioritySenders: [{ type: "nope", value: "x" }], urgencyRules: { flags: [""] } },
    ] })]), TYPES);
    const paths = errorsOf(f).map(x => x.path).join("|");
    assert.match(paths, /categoryOverrides\[0\]\.prioritySenders\[0\]\.type/);
    assert.match(paths, /categoryOverrides\[0\]\.urgencyRules\.flags\[0\]/);
  });

  it("survives a null account entry with a finding, not a throw", () => {
    const f = validateConfig(wrap([null, okAccount()]), TYPES);
    assert.equal(errorsOf(f).length, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/test/validate-config.test.js`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `scripts/validate-config.js`**

```js
/**
 * validate-config.js — pure structural validation of companies.json +
 * account-types.json. Warn-and-continue by contract: NEVER throws; worst case
 * it returns findings. error = the rule/account is structurally unusable
 * (runtime will skip or misread it); warning = functional but suspicious.
 */
const KNOWN_RULE_TYPES = new Set(["email", "domain", "name", "keyword"]);
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateConfig(companies, accountTypes) {
  const findings = [];
  const err = (path, message) => findings.push({ level: "error", path, message });
  const warn = (path, message) => findings.push({ level: "warning", path, message });

  const accounts = Array.isArray(companies?.companies) ? companies.companies : null;
  if (!accounts) {
    err("companies", "companies.json must contain a companies array");
    return findings;
  }

  const checkRules = (list, path) => {
    if (list == null) return;
    if (!Array.isArray(list)) { err(path, "must be an array of sender rules"); return; }
    list.forEach((r, j) => {
      if (!r || typeof r !== "object") { err(`${path}[${j}]`, "rule is not an object"); return; }
      if (!KNOWN_RULE_TYPES.has(r.type)) err(`${path}[${j}].type`, `unknown sender rule type ${JSON.stringify(r.type ?? null)} (known: email, domain, name, keyword)`);
      if (typeof r.value !== "string" || !r.value.trim()) err(`${path}[${j}].value`, "missing or empty rule value");
    });
  };
  const checkFlags = (flags, path) => {
    if (flags == null) return;
    if (!Array.isArray(flags)) { err(path, "must be an array of strings"); return; }
    flags.forEach((f, j) => {
      if (typeof f !== "string" || !f.trim()) err(`${path}[${j}]`, "flags must be non-empty strings");
    });
  };

  const seenIds = new Set();
  accounts.forEach((a, i) => {
    const label = (a && typeof a === "object" && typeof a.id === "string" && a.id) ? a.id : `#${i}`;
    const p = (s) => `companies[${label}]${s}`;
    if (!a || typeof a !== "object") { err(`companies[${label}]`, "account entry is not an object"); return; }

    if (typeof a.id !== "string" || !a.id.trim()) err(p(".id"), "missing or empty account id");
    else if (seenIds.has(a.id)) warn(p(".id"), `duplicate account id "${a.id}"`);
    else seenIds.add(a.id);

    if (a.provider !== "outlook" && a.provider !== "gmail") err(p(".provider"), `provider must be "outlook" or "gmail" (got ${JSON.stringify(a.provider ?? null)})`);
    if (a.accountType != null && !(accountTypes && typeof accountTypes === "object" && Object.hasOwn(accountTypes, a.accountType))) {
      err(p(".accountType"), `references unknown account type "${a.accountType}"`);
    }
    if (a.myEmail == null) warn(p(".myEmail"), "myEmail missing — own-mail exclusion and the urgency standing gate are degraded");
    else if (typeof a.myEmail !== "string" || !EMAIL_SHAPE.test(a.myEmail)) err(p(".myEmail"), "myEmail is not shaped like an email address");

    checkRules(a.prioritySenders, p(".prioritySenders"));
    checkRules(a.neverDelete, p(".neverDelete"));
    checkRules(a.alwaysDelete, p(".alwaysDelete"));
    checkFlags(a.urgencyRules?.flags, p(".urgencyRules.flags"));

    (Array.isArray(a.categoryOverrides) ? a.categoryOverrides : []).forEach((cat, j) => {
      if (!cat || typeof cat !== "object") return;
      checkRules(cat.prioritySenders, p(`.categoryOverrides[${j}].prioritySenders`));
      checkFlags(cat.urgencyRules?.flags, p(`.categoryOverrides[${j}].urgencyRules.flags`));
    });

    if (a.bulkSignalThreshold != null && !(typeof a.bulkSignalThreshold === "number" && a.bulkSignalThreshold > 0)) {
      warn(p(".bulkSignalThreshold"), "bulkSignalThreshold should be a positive number");
    }

    const norm = (r) => `${r?.type}:${String(r?.value ?? "").toLowerCase()}`;
    const never = new Set((Array.isArray(a.neverDelete) ? a.neverDelete : []).map(norm));
    (Array.isArray(a.alwaysDelete) ? a.alwaysDelete : []).forEach((r, j) => {
      if (r && never.has(norm(r))) warn(p(`.alwaysDelete[${j}]`), `"${r.value}" is also in neverDelete — contradictory; neverDelete wins at runtime`);
    });
  });

  return findings;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/test/validate-config.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Write the failing classifier-hardening test**

The validator warns-and-continues, so a malformed rule the validator flags must be *skipped* by the classifier, not crash it. Today `matchesSender` (`scripts/classify-emails.js:53-71`) calls `sender.value.toLowerCase()` — a rule with a missing/non-string `value` throws, which turns one config typo into a failed classification for the whole folder. Append to `scripts/test/classify-emails.test.js`:

```js
describe("matchesSender — malformed rules are skipped, never thrown", () => {
  const email = { from: "jane@vendor.com", fromName: "Jane", subject: "hi", preview: "" };
  it("ignores rules with missing or non-string values", () => {
    assert.equal(matchesSender(email, [{ type: "domain" }, { type: "email", value: 42 }, null]), false);
  });
  it("still matches valid rules that follow a malformed one", () => {
    assert.equal(matchesSender(email, [{ type: "domain" }, { type: "domain", value: "vendor.com" }]), true);
  });
});
```

Run: `node --test scripts/test/classify-emails.test.js`
Expected: FAIL with a TypeError from `toLowerCase` on undefined.

- [ ] **Step 6: Harden `matchesSender`**

In `scripts/classify-emails.js`, at the top of the `for` loop body in `matchesSender`:

```js
  for (const sender of senders) {
    if (!sender || typeof sender.value !== "string") continue; // malformed rule — validator reports it; runtime skips it
    ...existing type branches unchanged...
  }
```

Run: `node --test scripts/test/classify-emails.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/validate-config.js scripts/test/validate-config.test.js scripts/classify-emails.js scripts/test/classify-emails.test.js
git commit -m "feat(config): pure validateConfig + classifier skips malformed rules instead of throwing"
```

---

### Task 6: Daemon integration — findings on the model, deduped logging

**Files:**
- Modify: `daemon/scheduler.js` (stamp `configFindings` on the model; include in `changed`)
- Modify: `daemon/daemon.js` (refresh findings each tick; deduped `config-findings` log; wire `getConfigFindings` into deps)
- Test: `daemon/scheduler.test.js`

**Interfaces:**
- Consumes: `validateConfig` (Task 5).
- Produces: `model.configFindings: Finding[]` persisted by the store and served by the existing `GET /model` spread (`daemon/api.js:135-138` — no api change needed). New optional dep `getConfigFindings: () => Finding[]` on `runTick`'s deps. Task 7 reads `model.configFindings`.

- [ ] **Step 1: Write the failing tests**

Open `daemon/scheduler.test.js`, find its existing deps-builder helper (it constructs a deps object with fake store/fetchFn — follow the file's established pattern), and append:

The file already has a `deps(dir, over = {})` helper (line 29) that accepts overrides via spread, and a `tmp()`/`rmSync` per-test pattern — reuse both:

```js
describe("config findings on the model", () => {
  const findings = [{ level: "error", path: "companies[x].provider", message: "bad" }];

  it("stamps deps.getConfigFindings() onto the saved model", async () => {
    const dir = tmp();
    try {
      const d = deps(dir, { getConfigFindings: () => findings });
      await runTick(d);
      assert.deepEqual(d.store.getModel().configFindings, findings);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("defaults configFindings to [] when the dep is absent", async () => {
    const dir = tmp();
    try {
      const d = deps(dir);
      await runTick(d);
      assert.deepEqual(d.store.getModel().configFindings, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a findings change alone flips `changed` (same items)", async () => {
    const dir = tmp();
    try {
      await runTick(deps(dir)); // seed: no findings
      const again = await runTick(deps(dir)); // same emails, still no findings
      assert.equal(again.changed, false);
      const withFindings = await runTick(deps(dir, { getConfigFindings: () => findings }));
      assert.equal(withFindings.changed, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test daemon/scheduler.test.js`
Expected: FAIL — `configFindings` undefined on the saved model.

- [ ] **Step 3: Implement scheduler side**

In `daemon/scheduler.js`:

```js
  const configFindings = deps.getConfigFindings ? deps.getConfigFindings() : [];
  const nextModel = { generatedAt: clock.now, accounts: accountsState, items: nextItems, configFindings };
```

and extend the diff (line 85-86):

```js
  const norm = (m) => JSON.stringify(m.items.map(i => ({ ...i, lastChanged: null })));
  const changed = norm(prev) !== norm(nextModel)
    || JSON.stringify(prev.configFindings || []) !== JSON.stringify(configFindings);
```

- [ ] **Step 4: Implement daemon side**

In `daemon/daemon.js`:

```js
import { validateConfig } from "../scripts/validate-config.js";
```

Inside `main()` after the store/logger setup (around line 119):

```js
  // Config findings: revalidated every tick (kill-list writes mutate
  // companies.json at runtime), logged only when the finding set changes.
  let configFindings = [];
  let lastFindingsKey = null;
  function refreshConfigFindings() {
    try {
      const cfg = loadConfig(configDir);
      configFindings = validateConfig(cfg.companies, cfg.accountTypes);
    } catch (e) {
      configFindings = [{ level: "error", path: "config", message: `config unreadable: ${e.message}` }];
    }
    const key = JSON.stringify(configFindings);
    const prevKey = lastFindingsKey;
    lastFindingsKey = key;
    if (key !== prevKey && (configFindings.length || prevKey !== null)) {
      logger.log(configFindings.length ? "warn" : "info", "config-findings",
        { count: configFindings.length, findings: configFindings });
    }
  }
  refreshConfigFindings();
```

Add to the deps factory (the object returned by `deps(emit)`):

```js
    getConfigFindings: () => configFindings,
```

Call `refreshConfigFindings()` at the top of the `tick()` function body AND immediately before the `--once` `runTick` call, so both paths revalidate.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test daemon/scheduler.test.js daemon/api.test.js && node --check daemon/daemon.js`
Expected: PASS / clean parse.

- [ ] **Step 6: Commit**

```bash
git add daemon/scheduler.js daemon/daemon.js daemon/scheduler.test.js
git commit -m "feat(daemon): validate config each tick; findings ride the model, logged deduped"
```

---

### Task 7: Panel config-warning strip + e2e

**Files:**
- Modify: `daemon/web/view-model.js` (pass `configFindings` through `toPanelView`)
- Modify: `daemon/web/render.js` (new `renderConfigWarnings`)
- Modify: `daemon/web/app.js` (render below header; toggle handler; `ui.cfgOpen` state)
- Modify: `daemon/web/styles.css`
- Test: `daemon/web/view-model.test.js`, `daemon/web/render.test.js`, `daemon/web/contract.test.js`, `e2e/panel.smoke.spec.js`

**Interfaces:**
- Consumes: `model.configFindings` (Task 6); existing `toPanelView`, `esc`, delegated-click pattern in `app.js`.
- Produces: `renderConfigWarnings(findings, open) -> string`; `view.configFindings`; data-attrs `data-cfgwarn-toggle`. Nothing downstream consumes these.

- [ ] **Step 1: Write the failing unit tests**

`daemon/web/view-model.test.js` (inside the `toPanelView` describe):

```js
  it("passes configFindings through, defaulting to []", () => {
    assert.deepEqual(toPanelView({ items: [], accounts: {} }).configFindings, []);
    const f = [{ level: "error", path: "p", message: "m" }];
    assert.deepEqual(toPanelView({ items: [], accounts: {}, configFindings: f }).configFindings, f);
  });
```

`daemon/web/render.test.js` (new describe; import `renderConfigWarnings`):

```js
describe("renderConfigWarnings", () => {
  const f = [
    { level: "error", path: "companies[x].provider", message: "bad provider" },
    { level: "warning", path: "companies[x].myEmail", message: "missing" },
  ];
  it("renders nothing when clean", () => {
    assert.equal(renderConfigWarnings([], false), "");
    assert.equal(renderConfigWarnings(undefined, false), "");
  });
  it("collapsed: shows the count and the toggle attr, not the details", () => {
    const html = renderConfigWarnings(f, false);
    assert.match(html, /config: 2 issues/);
    assert.match(html, /data-cfgwarn-toggle/);
    assert.doesNotMatch(html, /bad provider/);
  });
  it("open: lists each finding's path and message, marking warnings", () => {
    const html = renderConfigWarnings(f, true);
    assert.match(html, /companies\[x\]\.provider/);
    assert.match(html, /bad provider/);
    assert.match(html, /\(warning\)/);
  });
  it("singular copy for one finding, and escapes content", () => {
    const one = [{ level: "error", path: "<p>", message: "<m>" }];
    assert.match(renderConfigWarnings(one, false), /config: 1 issue\b/);
    const html = renderConfigWarnings(one, true);
    assert.doesNotMatch(html, /<p>/);
    assert.match(html, /&lt;p&gt;/);
  });
});
```

`daemon/web/contract.test.js` (append to the existing describe):

```js
  it("app toggles the config-warning strip render.js emits", () => {
    assert.match(render, /data-cfgwarn-toggle/, "render must emit data-cfgwarn-toggle");
    assert.match(app, /\[data-cfgwarn-toggle\]/, "app must select [data-cfgwarn-toggle]");
    assert.match(app, /renderConfigWarnings/, "app must render the strip");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test daemon/web/view-model.test.js daemon/web/render.test.js daemon/web/contract.test.js`
Expected: FAIL — missing export / missing passthrough / missing attrs.

- [ ] **Step 3: Implement**

`daemon/web/view-model.js` — in `toPanelView`'s return object (line 67-73), add:

```js
    configFindings: model.configFindings || [],
```

`daemon/web/render.js` — add after `renderNoticeBar`:

```js
/** Config validator findings: collapsed one-liner, click to expand. Purely informational. */
export function renderConfigWarnings(findings, open) {
  if (!findings?.length) return "";
  const n = findings.length;
  const head = `<div class="cfgwarn-h" data-cfgwarn-toggle>⚠ config: ${n} issue${n === 1 ? "" : "s"}`
    + ` <span class="chev">${open ? "▾" : "▸"}</span></div>`;
  const list = open
    ? `<ul class="cfgwarn-list">${findings.map(f =>
        `<li><code>${esc(f.path)}</code> — ${esc(f.message)}${f.level === "warning" ? " (warning)" : ""}</li>`
      ).join("")}</ul>`
    : "";
  return `<div class="cfgwarn">${head}${list}</div>`;
}
```

`daemon/web/app.js`:
- add `renderConfigWarnings` to the import from `./render.js` (line 7);
- add `cfgOpen: false` to the `ui` state object (near the other flags like `confirm`/`busy`);
- in `draw()` (line 62), insert directly after `renderHeader(view)`:

```js
    + renderConfigWarnings(view.configFindings, ui.cfgOpen)
```

- in the delegated click handler, alongside the other `closest()` checks and BEFORE the `[data-loadbody]` fallthrough:

```js
  const cfg = t.closest("[data-cfgwarn-toggle]");
  if (cfg) { ui.cfgOpen = !ui.cfgOpen; draw(); return; }
```

`daemon/web/styles.css` — append:

```css
.cfgwarn { margin:6px 0; font-size:13px; }
.cfgwarn-h { color:#c9a227; cursor:pointer; user-select:none; }
.cfgwarn-h .chev { color:#8a94a6; }
.cfgwarn-list { margin:4px 0 0 16px; padding:0; color:#8a94a6; }
.cfgwarn-list li { margin:2px 0; }
.cfgwarn-list code { color:#c9a227; background:#0c111b; padding:0 4px; border-radius:4px; }
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `node --test daemon/web/view-model.test.js daemon/web/render.test.js daemon/web/contract.test.js`
Expected: PASS.

- [ ] **Step 5: Add the e2e coverage**

In `e2e/panel.smoke.spec.js` `beforeAll` (line 84-86), change the companies fixture — give brickell a valid `myEmail` (keeps unrelated findings out) and plant EXACTLY ONE malformed rule:

```js
  writeFileSync(join(configDir, "companies.json"), JSON.stringify({ companies: [
    { id: "brickell", name: "Brickell", accountType: "business", provider: "outlook",
      pollMinutes: 999, myEmail: "me@brickell.example",
      prioritySenders: [{ type: "bogus", value: "x" }] },
  ] }), "utf-8");
```

Append the test:

```js
test("config validator finding surfaces as an expandable panel strip", async ({ page }) => {
  await page.goto(base);
  const head = page.locator(".cfgwarn-h");
  await expect(head).toContainText("config: 1 issue");
  await expect(page.locator(".cfgwarn-list")).toHaveCount(0); // collapsed by default
  await head.click();
  await expect(page.locator(".cfgwarn-list li")).toContainText("prioritySenders[0].type");
  await head.click();
  await expect(page.locator(".cfgwarn-list")).toHaveCount(0); // collapses again
});
```

- [ ] **Step 6: Run the e2e suite**

Run: `npx playwright test`
Expected: 4/4 pass (3 existing + the new one — existing tests don't assert the strip's absence, and the planted finding is account-scoped so nothing else changes).

- [ ] **Step 7: Commit**

```bash
git add daemon/web/view-model.js daemon/web/render.js daemon/web/app.js daemon/web/styles.css daemon/web/view-model.test.js daemon/web/render.test.js daemon/web/contract.test.js e2e/panel.smoke.spec.js
git commit -m "feat(panel): expandable config-warning strip fed by validator findings"
```

---

### Task 8: Docs + full verification

**Files:**
- Modify: `daemon/README.md`
- Test: whole suite + e2e

- [ ] **Step 1: Document the new behavior in `daemon/README.md`**

Add (matching the README's existing tone/structure):
- A "Config validation" subsection: findings ride `GET /model` as `configFindings`, appear as the panel's `⚠ config: N issues` strip, and are logged as `config-findings` events (deduped — logged only when the finding set changes). Warn-and-continue: malformed rules are skipped, the daemon never refuses to start over config.
- A note in the handled-tile description: "needs a reply" is conversation-denominated — distinct threads whose newest human message isn't yours; your own last word marks a thread handled; automated mail (List-Unsubscribe, automated local-parts, marketing subdomains) never needs you; urgency keywords only promote senders with standing (correspondents / prioritySenders / own domain).
- Restart note: fetch-layer/normalizer/classifier changes → daemon restart required at ship.

- [ ] **Step 2: Run the full unit suite**

Run: `npm test`
Expected: all pass, zero fail. Fix anything broken before proceeding.

- [ ] **Step 3: Run the full e2e suite**

Run: `npx playwright test`
Expected: 4/4 pass.

- [ ] **Step 4: Commit**

```bash
git add daemon/README.md
git commit -m "docs(daemon): config validation + conversation-aware handled counts"
```

---

## Ship-time steps (controller + user — NOT subagent tasks)

1. **Flag curation** (live edit to `config/companies.json`, never committed) — confirm final lists with the user, then apply:
   - healthcarema `urgencyRules.flags` → `["urgent", "call me", "please review", "deadline", "asap"]`; update `currentRule` prose.
   - brickellpay → drop `"hold"` (keep `"ACH hold"` and the rest).
   - summitmiami → `["closing", "close of escrow", "due diligence", "wire", "lender", "commitment", "inspection", "deadline", "urgent"]`.
2. Merge-gate: full `npm test` + `npx playwright test` on the merged result; ff-merge to master; push (verify gh account context first).
3. Restart the daemon from the main checkout; wait one tick.
4. **Live verification:** `curl -s http://localhost:8138/model` — compare handled counts against the pre-change baseline (healthcarema needsYou was 124, brickellpay 32) and spot-check the drill-in: own-address threads no longer counted, `notification.`-domain senders in Bulk senders, config strip absent (or listing real findings).
