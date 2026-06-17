# Ambient Proposal Panel — shared `acknowledge` capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user **acknowledge** a finding/ticket so it stops re-alerting in the panel — and **re-alerts automatically when it materially changes** (fingerprint-based). Item-level (not a proposal), shared by `gateway`/`audit` now and `exposed` next.

**Architecture:** A per-item **fingerprint** (pure hash of salient fields) is stamped on items by the scheduler. An **acknowledge store** (`data/acknowledged.json`, `itemId → {fingerprint, ackedAt}`) is loaded by the scheduler; a pure `applyAcks(items, acks)` forces an item's status to `ok` (and flags `acknowledged: true`) only while its fingerprint still matches the acked one. A new `POST /items/:id/acknowledge` endpoint records the ack; the panel renders an **Acknowledge** button (item-level, with the current fingerprint) for items that opt in via `acknowledgeable: true`. Local-state only — no mail, no external call — so the executor rails-guard is unaffected.

**Tech Stack:** Node.js ESM, `node --test` + `node:assert/strict`, `node:crypto` (sha1, node-side only). No new dependencies. Builds on Plans 1–5.

---

## Scope

**In this plan:** the fingerprint helper, the acknowledge store, `applyAcks`, scheduler integration (stamp fingerprints + load/apply acks), the `POST /items/:id/acknowledge` endpoint, the panel Acknowledge button (render + app.js + view-model passthrough), and opting `gateway`/`audit` items in via `acknowledgeable: true`. Daemon wiring + docs.

**Not in this plan:** the `exposed` job (next plan — it will set `acknowledgeable: true` the same way). No "snooze-until" or timed re-alert; acknowledge persists until the fingerprint changes.

## Prerequisites / starting state

Plans 1–5 merged. `daemon/store.js` exports `createStore(dataDir)` (corrupt-tolerant JSON via `atomicWrite`). `daemon/scheduler.js` `runTick(deps)` computes items via `runNormalizers`, stamps `lastChanged` per item, diffs, persists, emits. `daemon/api.js` `createApiServer({store, ctxFor, getLastTickAt, webDir})` serves REST/SSE + static. Panel: `daemon/web/{view-model,render,app}.js`; `renderItemCard` renders Open/Approve/dismiss from item/proposals; `toPanelView` attaches proposals and computes `needsYouCount` from `status==="at_risk"`. Canonical Item shape as before; `gateway`/`audit` items have `proposedActions: []`.

---

### Task 1: fingerprint + acknowledge store

**Files:**
- Create: `daemon/acknowledge.js`
- Create: `daemon/acknowledge.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/acknowledge.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/acknowledge.test.js`
Expected: FAIL — cannot find module `./acknowledge.js`.

- [ ] **Step 3: Implement `daemon/acknowledge.js`**

```js
/**
 * acknowledge.js — item-level acknowledge: a fingerprint of an item's salient
 * fields, a small persisted ack store, and a pure applyAcks that suppresses an
 * acknowledged item ONLY while its fingerprint still matches (re-alert on change).
 * Local-state only — no mail, no external calls.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./scripts-fs.js";

export function fingerprint(item) {
  const salient = JSON.stringify({ id: item.id, status: item.status, title: item.title, rootCause: item.group?.rootCause });
  return createHash("sha1").update(salient).digest("hex").slice(0, 16);
}

export function createAckStore(dataDir) {
  const path = join(dataDir, "acknowledged.json");
  const read = () => {
    if (!existsSync(path)) return {};
    try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return {}; }
  };
  return {
    getAcks: () => read(),
    recordAck: (itemId, fp, now) => {
      const acks = read();
      acks[itemId] = { fingerprint: fp, ackedAt: now };
      atomicWrite(path, JSON.stringify(acks, null, 2));
    },
    saveRaw: (raw) => writeFileSync(path, raw, "utf-8"),
  };
}

export function applyAcks(items, acks) {
  return items.map(item => {
    const ack = acks[item.id];
    if (ack && ack.fingerprint === item.fingerprint) {
      return { ...item, status: "ok", acknowledged: true };
    }
    return item;
  });
}
```

NOTE on the import: `atomicWrite` lives in `scripts/fs-utils.js`. From `daemon/acknowledge.js` the relative path is `../scripts/fs-utils.js`. Use that import instead of the placeholder above:

```js
import { atomicWrite } from "../scripts/fs-utils.js";
```

(Delete the `./scripts-fs.js` placeholder line; it exists only to make this note impossible to miss — the correct path is `../scripts/fs-utils.js`.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/acknowledge.test.js`
Expected: PASS (6 tests). If the `atomicWrite` import path is wrong the store tests fail loudly — fix the path to `../scripts/fs-utils.js`.

- [ ] **Step 5: Commit**

```bash
git add daemon/acknowledge.js daemon/acknowledge.test.js
git commit -m "feat(daemon): fingerprint + acknowledge store + applyAcks"
```

---

### Task 2: Scheduler — stamp fingerprints, load + apply acks

**Files:**
- Modify: `daemon/scheduler.js`
- Modify: `daemon/scheduler.test.js`

- [ ] **Step 1: Add the failing test** — append inside `describe("runTick", ...)` in `daemon/scheduler.test.js`:

```js
  it("stamps fingerprints and applies acks (acked item forced ok)", async () => {
    const dir = tmp();
    try {
      const d = deps(dir);
      await runTick(d);
      const model = d.store.getModel();
      const item = model.items.find(i => i.jobType === "owed_risk");
      assert.ok(item.fingerprint, "items get a fingerprint");

      // ack it, then re-tick with the ack store providing that ack
      const acks = { [item.id]: { fingerprint: item.fingerprint } };
      const d2 = deps(dir, { store: createStore(dir), getAcks: () => acks });
      await runTick(d2);
      const acked = d2.store.getModel().items.find(i => i.id === item.id);
      assert.equal(acked.status, "ok");
      assert.equal(acked.acknowledged, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
```

(The existing `deps()` helper must be extended to pass through an optional `getAcks`. In the helper, add `getAcks: over.getAcks || (() => ({}))` to the returned object — READ the helper and add this field alongside the others.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/scheduler.test.js`
Expected: FAIL — `items get a fingerprint` (no fingerprint stamped yet).

- [ ] **Step 3: Modify `daemon/scheduler.js`**

Add imports:

```js
import { fingerprint, applyAcks } from "./acknowledge.js";
```

In `runTick`, after `nextItems` is fully built and `lastChanged` stamped, and BEFORE the diff/persist, stamp fingerprints and apply acks. Find where `const nextModel = { generatedAt: clock.now, accounts: accountsState, items: nextItems };` is built and insert, just before it:

```js
  for (const item of nextItems) item.fingerprint = fingerprint(item);
  const acks = (deps.getAcks ? deps.getAcks() : {});
  nextItems = applyAcks(nextItems, acks);
```

(`nextItems` is declared with `let` already; if it is `const`, change it to `let`. `applyAcks` returns a new array. The `newAtRisk` computation should run AFTER applyAcks so an acked item doesn't count as newly at-risk — confirm `newAtRisk` is computed after this block; if it's earlier, move this block above it.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/scheduler.test.js`
Expected: PASS (existing tests + the new ack test). The diff-gated emit test must still pass — fingerprints are deterministic, so two identical ticks still produce identical models.

- [ ] **Step 5: Commit**

```bash
git add daemon/scheduler.js daemon/scheduler.test.js
git commit -m "feat(daemon): scheduler stamps fingerprints + applies acks"
```

---

### Task 3: API — `POST /items/:id/acknowledge`

**Files:**
- Modify: `daemon/api.js`
- Modify: `daemon/api.test.js`

- [ ] **Step 1: Add the failing test** — in `daemon/api.test.js`, extend the `before()` deps to include an in-memory ack store and add a test. In `createApiServer({...})` add `ackStore`:

```js
  const acks = {};
  const ackStore = { recordAck: (id, fp) => { acks[id] = { fingerprint: fp }; }, getAcks: () => acks };
  server = createApiServer({ store, ctxFor, getLastTickAt: () => "t", ackStore, clock: { now: () => "t" } });
```

Add the test:

```js
describe("POST /items/:id/acknowledge", () => {
  it("records an ack with the supplied fingerprint", async () => {
    const res = await fetch(`${base}/items/i1/acknowledge?fp=abc123`, { method: "POST" });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.itemId, "i1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/api.test.js`
Expected: FAIL — `/items/i1/acknowledge` 404s (no route + `ackStore` undefined).

- [ ] **Step 3: Modify `daemon/api.js`**

Add `ackStore` and `clock` to the deps destructure:

```js
  const { store, ctxFor, getLastTickAt, webDir = DEFAULT_WEB_DIR, ackStore, clock } = deps;
```

Add an acknowledge route in the request handler, before the static fallback (mirror the proposal route matching):

```js
    const ackMatch = path.match(/^\/items\/([^/]+)\/acknowledge$/);
    if (req.method === "POST" && ackMatch) {
      const id = decodeURIComponent(ackMatch[1]);
      const fp = url.searchParams.get("fp") || "";
      ackStore?.recordAck(id, fp, clock?.now ? clock.now() : new Date().toISOString());
      return send(res, 200, { ok: true, itemId: id });
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/api.test.js`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add daemon/api.js daemon/api.test.js
git commit -m "feat(daemon): POST /items/:id/acknowledge endpoint"
```

---

### Task 4: Panel — Acknowledge button (render + app.js + view-model)

**Files:**
- Modify: `daemon/web/render.js`
- Modify: `daemon/web/render.test.js`
- Modify: `daemon/web/app.js`

- [ ] **Step 1: Add the failing test** — in `daemon/web/render.test.js`, add inside `describe("renderItemCard", ...)`:

```js
  it("renders an Acknowledge button for acknowledgeable items carrying a fingerprint", () => {
    const ackable = { ...item, proposals: [], acknowledgeable: true, fingerprint: "fp1" };
    const html = renderItemCard(ackable);
    assert.match(html, /data-ack="brickell:owed_risk:card_4821"/);
    assert.match(html, /data-fp="fp1"/);
    assert.match(html, /Acknowledge/);
  });
  it("omits Acknowledge for non-acknowledgeable items", () => {
    assert.doesNotMatch(renderItemCard(item), /data-ack=/);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/web/render.test.js`
Expected: FAIL — no Acknowledge button.

- [ ] **Step 3: Modify `daemon/web/render.js`**

In `renderItemCard`, add an ack button when the item opts in, and include it in the actions. After the `routeBtn` line, add:

```js
  const ackBtn = (item.acknowledgeable && !item.acknowledged)
    ? `<button class="ack" data-ack="${esc(item.id)}" data-fp="${esc(item.fingerprint || "")}">Acknowledge</button>` : "";
```

Then add `${ackBtn}` to the actions div:

```js
    + `<div class="actions">${approveBtn}${routeBtn}${ackBtn}${dismissBtn}</div></div>`;
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/web/render.test.js`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Wire the click handler in `daemon/web/app.js`**

In the `appEl.addEventListener("click", ...)` handler, add a branch (READ app.js first to place it among the existing branches):

```js
  const ack = e.target.closest("[data-ack]");
  if (ack) return void post(`/items/${encodeURIComponent(ack.dataset.ack)}/acknowledge?fp=${encodeURIComponent(ack.dataset.fp || "")}`);
```

(`post()` already POSTs then reloads — reuse it.)

- [ ] **Step 6: Add a CSS rule** — append to `daemon/web/styles.css`:

```css
.ack { background:#23314a; color:#cdd9ea; }
```

- [ ] **Step 7: Run + commit**

Run: `node --test daemon/web/render.test.js` → PASS. Full daemon suite → green.

```bash
git add daemon/web/render.js daemon/web/render.test.js daemon/web/app.js daemon/web/styles.css
git commit -m "feat(daemon): panel Acknowledge button (item-level)"
```

---

### Task 5: Opt gateway + audit items into acknowledge

**Files:**
- Modify: `daemon/normalizers/gateway.js`
- Modify: `daemon/normalizers/gateway.test.js`
- Modify: `daemon/normalizers/audit.js`
- Modify: `daemon/normalizers/audit.test.js`

- [ ] **Step 1: Add failing assertions**

In `daemon/normalizers/gateway.test.js`, in the "marks a resolved ticket ok and an open ticket at_risk" test, add:

```js
    assert.equal(open.acknowledgeable, true);
```

In `daemon/normalizers/audit.test.js`, in the grouping test, add:

```js
    assert.equal(it0.acknowledgeable, true);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test daemon/normalizers/gateway.test.js daemon/normalizers/audit.test.js`
Expected: FAIL — `acknowledgeable` is undefined.

- [ ] **Step 3: Set the flag**

In `daemon/normalizers/gateway.js`, add `acknowledgeable: true,` to the item object (next to `proposedActions: []`).
In `daemon/normalizers/audit.js`, add `acknowledgeable: true,` to the item object (next to `proposedActions: []`).

- [ ] **Step 4: Run to verify they pass**

Run: `node --test daemon/normalizers/gateway.test.js daemon/normalizers/audit.test.js`
Expected: PASS. Full daemon suite → green.

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/gateway.js daemon/normalizers/gateway.test.js daemon/normalizers/audit.js daemon/normalizers/audit.test.js
git commit -m "feat(daemon): mark gateway + audit items acknowledgeable"
```

---

### Task 6: Daemon wiring + docs + verify

**Files:**
- Modify: `daemon/daemon.js`
- Modify: `daemon/README.md`

- [ ] **Step 1: Wire the ack store into the daemon**

In `daemon/daemon.js`:
(a) Import the store factory:

```js
import { createAckStore } from "./acknowledge.js";
```

(b) In `main()`, build it next to `const store = createStore(join(root, "data"));`:

```js
  const ackStore = createAckStore(join(root, "data"));
```

(c) Pass `getAcks` into the scheduler deps (the `deps` factory object) so the scheduler can apply acks:

```js
    getAcks: () => ackStore.getAcks(),
```

(d) Pass `ackStore` + a `clock` into `createApiServer`:

```js
  const server = createApiServer({ store, ctxFor, getLastTickAt: () => lastTickAt, ackStore, clock: { now: () => new Date().toISOString() } });
```

- [ ] **Step 2: Update `daemon/README.md`** — add a section after the Audit section:

```markdown
## Acknowledge

Findings/tickets (gateway, audit, and exposed) show an **Acknowledge** button. Acknowledging records
the item's fingerprint locally (`data/acknowledged.json`) and drops it from "needs you" — until the
finding materially changes (severity, status, title), at which point its fingerprint changes and it
re-alerts. Acknowledge is local state only: no mail, no external calls.
```

- [ ] **Step 3: Verify**

Run: `npm test` → all green.
Run: `node --check daemon/daemon.js && node --check daemon/acknowledge.js` → exit 0.
Run: `node daemon/daemon.js --once` → clean missing-config ENOENT (no SyntaxError/ReferenceError).

- [ ] **Step 4: Commit**

```bash
git add daemon/daemon.js daemon/README.md
git commit -m "feat(daemon): wire acknowledge store into daemon + docs"
```

---

## Self-Review (completed during authoring)

**Spec coverage (design §6):** fingerprint + re-alert-on-change → Task 1; scheduler applies acks → Task 2; acknowledge endpoint (local state only) → Task 3; panel Acknowledge button → Task 4; gateway/audit opt-in → Task 5; wiring/docs → Task 6. `exposed` opt-in deferred to its own plan (it sets the same `acknowledgeable: true`).

**Placeholder scan:** the one intentional `./scripts-fs.js` placeholder in Task 1 is immediately corrected to `../scripts/fs-utils.js` with a loud note; no other placeholders.

**Type consistency:** `fingerprint(item)` stamps `item.fingerprint`; `applyAcks(items, acks)` reads `item.fingerprint` vs `acks[id].fingerprint` and sets `status:"ok"`+`acknowledged:true`; the panel reads `item.acknowledgeable`/`item.fingerprint`/`item.acknowledged`; the endpoint records `(id, fp)`. `createAckStore(dataDir)→{getAcks,recordAck,saveRaw}` consumed by scheduler (`getAcks`) and api (`recordAck`). Acked items become `status:"ok"` so `needsYouCount` (counts `at_risk`) drops them — no view-model change needed.

**Rails:** acknowledge is local-state only; no executor added; `daemon/executors/rails-guard.test.js` unaffected. The endpoint touches only the ack JSON.

**Known follow-ups:** a panel filter to show acknowledged items in drill-in; pruning long-stale acks; per-job fingerprint field selection (current salient set — id/status/title/rootCause — is sufficient for v1).
```
