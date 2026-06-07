# Gmail Signal Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hydrate Gmail bulk signals (category labels, Precedence, recipients) via one shared `mapGmailMessage`, so `detectBulkSignals` can score genuinely-bulk Gmail mail ≥3 and the confidence tier gets real signal on the 1,275-candidate Gmail lane.

**Architecture:** Add an exported pure `mapGmailMessage(msg, opts)` to `scripts/gmail-client.js` (mirrors the exported `mapOutlookMessage` from Leak-2). Point the three divergent Gmail fetch sites — `build-bundle.js` (`fetchAllGmail`, the diagnosed gap), `fetch-gmail.js`, and `triage.js` — at it, widening their `metadataHeaders` to the full set. Correctness/data-completeness fix; no change to `detectBulkSignals` or the tier's cutoff logic.

**Tech Stack:** Node.js (ESM, `node --test`, `node:assert/strict`). Pure mapping function; unit-tested offline (no live Gmail needed for implementation). Spec: `docs/superpowers/specs/2026-06-07-gmail-signal-hydration-design.md`.

**Repo conventions:**
- Implementation runs offline (`node --test`) — a git **worktree is fine** for this work (unlike `/issues`, which needs live config). The post-landing *validation* run is separate and needs the main repo.
- Prefix bash commands with the repo root (the agent's worktree root). Tests: `node --test <file>`; full suite: `npm test`.
- Multi-line commit messages: bash heredoc (`git commit -F - <<'EOF' … EOF`), never PowerShell `@'…'@` in the Bash tool.
- Append: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Baseline before this work: `master` at `f9e1090` (spec) / `c893043` (guard notes). Full suite is 304 tests, 0 fail.

---

## File structure

**Modify:**
- `scripts/gmail-client.js` — add `export function mapGmailMessage(msg, opts = {})`. Owns "normalize one Gmail message resource into the email shape the classifier/scorer consume."
- `scripts/build-bundle.js` — `fetchAllGmail`: widen headers, use the mapper (the diagnosed fix).
- `scripts/fetch-gmail.js` — widen headers, use the mapper.
- `scripts/triage.js` — use the mapper (deprecated `/triage` path; included to kill the 3-way drift — purely a mapping substitution).

**Create:**
- `scripts/test/gmail-client.test.js`.

---

## Task 1: `mapGmailMessage` + unit tests (TDD)

**Files:**
- Modify: `scripts/gmail-client.js`
- Create: `scripts/test/gmail-client.test.js`

- [ ] **Step 1: Write the failing test — create `scripts/test/gmail-client.test.js`**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapGmailMessage } from "../gmail-client.js";
import { detectBulkSignals } from "../classify-emails.js";

// A Gmail users.messages.get resource (the `res.data` object).
function resource(over = {}) {
  return {
    id: "g1", threadId: "t1", internalDate: "1717000000000", snippet: "hello there",
    labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
    payload: { headers: [
      { name: "From", value: "Deals Team <deals@shop.com>" },
      { name: "Subject", value: "Big Sale" },
      { name: "Date", value: "Wed, 29 May 2024 12:00:00 +0000" },
      { name: "List-Unsubscribe", value: "<mailto:u@shop.com>" },
      { name: "Precedence", value: "Bulk" },
      { name: "To", value: "list@shop.com" },
      { name: "Cc", value: "" },
    ] },
    ...over,
  };
}

describe("mapGmailMessage — hydrates bulk signals", () => {
  it("extracts subject/from/fromName, categories (CATEGORY_* only), precedence, recipients", () => {
    const e = mapGmailMessage(resource());
    assert.equal(e.id, "g1");
    assert.equal(e.threadId, "t1");
    assert.equal(e.subject, "Big Sale");
    assert.equal(e.from, "deals@shop.com");
    assert.equal(e.fromName, "Deals Team");
    assert.equal(e.hasListUnsubscribe, true);
    assert.equal(e.precedence, "bulk");
    assert.equal(e.toRecipients, "list@shop.com");
    assert.equal(e.ccRecipients, "");
    assert.deepEqual(e.gmailCategories, ["CATEGORY_PROMOTIONS"]); // INBOX/UNREAD dropped
    assert.equal(e.isRead, false); // UNREAD present
    assert.equal(e.importance, "normal");
  });

  it("parses a bare-address From (no display name)", () => {
    const e = mapGmailMessage(resource({ payload: { headers: [{ name: "From", value: "solo@x.com" }] } }));
    assert.equal(e.from, "solo@x.com");
    assert.equal(e.fromName, "");
  });

  it("receivedAt from internalDate; falls back to Date header when internalDate absent", () => {
    const withId = mapGmailMessage(resource());
    assert.equal(withId.receivedAt, new Date(1717000000000).toISOString());
    const noId = mapGmailMessage(resource({ internalDate: undefined }));
    assert.equal(noId.receivedAt, new Date("Wed, 29 May 2024 12:00:00 +0000").toISOString());
    assert.equal(noId.received, new Date("Wed, 29 May 2024 12:00:00 +0000").toISOString());
  });

  it("flags IMPORTANT and missing labels safely", () => {
    const imp = mapGmailMessage(resource({ labelIds: ["INBOX", "IMPORTANT"] }));
    assert.equal(imp.importance, "high");
    assert.equal(imp.isRead, true); // no UNREAD
    const bare = mapGmailMessage({ id: "g2", payload: { headers: [] } });
    assert.equal(bare.hasListUnsubscribe, false);
    assert.equal(bare.precedence, "");
    assert.equal(bare.toRecipients, "");
    assert.deepEqual(bare.gmailCategories, []);
    assert.equal(bare.importance, "normal");
    assert.equal(bare.isRead, true);
  });

  it("applies opts.previewLimit to the snippet", () => {
    const e = mapGmailMessage(resource({ snippet: "x".repeat(500) }), { previewLimit: 300 });
    assert.equal(e.preview.length, 300);
    const full = mapGmailMessage(resource({ snippet: "x".repeat(500) }));
    assert.equal(full.preview.length, 500);
  });

  it("hydrated signals let a bulk Gmail message reach detectBulkSignals score >=3", () => {
    // CATEGORY_PROMOTIONS + List-Unsubscribe + Precedence:bulk + user-not-in-To = 4 signals.
    const e = mapGmailMessage(resource());
    const { score } = detectBulkSignals(e, "me@personal.com");
    assert.ok(score >= 3, `expected >=3 bulk signals, got ${score}`);
  });
});
```

- [ ] **Step 2: Run the test, confirm it FAILS**

Run: `node --test scripts/test/gmail-client.test.js`
Expected: FAIL — `does not provide an export named 'mapGmailMessage'`.

- [ ] **Step 3: Add `mapGmailMessage` to `scripts/gmail-client.js`** (append after `buildGmailClient`, before EOF)

```javascript
/**
 * Maps a Gmail `users.messages.get` resource (the `res.data` object, fetched with
 * format:"metadata" and metadataHeaders From,Subject,Date,List-Unsubscribe,
 * Precedence,To,Cc) into the normalized email shape the classifier + detectBulkSignals
 * consume. Mirrors build-bundle's mapOutlookMessage: hydrates ALL bulk signals Gmail
 * exposes — category labels (the strongest), Precedence, and To/Cc recipients (BCC
 * signal) — not just List-Unsubscribe. Pure; never throws on missing fields.
 */
export function mapGmailMessage(msg, opts = {}) {
  const headers = msg.payload?.headers || [];
  const h = (name) => {
    const found = headers.find((x) => (x.name || "").toLowerCase() === name.toLowerCase());
    return found ? (found.value || "") : "";
  };
  const fromRaw = h("From");
  let fromName = "";
  let from = fromRaw.trim();
  const m = fromRaw.match(/^"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) { fromName = m[1].trim(); from = m[2].trim(); }

  const dateHeader = h("Date");
  let received = dateHeader;
  if (dateHeader) {
    const d = new Date(dateHeader);
    if (!isNaN(d.getTime())) received = d.toISOString();
  }
  const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : received;

  const labelIds = msg.labelIds || [];
  const snippet = msg.snippet || "";
  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: h("Subject"),
    from,
    fromName,
    received,
    receivedAt,
    isRead: !labelIds.includes("UNREAD"),
    importance: labelIds.includes("IMPORTANT") ? "high" : "normal",
    hasAttachments: (msg.payload?.parts || []).some((p) => p.filename && p.filename.length > 0),
    preview: opts.previewLimit ? snippet.slice(0, opts.previewLimit) : snippet,
    hasListUnsubscribe: !!h("List-Unsubscribe"),
    precedence: h("Precedence").toLowerCase(),
    toRecipients: h("To"),
    ccRecipients: h("Cc"),
    gmailCategories: labelIds.filter((l) => l.startsWith("CATEGORY_")),
  };
}
```

- [ ] **Step 4: Run the test, confirm PASS**

Run: `node --test scripts/test/gmail-client.test.js`
Expected: all 6 cases green (incl. the score≥3 integration case).

- [ ] **Step 5: Commit**

```bash
git add scripts/gmail-client.js scripts/test/gmail-client.test.js && git commit -F - <<'EOF'
feat(gmail-client): add shared mapGmailMessage hydrating all bulk signals

Mirrors mapOutlookMessage (Leak-2): normalizes a Gmail message resource and
hydrates CATEGORY_* labels, Precedence, and To/Cc recipients — not just
List-Unsubscribe — so detectBulkSignals can score bulk Gmail mail >=3. Pure,
defensive, unit-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: Use the mapper in `build-bundle.js` `fetchAllGmail` (the diagnosed fix)

`fetchAllGmail` lives in the CLI block (not in the dep-injected `buildBundle`), so it isn't covered by `build-bundle.test.js` — exactly like `fetchAllOutlook`. The mapper itself is unit-tested in Task 1; this task is wiring, verified by `node --check` + the full suite staying green + (later) the live run.

**Files:**
- Modify: `scripts/build-bundle.js`

- [ ] **Step 1: Add `mapGmailMessage` to the dynamic import in the CLI block**

Find:
```javascript
  const { buildGmailClient } = await import("./gmail-client.js");
```
Replace with:
```javascript
  const { buildGmailClient, mapGmailMessage } = await import("./gmail-client.js");
```

- [ ] **Step 2: Widen the headers and use the mapper in `fetchAllGmail`**

Find (the per-message hydration loop):
```javascript
    for (const { id } of ids) {
      const m = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe"] });
      const h = Object.fromEntries((m.data.payload?.headers || []).map(x => [x.name, x.value]));
      out.push({ id, subject: h.Subject, from: (h.From || "").replace(/.*<(.+)>.*/, "$1"), fromName: (h.From || "").replace(/<.*>/, "").trim(), receivedAt: new Date(Number(m.data.internalDate)).toISOString(), preview: m.data.snippet, hasListUnsubscribe: !!h["List-Unsubscribe"] });
    }
```
Replace with:
```javascript
    for (const { id } of ids) {
      const m = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe", "Precedence", "To", "Cc"] });
      out.push(mapGmailMessage(m.data));
    }
```

- [ ] **Step 3: Verify syntax + full suite green**

Run: `node --check scripts/build-bundle.js && npm test 2>&1 | tail -6`
Expected: `node --check` silent (OK); suite `fail 0` (still ~310 with Task 1's new tests). No build-bundle test regressions — those inject `fetchAllFn`, bypassing `fetchAllGmail`.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-bundle.js && git commit -F - <<'EOF'
fix(build-bundle): hydrate Gmail bulk signals via mapGmailMessage (Gmail lane)

fetchAllGmail discarded labelIds and omitted Precedence/To/Cc, capping Gmail
candidates at bulkScore 2 and blinding the confidence tier on the largest lane.
Widen metadataHeaders and use the shared mapGmailMessage so CATEGORY_*, precedence,
and recipients reach detectBulkSignals.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: Use the mapper in `fetch-gmail.js`

Replaces the inline mapping (currently `gmailCategories: res.data.labelIds` — ALL labels; `received` raw). Switching to the mapper makes `gmailCategories` `CATEGORY_*`-filtered and `received` ISO — both documented, safe corrections.

**Files:**
- Modify: `scripts/fetch-gmail.js`

- [ ] **Step 1: Import the mapper.** In `scripts/fetch-gmail.js`, find:
```javascript
import { buildGmailClient } from "./gmail-client.js";
```
Replace with:
```javascript
import { buildGmailClient, mapGmailMessage } from "./gmail-client.js";
```

- [ ] **Step 2: Widen headers + use the mapper.** Find the per-message block:
```javascript
      const res = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe", "Precedence"],
      });
      const headers = res.data.payload?.headers || [];
      const h = (name) => (headers.find(x => x.name.toLowerCase() === name.toLowerCase())?.value || "");
      const fromHeader = h("From");
      // "Display Name <user@host.com>" or "user@host.com"
      const angleMatch = fromHeader.match(/^([^<]*)<([^>]+)>$/);
      const fromName = angleMatch ? angleMatch[1].trim().replace(/^"|"$/g, "") : "";
      const from = angleMatch ? angleMatch[2].trim() : fromHeader.trim();
      const received = h("Date");
      return {
        id,
        threadId: res.data.threadId,
        subject: h("Subject"),
        from,
        fromName,
        received,
        receivedAt: received ? new Date(received).toISOString() : null,
        isRead: !(res.data.labelIds || []).includes("UNREAD"),
        importance: "normal",
        hasAttachments: false, // metadata format doesn't expose attachments cheaply
        preview: res.data.snippet || "",
        hasListUnsubscribe: !!h("List-Unsubscribe"),
        precedence: h("Precedence").toLowerCase(),
        gmailCategories: res.data.labelIds || [],
      };
```
Replace with:
```javascript
      const res = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe", "Precedence", "To", "Cc"],
      });
      return mapGmailMessage(res.data);
```

- [ ] **Step 3: Verify syntax + full suite green**

Run: `node --check scripts/fetch-gmail.js && npm test 2>&1 | tail -6`
Expected: `node --check` OK; suite `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-gmail.js && git commit -F - <<'EOF'
refactor(fetch-gmail): use shared mapGmailMessage

Replaces inline mapping with mapGmailMessage; widens headers to add To/Cc.
gmailCategories now CATEGORY_*-filtered (was all labels) and received is ISO —
both corrections. Kills one of three divergent Gmail mappers.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: Use the mapper in `triage.js` (deprecated `/triage` path)

`triage.js` already fetches the full header set and is the reference for the superset. This substitution must preserve its output for any consumer (notably its `fromName || from` fallback and the 300-char preview slice). Verified by the full suite (incl. `morning-brief.test.js`).

**Files:**
- Modify: `scripts/triage.js`

- [ ] **Step 1: Import the mapper.** In `scripts/triage.js`, find:
```javascript
import { buildGmailClient } from "./gmail-client.js";
```
Replace with:
```javascript
import { buildGmailClient, mapGmailMessage } from "./gmail-client.js";
```

- [ ] **Step 2: Replace the inline mapping** inside the `for (const res of results)` loop. Find:
```javascript
    for (const res of results) {
      const headers = res.data.payload?.headers || [];
      const getHeader = (name) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

      const fromRaw = getHeader("From");
      let fromName = "";
      let fromEmail = fromRaw;
      const match = fromRaw.match(/^"?([^"<]*?)"?\s*<([^>]+)>/);
      if (match) {
        fromName = match[1].trim();
        fromEmail = match[2].trim();
      }

      const dateStr = getHeader("Date");
      let received;
      try { received = new Date(dateStr).toISOString(); } catch { received = dateStr; }

      const labelIds = res.data.labelIds || [];
      emails.push({
        id: res.data.id,
        subject: getHeader("Subject"),
        from: fromEmail,
        fromName: fromName || fromEmail,
        received,
        isRead: !labelIds.includes("UNREAD"),
        importance: labelIds.includes("IMPORTANT") ? "high" : "normal",
        hasAttachments: (res.data.payload?.parts || []).some(
          (p) => p.filename && p.filename.length > 0
        ),
        preview: (res.data.snippet || "").slice(0, 300),
        hasListUnsubscribe: !!getHeader("List-Unsubscribe"),
        precedence: getHeader("Precedence") || null,
        toRecipients: getHeader("To"),
        ccRecipients: getHeader("Cc"),
        gmailCategories: labelIds.filter((l) => l.startsWith("CATEGORY_")),
      });
    }
```
Replace with:
```javascript
    for (const res of results) {
      const e = mapGmailMessage(res.data, { previewLimit: 300 });
      e.fromName = e.fromName || e.from; // preserve triage's display-name fallback
      emails.push(e);
    }
```

- [ ] **Step 3: Verify syntax + full suite green**

Run: `node --check scripts/triage.js && npm test 2>&1 | tail -6`
Expected: `node --check` OK; suite `fail 0`. If any `morning-brief`/triage-related test fails, the output shape diverged — compare the failing assertion against the mapper's fields and reconcile (the mapper is a superset, so failures are most likely a renamed/missing field a consumer relied on; do NOT change the mapper's contract established in Task 1 — adapt at the triage call site).

- [ ] **Step 4: Commit**

```bash
git add scripts/triage.js && git commit -F - <<'EOF'
refactor(triage): use shared mapGmailMessage

Substitutes the inline Gmail mapping for the shared mapper (preserving the
fromName||from fallback and 300-char preview). Removes the last of three
divergent Gmail mappers.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Validation (post-implementation, manual — in the MAIN repo)

Not a code task. After all four tasks merge to master, in the **main repo** (live config + tokens; never a worktree):

1. `node scripts/build-bundle.js --since 30d` → re-inspect the candidate `bulkScore` distribution. **Expect `personal` (Gmail) to now populate scores 3–4** (it capped at 2 before). Compare against the 2026-06-07 baseline in the spec.
2. Re-measure tier eligibility by cutoff (the diagnostic from this session) and pick a calibrated `scoreCutoff`.
3. Run the `/issues` shadow gate + `tier-audit` to measure false-trash at the new cutoff. Graduate an account to `active` only at zero false-trash.

---

## Self-review notes (completed)

- **Spec coverage:** shared `mapGmailMessage` with the exact normalized superset + reconciliation rules (Task 1); the three site refactors (Tasks 2–4); behavior-preservation via full-suite + node --check; cutoff recalibration explicitly deferred to the Validation section. All spec sections map to a task.
- **Placeholder scan:** none — every step has exact find/replace code and a runnable command.
- **Type consistency:** `mapGmailMessage(msg, opts)` returns the same field set used in the Task-1 test and consumed by `detectBulkSignals` (`gmailCategories`, `precedence`, `toRecipients`, `ccRecipients`, `hasListUnsubscribe`) and by build-bundle (`from`, `fromName`, `subject`, `receivedAt`, `preview`, `hasListUnsubscribe`, + the new signal fields). Triage's `fromName||from` preserved at the call site.
- **Known consideration:** `triage.js` is the deprecated `/triage` path; if a future reader confirms it is fully dead and untested, Task 4 may be skipped without affecting the tier fix (Tasks 1–2 are the load-bearing ones). Kept here per the approved "kill the drift" scope.
