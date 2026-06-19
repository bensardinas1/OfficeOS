# Panel Actions — Plan C: Run Triage + Cleanup Surface

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Run triage" button that runs the existing triage connector on demand and surfaces its deletion candidates as a per-inbox "Cleanup" tile whose rows reuse Plan B's Delete / Kill-list and Plan A's body view.

**Architecture:** `triage.js` writes `data/pending-deletions.json`. A pure `normalizeTriage(pendingDeletions, account)` maps that file's candidates (filtered to the account) into one Cleanup item; `runNormalizers` emits it whenever pending-deletions data is passed in (no per-type config needed). The scheduler threads the file in via `deps.getPendingDeletions()`. `POST /actions/triage` shells the connector then re-ticks; the panel adds a Run-triage button with a running state.

**Tech Stack:** Node ESM, `node:test`, vanilla browser JS/CSS.

**Spec:** `docs/superpowers/specs/2026-06-18-panel-actions-design.md` (Plan C of 3). Plans A + B merged.

**Baseline:** full suite green (546/546). Run `npm test`. Keep green.

**Rails:** triage is read-only fetch/classify + writes the candidate file; deletes nothing. Cleanup rows act via Plan B's soft-delete / config-only kill-list. No auto-send.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `scripts/triage.js` | candidate file | enrich entries with `from` + `receivedAt` |
| `daemon/normalizers/triage.js` | pure candidates→Cleanup item | create |
| `daemon/normalizers/index.js` | registry | emit triage item when pendingDeletions passed |
| `daemon/scheduler.js` | tick | thread `getPendingDeletions()` into runNormalizers |
| `daemon/daemon.js` | wiring | load candidate file; `runTriageFn`; `onTriage` re-tick |
| `daemon/api.js` | route | `POST /actions/triage` |
| `daemon/web/render.js` | header control | Run-triage button |
| `daemon/web/app.js` | glue | run-triage handler + running state |
| `daemon/web/styles.css` | styling | button/running |
| tests | `triage.test.js` (create); extend `index`/`api`/`render`/`contract` tests | |

---

## Task 1: Candidate enrichment + `normalizeTriage` + registry

**Files:**
- Modify: `scripts/triage.js`, `daemon/normalizers/index.js`
- Create: `daemon/normalizers/triage.js`, `daemon/normalizers/triage.test.js`

- [ ] **Step 1: Write failing tests**

Create `daemon/normalizers/triage.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTriage } from "./triage.js";

const account = { id: "brickell" };
const cands = [
  { number: 1, id: "e1", accountId: "brickell", provider: "outlook", sender: "Promo Co", from: "promo@x.com", subject: "Sale", receivedAt: "2026-06-10T00:00:00Z" },
  { number: 2, id: "e2", accountId: "brickell", provider: "outlook", sender: "News", from: "news@y.com", subject: "Digest", receivedAt: "2026-06-12T00:00:00Z" },
  { number: 3, id: "e9", accountId: "other", provider: "gmail", sender: "X", from: "x@z.com", subject: "nope", receivedAt: "2026-06-11T00:00:00Z" },
];

describe("normalizeTriage", () => {
  it("emits one Cleanup item for the account's candidates, newest-first", () => {
    const items = normalizeTriage(cands, account);
    assert.equal(items.length, 1);
    const it0 = items[0];
    assert.equal(it0.id, "brickell:triage");
    assert.equal(it0.jobType, "triage");
    assert.equal(it0.status, "ok");
    assert.match(it0.title, /2 to clean up/);
    assert.equal(it0.group.members.length, 2);
    assert.equal(it0.group.members[0].emailId, "e2"); // newest first
    assert.equal(it0.group.members[0].from, "news@y.com");
    assert.equal(it0.group.members[0].fromName, "News");
    assert.ok(!it0.group.members.some(m => m.emailId === "e9")); // other account excluded
  });
  it("returns [] when the account has no candidates", () => {
    assert.deepEqual(normalizeTriage(cands, { id: "empty" }), []);
    assert.deepEqual(normalizeTriage([], account), []);
    assert.deepEqual(normalizeTriage(null, account), []);
  });
  it("caps at 50 and reports moreCount", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, accountId: "brickell", sender: "S", from: "s@x.com", subject: `s${i}`, receivedAt: `2026-06-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z` }));
    const it0 = normalizeTriage(many, account)[0];
    assert.equal(it0.group.members.length, 50);
    assert.equal(it0.group.moreCount, 10);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/normalizers/triage.test.js`
Expected: FAIL — cannot import `normalizeTriage`.

- [ ] **Step 3: Create `daemon/normalizers/triage.js`**

```js
/**
 * normalizers/triage.js — pure transform from the triage connector's
 * pending-deletions list into ONE per-account "Cleanup" item (status "ok").
 * Members are the deletion candidates for this account, newest-first, capped.
 * Returns [] when the account has no candidates (no empty tile).
 */
export function normalizeTriage(pendingDeletions, account, opts = {}) {
  const CAP = opts.cap ?? 50;
  const mine = (pendingDeletions || []).filter(c => c.accountId === account.id);
  if (!mine.length) return [];
  const sorted = mine.slice().sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
  const members = sorted.slice(0, CAP).map(c => ({
    subject: c.subject, from: c.from, fromName: c.sender, receivedAt: c.receivedAt, emailId: c.id,
  }));
  return [{
    id: `${account.id}:triage`,
    jobType: "triage",
    account: account.id,
    title: `${mine.length} to clean up`,
    status: "ok",
    group: { rootCause: "cleanup", members, moreCount: Math.max(0, mine.length - CAP), counts: { candidates: mine.length } },
    source: [],
    proposedActions: [],
    lastChanged: null,
  }];
}
```

- [ ] **Step 4: Register in `daemon/normalizers/index.js`**

Add the import near the others:

```js
import { normalizeTriage } from "./triage.js";
```

In `runNormalizers`, after the `for (const jobType ...)` loop and before `return items;`, add:

```js
  if (opts.pendingDeletions) items.push(...normalizeTriage(opts.pendingDeletions, account, opts));
```

- [ ] **Step 5: Enrich the candidate entries in `scripts/triage.js`**

In `renderDeletionCandidates`, the `pendingDeletions.push({...})` object — add `from` and `receivedAt`:

```js
      pendingDeletions.push({
        number: num,
        id: e.id,
        accountId: r.accountId,
        provider: r.provider,
        sender: e.fromName,
        from: e.from,
        receivedAt: e.receivedAt || e.received,
        subject: e.subject,
      });
```

- [ ] **Step 6: Run the tests**

Run: `node --test daemon/normalizers/triage.test.js daemon/normalizers/index.test.js`
Expected: PASS for triage.test.js. (If `index.test.js` does not exist, just run the triage test.) Also run `node --check scripts/triage.js` to confirm no syntax error.

- [ ] **Step 7: Commit**

```bash
git add daemon/normalizers/triage.js daemon/normalizers/triage.test.js daemon/normalizers/index.js scripts/triage.js
git commit -m "feat(triage): Cleanup normalizer + enriched candidate entries"
```

---

## Task 2: Scheduler thread-through + daemon wiring + `POST /actions/triage`

**Files:**
- Modify: `daemon/scheduler.js`, `daemon/daemon.js`, `daemon/api.js`
- Test: `daemon/api.test.js`, `daemon/scheduler.test.js`

- [ ] **Step 1: Add a failing scheduler test (pendingDeletions surfaces a triage item)**

In `daemon/scheduler.test.js`, add a test (the `deps(dir, over)` helper supports overrides):

```js
  it("emits a triage Cleanup item from getPendingDeletions", async () => {
    const dir = tmp();
    try {
      const d = deps(dir, { getPendingDeletions: () => [{ id: "e1", accountId: "brickell", sender: "S", from: "s@x.com", subject: "junk", receivedAt: "2026-06-15T00:00:00Z" }] });
      await runTick(d);
      const model = d.store.getModel();
      const t = model.items.find(i => i.jobType === "triage" && i.id === "brickell:triage");
      assert.ok(t, "expected a triage item");
      assert.equal(t.group.members[0].emailId, "e1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/scheduler.test.js`
Expected: FAIL — no triage item (scheduler doesn't pass pendingDeletions yet).

- [ ] **Step 3: Thread `pendingDeletions` through `daemon/scheduler.js`**

Find the `runNormalizers(classifiedByFolder, account, typeConfig, { ... })` call and add `pendingDeletions`:

```js
    const items = await runNormalizers(classifiedByFolder, account, typeConfig, { reasonerFn: deps.reasonerFn, nowMs: Date.parse(clock.now), pendingDeletions: deps.getPendingDeletions ? deps.getPendingDeletions() : null });
```

- [ ] **Step 4: Run the scheduler test**

Run: `node --test daemon/scheduler.test.js`
Expected: PASS (the new test + all existing).

- [ ] **Step 5: Add failing api test for the triage endpoint**

In `daemon/api.test.js` `before()`, after the `killlistFn` stub, add:

```js
  let triaged = 0, reticked = 0;
  const runTriageFn = async () => { triaged++; return { ok: true }; };
  const onTriage = async () => { reticked++; };
```

Update the `createApiServer({...})` call to pass them (keep all existing deps):

```js
    accounts: [{ id: "brickell" }], fetchBodyFn, deleteFn, killlistFn, runTriageFn, onTriage });
```

(You will need to hoist `triaged`/`reticked` to module scope like `acks` if a test asserts them — add `let triaged, reticked;` to the module-scope `let` line and use `triaged = 0; reticked = 0;` in before(). Then:)

Append a describe block:

```js
describe("POST /actions/triage", () => {
  it("runs triage and re-ticks", async () => {
    const before = triaged;
    const body = await (await fetch(`${base}/actions/triage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })).json();
    assert.equal(body.ok, true);
    assert.equal(triaged, before + 1);
    assert.ok(reticked >= 1);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `node --test daemon/api.test.js`
Expected: FAIL — `/actions/triage` not handled.

- [ ] **Step 7: Add the route in `daemon/api.js`**

Destructure the new deps — extend the deps line to add `runTriageFn, onTriage`:

```js
  const { store, ctxFor, getLastTickAt, webDir = DEFAULT_WEB_DIR, ackStore, clock, accounts = [], fetchBodyFn, deleteFn, killlistFn, runTriageFn, onTriage } = deps;
```

Add the route among the POST handlers (after `/senders/killlist`, before the GET serveStatic fallback):

```js
    if (req.method === "POST" && path === "/actions/triage") {
      const body = await readJson(req);
      try {
        const r = await runTriageFn(body?.account || null);
        if (onTriage) await onTriage();
        return send(res, 200, { ok: true, ...r });
      } catch (err) { return send(res, 200, { ok: false, error: err.message }); }
    }
```

- [ ] **Step 8: Run the api test**

Run: `node --test daemon/api.test.js`
Expected: PASS.

- [ ] **Step 9: Wire `daemon/daemon.js`**

Add a candidate-file reader near `loadConfig` (after the `runProcess` helper or near the other helpers):

```js
function getPendingDeletions() {
  try { return JSON.parse(readFileSync(join(root, "data/pending-deletions.json"), "utf-8")); }
  catch { return null; }
}

async function runTriageFn(accountId) {
  const r = await runProcess("node", [join(root, "scripts", "triage.js"), accountId || "all"], { timeoutMs: 120000 });
  if (r.status !== 0) throw new Error(r.stderr || "triage failed");
  return { ok: true };
}
```

In `main()`, add `getPendingDeletions` to the `deps(emit)` object (so the scheduler can read candidates each tick):

```js
    getAcks: () => ackStore.getAcks(),
    getPendingDeletions,
```

Update the `createApiServer({...})` call to pass `runTriageFn` and an `onTriage` that runs a tick:

```js
  const server = createApiServer({ store, ctxFor, getLastTickAt: () => lastTickAt, ackStore, clock: { now: () => new Date().toISOString() }, accounts: companies.companies, fetchBodyFn: fetchBody, deleteFn: makeDeleteFn(), killlistFn, runTriageFn, onTriage: () => tick() });
```

(Note: `tick` is defined below in `main()`. Since `createApiServer` is called before `tick` is declared, define `onTriage: () => tick()` — the arrow defers the reference until invoked, by which point `tick` is hoisted via `function tick()`. Confirm `tick` is a `function` declaration, not a `const`; if it is a `const`, move the `createApiServer` call after the `tick` definition.)

- [ ] **Step 10: Verify the daemon loads**

Run: `node --check daemon/daemon.js && node --test daemon/api.test.js daemon/scheduler.test.js`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add daemon/scheduler.js daemon/daemon.js daemon/api.js daemon/api.test.js daemon/scheduler.test.js
git commit -m "feat(daemon): pendingDeletions in tick + POST /actions/triage"
```

---

## Task 3: Run-triage button + running state

**Files:**
- Modify: `daemon/web/render.js`, `daemon/web/app.js`, `daemon/web/styles.css`
- Test: `daemon/web/render.test.js`, `daemon/web/contract.test.js`

- [ ] **Step 1: Add failing tests**

In `daemon/web/render.test.js`, append:

```js
describe("renderRunTriage", () => {
  it("renders a Run triage button, disabled+labelled while running", () => {
    assert.match(renderRunTriage(false), /data-run-triage/);
    assert.match(renderRunTriage(false), /Run triage/);
    assert.match(renderRunTriage(true), /disabled/);
    assert.match(renderRunTriage(true), /Running/);
  });
});
```

Update the render.test import line to add `renderRunTriage`.

In `daemon/web/contract.test.js`, add inside the top-level describe:

```js
  it("app handles the run-triage action", () => {
    assert.match(render, /data-run-triage/, "render must emit data-run-triage");
    assert.match(app, /\[data-run-triage\]/, "app must select [data-run-triage]");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/web/render.test.js daemon/web/contract.test.js`
Expected: FAIL.

- [ ] **Step 3: Add `renderRunTriage` in `daemon/web/render.js`**

Add after `renderSelectControls`:

```js
export function renderRunTriage(running) {
  return `<button class="runtriage" data-run-triage ${running ? "disabled" : ""}>${running ? "Running triage…" : "Run triage"}</button>`;
}
```

- [ ] **Step 4: Wire `daemon/web/app.js`**

(a) Import `renderRunTriage`:

```js
import { renderHeader, renderAccountSection, renderDetailPanel, renderSelectControls, renderUndoBar, renderNoticeBar, renderRunTriage, esc } from "./render.js";
```

(b) Add `triaging: false` to `ui`:

```js
const ui = { account: "", query: "", collapsed: new Set(), detailItemId: null, undo: null, confirm: null, notice: null, triaging: false };
```

(c) In `draw()`, render the button in the filters row. Change the filters line to:

```js
    + `<div class="filters"><input id="q" placeholder="filter…" value="${esc(ui.query)}">${renderRunTriage(ui.triaging)}</div>`
```

(d) Add a `[data-run-triage]` handler in the click listener, after the `[data-loadbody]` block and before the shared `ui.confirm = null; ui.notice = null;` line:

```js
  const rt = e.target.closest("[data-run-triage]");
  if (rt) {
    if (ui.triaging) return;
    ui.confirm = null; ui.undo = null;
    ui.triaging = true; ui.notice = "Running triage…"; draw();
    postJson("/actions/triage", {}).then(r => {
      ui.triaging = false;
      ui.notice = r.ok === false ? `Triage failed: ${r.error}` : "Triage complete";
      return load();
    }).catch(() => { ui.triaging = false; ui.notice = "Triage failed"; draw(); });
    return;
  }
```

- [ ] **Step 5: Style in `daemon/web/styles.css`**

Append:

```css
.runtriage { margin-left:8px; background:#23314a; color:var(--accent); border:1px solid var(--line); border-radius:8px; padding:8px 12px; cursor:pointer; }
.runtriage[disabled] { opacity:.6; cursor:default; }
```

- [ ] **Step 6: Run the web suite**

Run: `node --test daemon/web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add daemon/web/render.js daemon/web/app.js daemon/web/styles.css daemon/web/render.test.js daemon/web/contract.test.js
git commit -m "feat(panel): Run triage button + running state"
```

---

## Task 4: Full suite + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS, total above the 546 baseline. (The reasoner test that shells `claude` logs "claude down" and fail-opens — still passes.)

- [ ] **Step 2: Manual smoke (operator)**

Restart the daemon from the main checkout and open the panel. Click **Run triage**: the button shows "Running triage…", and after it completes a **Cleanup tile** ("N to clean up") appears under each inbox that had junk candidates. Open its Details: the candidate emails are listed (sender · subject · date), each with Delete / Kill list (Plan B) and a Show-message body (Plan A). Verify a Delete moves the email to Trash (recoverable). Triage is a real fetch of live mail and writes `data/pending-deletions.json`; it deletes nothing on its own.

No commit unless the smoke surfaces a fix.

---

## Self-Review

**Spec coverage (Plan C):**
- Run triage button runs the connector on demand → Task 2 (`runTriageFn` + `POST /actions/triage`) + Task 3 (button). ✓
- Candidates surface as a per-inbox Cleanup tile to act on → Task 1 (`normalizeTriage`) + Task 2 (scheduler thread-through + re-tick). ✓
- Rows reuse Delete / Kill-list (Plan B) + body view (Plan A) → members carry `emailId`/`from`/`fromName`/`receivedAt`/`subject`, which the existing `renderDetailPanel` row buttons + body scaling consume. ✓
- No per-type config needed → `runNormalizers` emits the triage item whenever `opts.pendingDeletions` is present, outside the jobTypes loop. ✓
- Rails: triage read-only + writes candidate file; deletes via Plan B soft-delete. ✓

**Placeholder scan:** none — full code in every step.

**Type/name consistency:** candidate entry `{number,id,accountId,provider,sender,from,receivedAt,subject}` (Task 1 enrich) → `normalizeTriage` maps to member `{subject,from,fromName:sender,receivedAt,emailId:id}` (same member shape the detail panel + Plan B buttons already consume); `getPendingDeletions` (daemon) → `deps.getPendingDeletions()` (scheduler) → `opts.pendingDeletions` (runNormalizers/normalizeTriage); endpoint `/actions/triage` + `runTriageFn`/`onTriage`; render `renderRunTriage`/`data-run-triage`, app `ui.triaging`. Consistent across tasks. ✓
