# Panel Undo (Dismiss / Acknowledge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a no-timer "Undo" snackbar after Dismiss and Acknowledge that reverses the action.

**Architecture:** A reverse proposal transition (`dismissed → pending`) and an ack-removal primitive back two new endpoints (`POST /proposals/:id/reopen`, `POST /items/:id/unacknowledge`). The panel holds one `ui.undo` slot, set on a successful dismiss/ack and cleared by any other action; `renderUndoBar` draws a bottom snackbar whose Undo button POSTs the reverse.

**Tech Stack:** Node ESM, `node:test`, vanilla browser JS/CSS.

**Spec:** `docs/superpowers/specs/2026-06-18-panel-undo-and-summary-detail-design.md` (Feature 1; this is Plan 1 of 2).

**Baseline:** full suite green (516/516). Run `npm test` from repo root. Keep green.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `daemon/proposals.js` | proposal state machine | add `dismissed → pending` (`reopen`) |
| `daemon/acknowledge.js` | ack store | add `removeAck(itemId)` |
| `daemon/api.js` | REST routes | add reopen + unacknowledge endpoints |
| `daemon/web/render.js` | pure HTML builders | add `renderUndoBar` |
| `daemon/web/app.js` | DOM glue | `ui.undo` slot + snackbar wiring |
| `daemon/web/styles.css` | styling | snackbar |
| `daemon/proposals.test.js`, `acknowledge.test.js`, `api.test.js`, `render.test.js`, `contract.test.js` | tests | extend |

---

## Task 1: Backend reversal primitives (`reopen` transition + `removeAck`)

**Files:**
- Modify: `daemon/proposals.js`, `daemon/acknowledge.js`
- Test: `daemon/proposals.test.js`, `daemon/acknowledge.test.js`

- [ ] **Step 1: Write the failing tests**

In `daemon/proposals.test.js`, inside the `describe("transition", ...)` block, add:

```js
  it("reopen turns a dismissed proposal back to pending", () => {
    assert.equal(transition({ state: "dismissed" }, "reopen").state, "pending");
  });
```

In `daemon/acknowledge.test.js`, inside the `describe("createAckStore", ...)` block, add:

```js
  it("removeAck deletes the key", () => {
    const dir = tmp();
    try {
      const s = createAckStore(dir);
      s.recordAck("i1", "fp1", "2026-06-17T00:00:00Z");
      s.removeAck("i1");
      assert.deepEqual(createAckStore(dir).getAcks(), {});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test daemon/proposals.test.js daemon/acknowledge.test.js`
Expected: FAIL — `transition(dismissed, "reopen")` throws "invalid transition"; `s.removeAck` is not a function.

- [ ] **Step 3: Add the `reopen` transition in `daemon/proposals.js`**

Replace the `TRANSITIONS` object (lines 7-11) with:

```js
const TRANSITIONS = {
  pending: { approve: "approved", dismiss: "dismissed", snooze: "snoozed" },
  approved: { executed: "executed", failed: "failed" },
  snoozed: { approve: "approved", dismiss: "dismissed" },
  dismissed: { reopen: "pending" },
};
```

- [ ] **Step 4: Add `removeAck` in `daemon/acknowledge.js`**

In `createAckStore`, add `removeAck` to the returned object (after `recordAck`, before `saveRaw`):

```js
    removeAck: (itemId) => {
      const acks = read();
      delete acks[itemId];
      atomicWrite(path, JSON.stringify(acks, null, 2));
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test daemon/proposals.test.js daemon/acknowledge.test.js`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add daemon/proposals.js daemon/acknowledge.js daemon/proposals.test.js daemon/acknowledge.test.js
git commit -m "feat(daemon): reopen transition + removeAck for undo"
```

---

## Task 2: API endpoints (`reopen` + `unacknowledge`)

**Files:**
- Modify: `daemon/api.js`
- Test: `daemon/api.test.js`

- [ ] **Step 1: Add failing endpoint tests**

In `daemon/api.test.js`:

(a) Hoist `acks` to module scope so tests can assert removal. Change line 9:

```js
let server, base, dir, store, acks;
```

(b) Add a third proposal and wire `removeAck` into the stub. Replace the `store.saveQueue({...})` block (lines 15-18) with:

```js
  store.saveQueue({ proposals: [
    { id: "p1", itemId: "i1", action: "route:billing_portal", params: {}, state: "pending" },
    { id: "p2", itemId: "i1", action: "draft_chase", params: {}, state: "pending" },
    { id: "p3", itemId: "i1", action: "draft_chase", params: {}, state: "pending" },
  ] });
```

Replace the ack-store stub (lines 21-22) with:

```js
  acks = {};
  const ackStore = { recordAck: (id, fp) => { acks[id] = { fingerprint: fp }; }, removeAck: (id) => { delete acks[id]; }, getAcks: () => acks };
```

Append two describe blocks at the end of the file:

```js
describe("POST /proposals/:id/reopen", () => {
  it("turns a dismissed proposal back to pending", async () => {
    await fetch(`${base}/proposals/p3/dismiss`, { method: "POST" });
    const body = await (await fetch(`${base}/proposals/p3/reopen`, { method: "POST" })).json();
    assert.equal(body.proposal.state, "pending");
    assert.equal(createStore(dir).getQueue().proposals.find(p => p.id === "p3").state, "pending");
  });
  it("404s reopening an unknown proposal", async () => {
    assert.equal((await fetch(`${base}/proposals/ghost/reopen`, { method: "POST" })).status, 404);
  });
});

describe("POST /items/:id/unacknowledge", () => {
  it("removes a recorded ack", async () => {
    await fetch(`${base}/items/i9/acknowledge?fp=z`, { method: "POST" });
    assert.ok(acks.i9);
    const body = await (await fetch(`${base}/items/i9/unacknowledge`, { method: "POST" })).json();
    assert.equal(body.ok, true);
    assert.ok(!acks.i9);
  });
});
```

- [ ] **Step 2: Run the api test to verify it fails**

Run: `node --test daemon/api.test.js`
Expected: FAIL — `/proposals/p3/reopen` and `/items/i9/unacknowledge` fall through (404 / not handled), so the reopen `state` assertion and the `acks.i9` removal assertion fail.

- [ ] **Step 3: Add the `reopen` handler + route in `daemon/api.js`**

Add a `reopen` function right after the `dismiss` function (after its closing brace, ~line 65):

```js
  function reopen(id, res) {
    const queue = store.getQueue();
    const proposal = queue.proposals.find(p => p.id === id);
    if (!proposal) return send(res, 404, { error: "proposal not found" });
    const updated = transition(proposal, "reopen");
    persist(queue, id, updated);
    return send(res, 200, { proposal: updated });
  }
```

Register the route next to the dismiss route. After the `dismissMatch` line (~line 107) add:

```js
    const reopenMatch = path.match(/^\/proposals\/([^/]+)\/reopen$/);
    if (req.method === "POST" && reopenMatch) return reopen(decodeURIComponent(reopenMatch[1]), res);
```

- [ ] **Step 4: Add the `unacknowledge` route in `daemon/api.js`**

Immediately after the existing `ackMatch` block (the `POST /items/:id/acknowledge` handler, ~line 115), add:

```js
    const unackMatch = path.match(/^\/items\/([^/]+)\/unacknowledge$/);
    if (req.method === "POST" && unackMatch) {
      const id = decodeURIComponent(unackMatch[1]);
      ackStore?.removeAck(id);
      return send(res, 200, { ok: true, itemId: id });
    }
```

- [ ] **Step 5: Run the api test to verify it passes**

Run: `node --test daemon/api.test.js`
Expected: PASS (all, including the two new blocks).

- [ ] **Step 6: Commit**

```bash
git add daemon/api.js daemon/api.test.js
git commit -m "feat(daemon): /proposals/:id/reopen + /items/:id/unacknowledge"
```

---

## Task 3: Snackbar UI (`renderUndoBar` + app wiring + styling)

**Files:**
- Modify: `daemon/web/render.js`, `daemon/web/app.js`, `daemon/web/styles.css`
- Test: `daemon/web/render.test.js`, `daemon/web/contract.test.js`

- [ ] **Step 1: Add failing tests**

In `daemon/web/render.test.js`, update the import line (line 3) to add `renderUndoBar`:

```js
import { renderHeader, renderItemCard, renderAccountSection, renderDetailPanel, renderUndoBar, relativeTime, safeUrl } from "./render.js";
```

Append a describe block at the end:

```js
describe("renderUndoBar", () => {
  it("renders the label and an Undo button when an undo is offered", () => {
    const html = renderUndoBar({ label: "Dismissed", undoUrl: "/proposals/p1/reopen" });
    assert.match(html, /Dismissed/);
    assert.match(html, /data-undo/);
  });
  it("renders nothing when there is no undo", () => {
    assert.equal(renderUndoBar(null), "");
  });
  it("escapes the label", () => {
    assert.match(renderUndoBar({ label: "<img src=x>", undoUrl: "/x" }), /&lt;img/);
  });
});
```

In `daemon/web/contract.test.js`, add a new test inside the top-level describe:

```js
  it("app handles the undo action the snackbar emits", () => {
    assert.match(render, /data-undo/, "render must emit the undo button");
    assert.match(app, /\[data-undo\]/, "app must select [data-undo]");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test daemon/web/render.test.js daemon/web/contract.test.js`
Expected: FAIL — `renderUndoBar` is not exported; `app.js` has no `[data-undo]`.

- [ ] **Step 3: Add `renderUndoBar` in `daemon/web/render.js`**

Add at the end of the file (after `renderSelectControls`):

```js
export function renderUndoBar(undo) {
  if (!undo) return "";
  return `<div class="snackbar"><span class="snacklabel">${esc(undo.label)}</span>`
    + `<button class="undo" data-undo>Undo</button></div>`;
}
```

- [ ] **Step 4: Wire the snackbar in `daemon/web/app.js`**

(a) Update the import (line 7) to include `renderUndoBar`:

```js
import { renderHeader, renderAccountSection, renderDetailPanel, renderSelectControls, renderUndoBar, esc } from "./render.js";
```

(b) Add `undo: null` to the `ui` object (line 12):

```js
const ui = { account: "", query: "", collapsed: new Set(), detailItemId: null, undo: null };
```

(c) Render the bar — in `draw()`, change the `appEl.innerHTML = ...` assignment to append the undo bar:

```js
  appEl.innerHTML =
    renderHeader(view)
    + `<div class="filters"><input id="q" placeholder="filter…" value="${esc(ui.query)}"></div>`
    + renderSelectControls(selected.size)
    + (sections || '<div class="empty">All clear.</div>')
    + detail
    + renderUndoBar(ui.undo);
```

(d) Add an action-then-offer-undo helper after `post()` (after line 51):

```js
function actThenOfferUndo(actionUrl, undo) {
  ui.undo = null;
  fetch(actionUrl, { method: "POST" })
    .then(() => load())
    .then(() => { ui.undo = undo; draw(); });
}
```

(e) Replace the entire click handler (lines 72-94) with this version (undo button first; each non-undo action clears the slot; dismiss/ack offer undo):

```js
appEl.addEventListener("click", (e) => {
  const u = e.target.closest("[data-undo]");
  if (u) { if (ui.undo) { const url = ui.undo.undoUrl; ui.undo = null; post(url); } return; }
  const a = e.target.closest("[data-approve]");
  if (a) { ui.undo = null; return void post(`/proposals/${encodeURIComponent(a.dataset.approve)}/approve`); }
  const d = e.target.closest("[data-dismiss]");
  if (d) { const id = d.dataset.dismiss; return void actThenOfferUndo(`/proposals/${encodeURIComponent(id)}/dismiss`, { label: "Dismissed", undoUrl: `/proposals/${encodeURIComponent(id)}/reopen` }); }
  const ack = e.target.closest("[data-ack]");
  if (ack) { const id = ack.dataset.ack; return void actThenOfferUndo(`/items/${encodeURIComponent(id)}/acknowledge?fp=${encodeURIComponent(ack.dataset.fp || "")}`, { label: "Acknowledged", undoUrl: `/items/${encodeURIComponent(id)}/unacknowledge` }); }
  const close = e.target.closest("[data-detail-close]");
  if (close) { ui.undo = null; ui.detailItemId = null; draw(); return; }
  const det = e.target.closest("[data-detail]");
  if (det) { ui.undo = null; ui.detailItemId = det.dataset.detail; draw(); return; }
  const col = e.target.closest("[data-collapse]");
  if (col) { ui.undo = null; ui.collapsed = toggle(ui.collapsed, col.dataset.collapse); draw(); return; }
  const s = e.target.closest("[data-select]");
  if (s) { ui.undo = null; selected = toggle(selected, s.dataset.select); draw(); return; }
  const bulk = e.target.closest("[data-bulk-approve]");
  if (bulk) {
    ui.undo = null;
    const view = toPanelView(lastModel);
    const ids = pendingApprovalsFor(filterItems(view, ui), selected);
    selected = new Set();
    return void (async () => { for (const id of ids) await fetch(`/proposals/${encodeURIComponent(id)}/approve`, { method: "POST" }); await load(); })();
  }
});
```

- [ ] **Step 5: Style the snackbar in `daemon/web/styles.css`**

Append:

```css
.snackbar { position:fixed; left:16px; bottom:16px; display:flex; align-items:center; gap:14px; background:#1b2740; border:1px solid var(--line); border-radius:8px; padding:8px 14px; box-shadow:0 4px 16px rgba(0,0,0,.4); z-index:20; }
.snackbar .snacklabel { color:var(--txt); font-size:13px; }
.snackbar .undo { background:transparent; color:var(--accent); border:none; font-weight:600; cursor:pointer; padding:2px 6px; }
```

- [ ] **Step 6: Run the web suite to verify pass**

Run: `node --test daemon/web/render.test.js daemon/web/contract.test.js`
Expected: PASS. Then `node --test daemon/web` — all green.

- [ ] **Step 7: Commit**

```bash
git add daemon/web/render.js daemon/web/app.js daemon/web/styles.css daemon/web/render.test.js daemon/web/contract.test.js
git commit -m "feat(panel): no-timer Undo snackbar for dismiss/acknowledge"
```

---

## Task 4: Full suite + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS — all green, total above the 516 baseline (this plan adds tests).

- [ ] **Step 2: Manual smoke (operator)**

Restart the daemon from the main checkout (`node daemon/daemon.js --port 8138`) and open `http://localhost:8138/`. Confirm:
- Clicking **dismiss** on a proposal shows a bottom-left "Dismissed · Undo" bar; clicking **Undo** brings the Approve/dismiss buttons back immediately.
- Clicking **Acknowledge** shows "Acknowledged · Undo"; clicking **Undo** removes the ack (the item returns to at-risk on the next tick).
- Taking any other action (approve, select, open Details, collapse) clears the bar.
- The bar has no countdown — it persists until Undo or another action.

No commit unless the smoke surfaces a fix.

---

## Self-Review

**Spec coverage (Feature 1):**
- `dismissed → pending` transition → Task 1. ✓
- `removeAck` → Task 1. ✓
- `POST /proposals/:id/reopen`, `POST /items/:id/unacknowledge` → Task 2. ✓
- Snackbar, no timer, one slot, cleared by any other action → Task 3 (click handler clears `ui.undo` in every non-undo branch; SSE `load()` never touches `ui.undo`, so it persists across ticks until an action). ✓
- Dismiss-undo instant; ack-undo reverses persisted state (tile on next tick) → Task 2 endpoints + Task 3 wiring. ✓
- Rails: only local proposal/ack state changes; no send/delete. ✓

**Placeholder scan:** none — every step has complete code.

**Type/name consistency:** `transition(..., "reopen")`, `removeAck(itemId)`, routes `/proposals/:id/reopen` + `/items/:id/unacknowledge`, `renderUndoBar(undo)` with `{ label, undoUrl }`, `ui.undo`, `actThenOfferUndo(actionUrl, undo)`, and `data-undo` are used identically across Tasks 1–3. The app builds `undoUrl` as `/proposals/<id>/reopen` and `/items/<id>/unacknowledge`, matching the Task 2 routes. ✓
