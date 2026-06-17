# Ambient Proposal Panel — Visible Surface (panel + workbench + toasts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the headless daemon a glanceable consuming surface — a pinned `localhost` panel that shows "what needs you" as approvable proposals with a drill-in workbench, plus daemon-fired Windows toasts when something crosses a threshold — all live over the existing REST + SSE API.

**Architecture:** Zero-build, zero-dependency. The daemon's existing `node:http` server (Plan 1) gains static-file serving for a `daemon/web/` folder (vanilla HTML/CSS/ES-module JS — no framework, no bundler). A pure `daemon/web/view-model.js` (importable by both Node tests and the browser) turns `/model` JSON into a render-ready view; `daemon/web/app.js` is thin DOM glue that fetches `/model`, live-reloads on SSE `/events`, and acts via the Plan-1 `POST /proposals/:id/approve|dismiss`. Ambience comes from `daemon/notifier.js`, which the scheduler invokes on threshold-crossing diffs to fire a native Windows toast via PowerShell (`Windows.UI.Notifications`, no module install). Pure decision/command-building logic is unit-tested; DOM and shell glue are thin and verified by a real run + screenshot.

**Tech Stack:** Node.js ESM, `node --test` + `node:assert/strict`, `node:http` (extended), browser ES modules (`<script type="module">`), PowerShell toast (Windows 11). No new npm dependencies. Builds directly on Plan 1 (`daemon/store.js`, `daemon/api.js`, `daemon/scheduler.js`, `daemon/daemon.js`, the canonical Item/Proposal shapes).

---

## Scope

**In this plan:** static serving in the API; the pure panel view-model; the panel UI (grouped "needs you" list + per-proposal approve/dismiss, live via SSE); the drill-in workbench (filter + multi-select + bulk approve); the Windows toast notifier; scheduler enrichment so a tick reports *what* changed for notification (new at-risk items + account status flips); daemon wiring to serve the panel and fire toasts; a manual run+screenshot verification.

**Not in this plan (Plan 3):** the `handled` / `audit` / `exposed` job-types and the reasoner-assisted grouping fallback. Native tray packaging stays deferred (the spec's resolved v1 packaging is pinned-window + daemon toasts). Mobile (Direction D) remains out of scope.

## Prerequisites / starting state

Plan 1 is merged. `daemon/api.js` exports `createApiServer({ store, ctxFor, getLastTickAt })` returning an `http.Server` with `GET /health`, `GET /model`, `GET /events` (SSE), `POST /proposals/:id/approve`, `POST /proposals/:id/dismiss`, and a `server.broadcastUpdate(event)` method. `daemon/scheduler.js` exports `runTick(deps)` returning `{changed, warnings, itemCount}` and calls `emit({type:"update", at})` only when the item set changed. The canonical Item shape: `{id, jobType, account, title, status:"at_risk"|"ok", group:{rootCause, members:[{vendor,from,subject,emailId}]}, source:[...], proposedActions:[...], lastChanged}`. Proposal: `{id, itemId, action, params, preview, state}`.

## Conventions

- Source under `daemon/`; browser assets under `daemon/web/`. Tests co-located as `daemon/**/*.test.js` (already in the `npm test` glob).
- Pure logic is unit-tested; DOM/shell glue is thin and verified by a run step.
- `view-model.js` must import NOTHING from `node:*` so it loads unchanged in the browser.

---

### Task 1: Static file serving in the API

**Files:**
- Modify: `daemon/api.js`
- Create: `daemon/web/index.html` (minimal placeholder; fleshed out in Task 3)
- Create: `daemon/web-serving.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/web-serving.test.js`:

```js
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { createApiServer } from "./api.js";

let server, base, dir, webDir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "officeos-web-"));
  webDir = join(dir, "web");
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Panel</title><div id=app></div>");
  writeFileSync(join(webDir, "app.js"), "export const x = 1;");
  const store = createStore(dir);
  store.saveModel({ generatedAt: "t", accounts: {}, items: [] });
  store.saveQueue({ proposals: [] });
  server = createApiServer({ store, ctxFor: () => ({}), getLastTickAt: () => "t", webDir });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

describe("static serving", () => {
  it("serves index.html at /", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(await res.text(), /id=app/);
  });
  it("serves a js asset with the right content-type", async () => {
    const res = await fetch(`${base}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /javascript/);
  });
  it("does not serve the /model API as a static file (API still wins)", async () => {
    const res = await fetch(`${base}/model`);
    assert.match(res.headers.get("content-type"), /application\/json/);
  });
  it("blocks path traversal", async () => {
    const res = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.equal(res.status, 404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/web-serving.test.js`
Expected: FAIL — `/` returns 404 (no static handler yet).

- [ ] **Step 3: Implement static serving in `daemon/api.js`**

At the top of `daemon/api.js`, extend the imports (currently lines 16-18):

```js
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutor } from "./executors/index.js";
import { transition } from "./proposals.js";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
const DEFAULT_WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");
```

In `createApiServer`, change the deps destructure (currently line 26) to include `webDir`:

```js
  const { store, ctxFor, getLastTickAt, webDir = DEFAULT_WEB_DIR } = deps;
```

Add this helper inside `createApiServer` (next to `broadcast`, before the `createServer` call):

```js
  function serveStatic(pathname, res) {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const full = normalize(join(webDir, rel));
    if (!full.startsWith(normalize(webDir))) return send(res, 404, { error: "not found" });
    if (!existsSync(full) || !statSync(full).isFile()) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[extname(full).toLowerCase()] || "application/octet-stream" });
    res.end(readFileSync(full));
  }
```

Replace the final fallback line (currently line 89, `return send(res, 404, { error: "not found" });`) with a static attempt for GETs:

```js
    if (req.method === "GET") return serveStatic(path, res);
    return send(res, 404, { error: "not found" });
```

Because the specific API route checks (`/health`, `/model`, `/events`, the proposal POSTs) run first and `return`, static serving only handles GETs that didn't match an API route — so `/model` still returns JSON.

- [ ] **Step 4: Create the placeholder `daemon/web/index.html`**

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>OfficeOS Panel</title></head>
<body><div id="app">Loading…</div><script type="module" src="/app.js"></script></body>
</html>
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test daemon/web-serving.test.js`
Expected: PASS (4 tests).
Run: `node --test daemon/api.test.js`
Expected: PASS (5 tests — the existing API behavior is unchanged because `webDir` defaults and the API routes still match first).

- [ ] **Step 6: Commit**

```bash
git add daemon/api.js daemon/web/index.html daemon/web-serving.test.js
git commit -m "feat(daemon): serve the web panel as static files"
```

---

### Task 2: Panel view-model (pure)

**Files:**
- Create: `daemon/web/view-model.js`
- Create: `daemon/web/view-model.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/web/view-model.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPanelView, filterItems } from "./view-model.js";

const model = {
  generatedAt: "2026-06-17T12:00:00Z",
  accounts: { brickell: { status: "ok", lastTickAt: "t" }, summit: { status: "stale", lastTickAt: "t" } },
  items: [
    { id: "brickell:owed_risk:card_4821", jobType: "owed_risk", account: "brickell", title: "2 failed payments — one root cause", status: "at_risk", group: { rootCause: "card_4821", members: [{}, {}] }, source: [], proposedActions: ["draft_chase", "route:billing_portal"], lastChanged: "t" },
    { id: "brickell:owed_risk:vendor:initech.com", jobType: "owed_risk", account: "brickell", title: "1 failed payment", status: "at_risk", group: { rootCause: "vendor:initech.com", members: [{}] }, source: [], proposedActions: ["draft_chase"], lastChanged: "t" },
  ],
  proposals: [
    { id: "brickell:owed_risk:card_4821::draft_chase", itemId: "brickell:owed_risk:card_4821", action: "draft_chase", state: "pending", preview: { summary: "2 failed payments — one root cause", drafts: [{}, {}] } },
    { id: "brickell:owed_risk:vendor:initech.com::draft_chase", itemId: "brickell:owed_risk:vendor:initech.com", action: "draft_chase", state: "executed", preview: { summary: "1 failed payment", drafts: [{}] } },
  ],
};

describe("toPanelView", () => {
  it("counts items needing attention and pending proposals", () => {
    const v = toPanelView(model);
    assert.equal(v.needsYouCount, 2);   // both items are at_risk
    assert.equal(v.pendingCount, 1);    // one pending proposal
  });
  it("attaches each item's proposals by itemId", () => {
    const v = toPanelView(model);
    const item = v.groups.flatMap(g => g.items).find(i => i.id === "brickell:owed_risk:card_4821");
    assert.equal(item.proposals.length, 1);
    assert.equal(item.proposals[0].state, "pending");
  });
  it("groups items by account and surfaces stale accounts", () => {
    const v = toPanelView(model);
    const brickell = v.groups.find(g => g.account === "brickell");
    assert.equal(brickell.items.length, 2);
    assert.deepEqual(v.staleAccounts, ["summit"]);
  });
  it("tolerates an empty model", () => {
    const v = toPanelView({ generatedAt: null, accounts: {}, items: [], proposals: [] });
    assert.equal(v.needsYouCount, 0);
    assert.deepEqual(v.groups, []);
  });
});

describe("filterItems", () => {
  it("filters by account and by free-text query against title/rootCause", () => {
    const v = toPanelView(model);
    assert.equal(filterItems(v, { account: "brickell" }).length, 2);
    assert.equal(filterItems(v, { query: "initech" }).length, 1);
    assert.equal(filterItems(v, { query: "nope" }).length, 0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/web/view-model.test.js`
Expected: FAIL — cannot find module `./view-model.js`.

- [ ] **Step 3: Implement `daemon/web/view-model.js`** (NO `node:*` imports — must run in the browser):

```js
/**
 * view-model.js — pure transforms from /model JSON into a render-ready view.
 * Imported by both the Node tests and the browser panel, so it must not use
 * any node: APIs.
 */
export function toPanelView(model) {
  const proposalsByItem = new Map();
  for (const p of model.proposals || []) {
    if (!proposalsByItem.has(p.itemId)) proposalsByItem.set(p.itemId, []);
    proposalsByItem.get(p.itemId).push(p);
  }
  const items = (model.items || []).map(i => ({ ...i, proposals: proposalsByItem.get(i.id) || [] }));

  const byAccount = new Map();
  for (const it of items) {
    if (!byAccount.has(it.account)) byAccount.set(it.account, []);
    byAccount.get(it.account).push(it);
  }
  const groups = [...byAccount.entries()].map(([account, accountItems]) => ({
    account,
    status: model.accounts?.[account]?.status || "ok",
    items: accountItems,
  }));

  const staleAccounts = Object.entries(model.accounts || {})
    .filter(([, s]) => s.status === "stale").map(([id]) => id);

  return {
    generatedAt: model.generatedAt || null,
    needsYouCount: items.filter(i => i.status === "at_risk").length,
    pendingCount: (model.proposals || []).filter(p => p.state === "pending").length,
    groups,
    staleAccounts,
  };
}

/**
 * Flatten + filter the view's items for the workbench.
 * @param {object} view  output of toPanelView
 * @param {object} opts  { account?, jobType?, query? }
 */
export function filterItems(view, opts = {}) {
  const all = view.groups.flatMap(g => g.items);
  const q = (opts.query || "").toLowerCase();
  return all.filter(i =>
    (!opts.account || i.account === opts.account) &&
    (!opts.jobType || i.jobType === opts.jobType) &&
    (!q || `${i.title} ${i.group?.rootCause || ""}`.toLowerCase().includes(q))
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/web/view-model.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/web/view-model.js daemon/web/view-model.test.js
git commit -m "feat(daemon): pure panel view-model"
```

---

### Task 3: The panel UI (grouped list + live SSE + approve/dismiss)

**Files:**
- Modify: `daemon/web/index.html`
- Create: `daemon/web/styles.css`
- Create: `daemon/web/app.js`
- Create: `daemon/web/render.js`
- Create: `daemon/web/render.test.js`

DOM glue can't be unit-tested without a dependency, so the *string-building* part of rendering lives in a pure `render.js` (tested), and `app.js` is the thin DOM/fetch/SSE wiring (verified by the run in Task 6/8).

- [ ] **Step 1: Write the failing test**

Create `daemon/web/render.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderHeader, renderItemCard } from "./render.js";

const item = {
  id: "brickell:owed_risk:card_4821", account: "brickell",
  title: "2 failed payments — one root cause", status: "at_risk",
  group: { rootCause: "card_4821", members: [{ vendor: "Acme" }, { vendor: "Globex" }] },
  source: [{ kind: "url", url: "https://pay.example/portal" }],
  proposals: [{ id: "brickell:owed_risk:card_4821::draft_chase", action: "draft_chase", state: "pending", preview: { drafts: [{}, {}] } }],
};

describe("renderHeader", () => {
  it("shows the needs-you count and a stale warning when present", () => {
    assert.match(renderHeader({ needsYouCount: 3, pendingCount: 2, staleAccounts: [] }), /3/);
    assert.match(renderHeader({ needsYouCount: 0, pendingCount: 0, staleAccounts: ["summit"] }), /summit/i);
  });
});

describe("renderItemCard", () => {
  it("renders the title, root cause, and an approve button wired to the pending proposal id", () => {
    const html = renderItemCard(item);
    assert.match(html, /one root cause/);
    assert.match(html, /card_4821/);
    assert.match(html, /data-approve="brickell:owed_risk:card_4821::draft_chase"/);
    assert.match(html, /data-route="https:\/\/pay\.example\/portal"/);
  });
  it("escapes HTML in titles to prevent injection", () => {
    const evil = { ...item, title: "<img src=x onerror=alert(1)>", proposals: [], source: [] };
    const html = renderItemCard(evil);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img/);
  });
};
```

NOTE: fix the stray `};` — the second `describe` must close with `});`. Use:

```js
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/web/render.test.js`
Expected: FAIL — cannot find module `./render.js`.

- [ ] **Step 3: Implement `daemon/web/render.js`** (pure, browser-safe, no node imports):

```js
/**
 * render.js — pure HTML-string builders for the panel. No DOM, no node APIs.
 * app.js injects these strings and wires events via data- attributes.
 */
export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderHeader(view) {
  const stale = view.staleAccounts?.length
    ? `<div class="stale">⚠ couldn't refresh: ${view.staleAccounts.map(esc).join(", ")}</div>`
    : "";
  return `<div class="hdr"><span class="count">${view.needsYouCount}</span> need you`
    + ` <span class="sub">· ${view.pendingCount} pending</span>${stale}</div>`;
}

export function renderItemCard(item) {
  const pending = (item.proposals || []).find(p => p.state === "pending");
  const routeUrl = (item.source || []).find(s => s.kind === "url")?.url;
  const approveBtn = pending
    ? `<button class="approve" data-approve="${esc(pending.id)}">✓ Approve ${esc(pending.action)}</button>`
    : "";
  const dismissBtn = pending
    ? `<button class="dismiss" data-dismiss="${esc(pending.id)}">dismiss</button>` : "";
  const routeBtn = routeUrl
    ? `<a class="route" target="_blank" rel="noopener" href="${esc(routeUrl)}" data-route="${esc(routeUrl)}">↗ Open</a>` : "";
  const members = (item.group?.members || []).map(m => esc(m.vendor)).join(", ");
  return `<div class="card ${esc(item.status)}" data-item="${esc(item.id)}">`
    + `<div class="title">${esc(item.title)}</div>`
    + `<div class="meta">${esc(item.group?.rootCause || "")} · ${members}</div>`
    + `<div class="actions">${approveBtn}${routeBtn}${dismissBtn}</div></div>`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/web/render.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the DOM glue `daemon/web/app.js`** (verified by the Task 8 run, not unit-tested):

```js
/**
 * app.js — thin DOM glue. Fetches /model, renders via render.js, live-reloads
 * on SSE /events, and posts approve/dismiss. No business logic lives here.
 */
import { toPanelView, filterItems } from "./view-model.js";
import { renderHeader, renderItemCard } from "./render.js";

const appEl = document.getElementById("app");
let lastModel = null;
const ui = { account: "", query: "" };

async function load() {
  const model = await (await fetch("/model")).json();
  lastModel = model;
  draw();
}

function draw() {
  if (!lastModel) return;
  const view = toPanelView(lastModel);
  const items = filterItems(view, ui);
  appEl.innerHTML =
    renderHeader(view)
    + `<div class="filters">
         <input id="q" placeholder="filter…" value="${ui.query.replace(/"/g, "&quot;")}">
       </div>`
    + `<div class="list">${items.map(renderItemCard).join("") || '<div class="empty">All clear.</div>'}</div>`;
}

async function post(url) {
  await fetch(url, { method: "POST" });
  await load(); // refresh after an action
}

appEl.addEventListener("click", (e) => {
  const a = e.target.closest("[data-approve]");
  if (a) return void post(`/proposals/${encodeURIComponent(a.dataset.approve)}/approve`);
  const d = e.target.closest("[data-dismiss]");
  if (d) return void post(`/proposals/${encodeURIComponent(d.dataset.dismiss)}/dismiss`);
});

appEl.addEventListener("input", (e) => {
  if (e.target.id === "q") { ui.query = e.target.value; draw(); }
});

// Live updates: re-pull the model whenever the daemon signals a change.
const es = new EventSource("/events");
es.onmessage = () => load();
es.onerror = () => {/* browser auto-reconnects */};

load();
```

- [ ] **Step 6: Flesh out `daemon/web/index.html`** (replace the Task 1 placeholder):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OfficeOS Panel</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="app">Loading…</div>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 7: Create `daemon/web/styles.css`** (minimal, glanceable; dark, readable):

```css
:root { color-scheme: dark; --bg:#0f1420; --card:#16203a; --line:#2a3346; --txt:#cdd9ea; --risk:#e5707a; --ok:#7fd1a0; --accent:#7fb3ff; }
* { box-sizing: border-box; }
body { margin:0; font-family: system-ui, sans-serif; background:var(--bg); color:var(--txt); padding:16px; }
.hdr { font-size:18px; margin-bottom:12px; }
.hdr .count { font-size:28px; font-weight:700; color:var(--risk); }
.hdr .sub { color:#8a94a6; font-size:14px; }
.stale { color:#c9a227; font-size:13px; margin-top:4px; }
.filters { margin:8px 0; }
.filters input { width:100%; padding:8px; border-radius:8px; border:1px solid var(--line); background:#0c111b; color:var(--txt); }
.list { display:flex; flex-direction:column; gap:10px; }
.card { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--line); border-radius:10px; padding:12px; }
.card.at_risk { border-left-color:var(--risk); }
.card .title { font-weight:600; }
.card .meta { color:#8a94a6; font-size:12px; margin:4px 0 8px; }
.actions { display:flex; gap:8px; align-items:center; }
button, .route { font:inherit; border-radius:8px; padding:6px 12px; border:1px solid var(--line); cursor:pointer; text-decoration:none; }
.approve { background:#1f3a2a; color:var(--ok); }
.route { background:#23314a; color:var(--accent); }
.dismiss { background:transparent; color:#8a94a6; }
.empty { color:#8a94a6; padding:24px; text-align:center; }
```

- [ ] **Step 8: Commit**

```bash
git add daemon/web/index.html daemon/web/styles.css daemon/web/app.js daemon/web/render.js daemon/web/render.test.js
git commit -m "feat(daemon): live panel UI (grouped list, approve/dismiss, SSE)"
```

---

### Task 4: Drill-in workbench — multi-select + bulk approve

**Files:**
- Modify: `daemon/web/render.js` (add `renderSelectControls`)
- Modify: `daemon/web/app.js` (selection state + bulk approve)
- Create: `daemon/web/selection.js`
- Create: `daemon/web/selection.test.js`

- [ ] **Step 1: Write the failing test**

Create `daemon/web/selection.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toggle, pendingApprovalsFor } from "./selection.js";

describe("toggle", () => {
  it("adds and removes ids from a selection set immutably", () => {
    const a = toggle(new Set(), "x");
    assert.ok(a.has("x"));
    const b = toggle(a, "x");
    assert.ok(!b.has("x"));
    assert.ok(a.has("x")); // original unchanged
  });
});

describe("pendingApprovalsFor", () => {
  it("returns pending proposal ids for the selected items only", () => {
    const items = [
      { id: "i1", proposals: [{ id: "i1::draft_chase", state: "pending" }] },
      { id: "i2", proposals: [{ id: "i2::draft_chase", state: "executed" }] },
      { id: "i3", proposals: [{ id: "i3::draft_chase", state: "pending" }] },
    ];
    const sel = new Set(["i1", "i2"]);
    assert.deepEqual(pendingApprovalsFor(items, sel), ["i1::draft_chase"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/web/selection.test.js`
Expected: FAIL — cannot find module `./selection.js`.

- [ ] **Step 3: Implement `daemon/web/selection.js`** (pure, browser-safe):

```js
/**
 * selection.js — pure helpers for the workbench's multi-select + bulk action.
 */
export function toggle(set, id) {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** Pending proposal ids belonging to the selected items. */
export function pendingApprovalsFor(items, selectedIds) {
  return items
    .filter(i => selectedIds.has(i.id))
    .flatMap(i => (i.proposals || []).filter(p => p.state === "pending").map(p => p.id));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/web/selection.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Add `renderSelectControls` to `daemon/web/render.js`** (append; pure):

```js
export function renderSelectControls(selectedCount) {
  return `<div class="bulk">
    <span>${selectedCount} selected</span>
    <button class="bulk-approve" data-bulk-approve ${selectedCount ? "" : "disabled"}>✓ Approve selected</button>
  </div>`;
}
```

Also modify `renderItemCard` so each card includes a selection checkbox. Change the opening `<div class="card ...">` line to insert a checkbox at the start of the card body:

```js
  return `<div class="card ${esc(item.status)}" data-item="${esc(item.id)}">`
    + `<label class="sel"><input type="checkbox" data-select="${esc(item.id)}"> select</label>`
    + `<div class="title">${esc(item.title)}</div>`
```

(keep the remaining lines of `renderItemCard` unchanged).

- [ ] **Step 6: Wire selection + bulk approve into `daemon/web/app.js`**

Add the import at the top:

```js
import { toggle, pendingApprovalsFor } from "./selection.js";
import { renderHeader, renderItemCard, renderSelectControls } from "./render.js";
```

Add selection state near the other state:

```js
let selected = new Set();
```

In `draw()`, insert the bulk controls above the list — change the `.list` line so the rendered output is:

```js
  appEl.innerHTML =
    renderHeader(view)
    + `<div class="filters"><input id="q" placeholder="filter…" value="${ui.query.replace(/"/g, "&quot;")}"></div>`
    + renderSelectControls(selected.size)
    + `<div class="list">${items.map(renderItemCard).join("") || '<div class="empty">All clear.</div>'}</div>`;
  // restore checkbox visual state after re-render
  for (const id of selected) {
    const cb = appEl.querySelector(`[data-select="${CSS.escape(id)}"]`);
    if (cb) cb.checked = true;
  }
```

Extend the click handler to handle selection toggles and bulk approve (add inside the existing `appEl.addEventListener("click", ...)` before its end):

```js
  const s = e.target.closest("[data-select]");
  if (s) { selected = toggle(selected, s.dataset.select); return; }
  const bulk = e.target.closest("[data-bulk-approve]");
  if (bulk) {
    const view = toPanelView(lastModel);
    const ids = pendingApprovalsFor(filterItems(view, ui), selected);
    selected = new Set();
    return void (async () => { for (const id of ids) await fetch(`/proposals/${encodeURIComponent(id)}/approve`, { method: "POST" }); await load(); })();
  }
```

- [ ] **Step 7: Add minimal CSS for the new controls** — append to `daemon/web/styles.css`:

```css
.bulk { display:flex; gap:10px; align-items:center; margin:8px 0; color:#8a94a6; font-size:13px; }
.bulk-approve { background:#1f3a2a; color:var(--ok); }
.bulk-approve[disabled] { opacity:.4; cursor:default; }
.sel { float:right; color:#8a94a6; font-size:12px; }
```

- [ ] **Step 8: Run the pure tests + commit**

Run: `node --test daemon/web/selection.test.js daemon/web/render.test.js`
Expected: PASS (selection 2 + render 3 = 5).

```bash
git add daemon/web/selection.js daemon/web/selection.test.js daemon/web/render.js daemon/web/app.js daemon/web/styles.css
git commit -m "feat(daemon): workbench multi-select + bulk approve"
```

---

### Task 5: Windows toast notifier

**Files:**
- Create: `daemon/notifier.js`
- Create: `daemon/notifier.test.js`

The pure parts — deciding whether a diff is toast-worthy, and building the PowerShell command — are tested. The actual `spawnSync` is thin glue verified in Task 8.

- [ ] **Step 1: Write the failing test**

Create `daemon/notifier.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideNotification, buildToastPowerShell } from "./notifier.js";

describe("decideNotification", () => {
  it("notifies about newly at-risk items", () => {
    const note = decideNotification({ newAtRisk: [{ title: "2 failed payments — one root cause" }], staleFlips: [] });
    assert.ok(note);
    assert.match(note.title, /need you|OfficeOS/i);
    assert.match(note.body, /2 failed payments/);
  });
  it("notifies when an account goes stale", () => {
    const note = decideNotification({ newAtRisk: [], staleFlips: ["summit"] });
    assert.ok(note);
    assert.match(note.body, /summit/i);
  });
  it("returns null when nothing is toast-worthy", () => {
    assert.equal(decideNotification({ newAtRisk: [], staleFlips: [] }), null);
  });
});

describe("buildToastPowerShell", () => {
  it("produces a script embedding the (escaped) title and body, no send/delete tokens", () => {
    const ps = buildToastPowerShell("OfficeOS — 2 need you", 'card "4821" <x>');
    assert.match(ps, /ToastNotificationManager/);
    assert.match(ps, /OfficeOS/);
    // single quotes in the PS string literal must be doubled to stay safe
    assert.doesNotMatch(ps, /sendMail|messages\.send|messages\.delete/i);
  });
  it("escapes single quotes to prevent script breakout", () => {
    const ps = buildToastPowerShell("it's fine", "a'b");
    assert.match(ps, /it''s fine/);
    assert.match(ps, /a''b/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test daemon/notifier.test.js`
Expected: FAIL — cannot find module `./notifier.js`.

- [ ] **Step 3: Implement `daemon/notifier.js`**:

```js
/**
 * notifier.js — daemon ambience. Decides whether a tick's diff is worth a
 * toast, and fires a native Windows toast via PowerShell (no module install).
 *
 * RAILS: this module shows notifications only. It never sends or deletes mail.
 */
import { spawnSync } from "node:child_process";

/**
 * @param {object} diff  { newAtRisk: Item[], staleFlips: string[] }
 * @returns {null | {title, body}}
 */
export function decideNotification(diff) {
  const newAtRisk = diff.newAtRisk || [];
  const staleFlips = diff.staleFlips || [];
  if (newAtRisk.length === 0 && staleFlips.length === 0) return null;
  const parts = [];
  if (newAtRisk.length) parts.push(newAtRisk.map(i => i.title).slice(0, 3).join("; "));
  if (staleFlips.length) parts.push(`couldn't refresh: ${staleFlips.join(", ")}`);
  const n = newAtRisk.length;
  return {
    title: n ? `OfficeOS — ${n} need${n === 1 ? "s" : ""} you` : "OfficeOS",
    body: parts.join(" · ") || "Something changed.",
  };
}

// Double single-quotes for safe embedding inside a PowerShell single-quoted string.
function psEsc(s) { return String(s ?? "").replace(/'/g, "''"); }

/**
 * Build a dependency-free PowerShell script that shows a Windows toast.
 * Uses the WinRT ToastNotificationManager with PowerShell's own AppUserModelID,
 * which displays on Windows 10/11 without registering an app or installing a module.
 */
export function buildToastPowerShell(title, body) {
  const aumid = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
    "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
    "$t = $x.GetElementsByTagName('text');",
    `$t.Item(0).AppendChild($x.CreateTextNode('${psEsc(title)}')) | Out-Null;`,
    `$t.Item(1).AppendChild($x.CreateTextNode('${psEsc(body)}')) | Out-Null;`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($x);",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${psEsc(aumid)}').Show($toast);`,
  ].join("\n");
}

/**
 * Fire a toast for a diff (no-op when not toast-worthy or when not on Windows).
 * Never throws — notification failure must not break a tick.
 */
export function notify(diff, { platform = process.platform } = {}) {
  const note = decideNotification(diff);
  if (!note) return { shown: false, reason: "nothing-toast-worthy" };
  if (platform !== "win32") return { shown: false, reason: "not-windows" };
  try {
    const ps = buildToastPowerShell(note.title, note.body);
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf-8" });
    return { shown: r.status === 0, reason: r.status === 0 ? "ok" : (r.stderr || "powershell-failed") };
  } catch (err) {
    return { shown: false, reason: err.message };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test daemon/notifier.test.js`
Expected: PASS (5 tests).
Run: `node --test daemon/executors/rails-guard.test.js`
Expected: PASS (notifier is outside `daemon/executors/`, so it doesn't affect the guard — but confirm the guard still passes).

- [ ] **Step 5: Commit**

```bash
git add daemon/notifier.js daemon/notifier.test.js
git commit -m "feat(daemon): Windows toast notifier (decision + ps builder)"
```

---

### Task 6: Scheduler enrichment — report what changed for notification

**Files:**
- Modify: `daemon/scheduler.js`
- Modify: `daemon/scheduler.test.js`

The tick must tell the daemon *what* changed so the notifier can speak. Compute `newAtRisk` (items now `at_risk` that were absent or not `at_risk` before) and `staleFlips` (accounts that became `stale` this tick), include them in the emitted event and the return value, and emit when the items changed OR an account flipped stale.

- [ ] **Step 1: Add failing test cases to `daemon/scheduler.test.js`**

Append inside the existing `describe("runTick", ...)` block:

```js
  it("reports newAtRisk items in the emit payload and return value", async () => {
    const dir = tmp();
    try {
      const events = [];
      const d = deps(dir, { emit: (e) => events.push(e) });
      const summary = await runTick(d);
      assert.ok(summary.notify.newAtRisk.some(i => i.group.rootCause === "card_4821"));
      assert.ok(events[0].notify.newAtRisk.length >= 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("flips an account stale and emits even when item set is unchanged", async () => {
    const dir = tmp();
    try {
      await runTick(deps(dir)); // seed ok + items
      const events = [];
      const d = deps(dir, { fetchFn: async () => { throw new Error("boom"); }, emit: (e) => events.push(e), store: createStore(dir) });
      const summary = await runTick(d);
      assert.deepEqual(summary.notify.staleFlips, ["brickell"]);
      assert.equal(events.length, 1); // emitted despite items being retained/unchanged
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `node --test daemon/scheduler.test.js`
Expected: FAIL — `summary.notify` is undefined.

- [ ] **Step 3: Modify `daemon/scheduler.js`**

Track stale flips in the fetch-catch. Change the catch block (currently lines 34-39) to record a flip when the account was not already stale:

```js
    } catch (err) {
      warnings.push(`[${account.id}] fetch failed: ${err.message}`);
      const wasStale = prev.accounts?.[account.id]?.status === "stale";
      if (!wasStale) staleFlips.push(account.id);
      accountsState[account.id] = { status: "stale", lastTickAt: clock.now };
      nextItems.push(...prev.items.filter(i => i.account === account.id));
      continue;
    }
```

Declare `staleFlips` next to `warnings` (currently line 25):

```js
  const warnings = [];
  const staleFlips = [];
```

After `nextModel` is built and before the diff (currently around line 54-65), compute `newAtRisk`:

```js
  // newAtRisk: items that are at_risk now and were absent or not-at_risk before
  const newAtRisk = nextItems.filter(i =>
    i.status === "at_risk" && prevItemsById.get(i.id)?.status !== "at_risk"
  );
```

Change the diff/emit/return tail (currently lines 63-71) to:

```js
  // diff: compare item sets ignoring lastChanged timestamps
  const norm = (m) => JSON.stringify(m.items.map(i => ({ ...i, lastChanged: null })));
  const changed = norm(prev) !== norm(nextModel);

  store.saveModel(nextModel);
  store.saveQueue(queue);

  const notify = { newAtRisk, staleFlips };
  if (changed || staleFlips.length) emit({ type: "update", at: clock.now, notify });

  return { changed, warnings, itemCount: nextItems.length, notify };
```

- [ ] **Step 4: Run to verify all scheduler tests pass**

Run: `node --test daemon/scheduler.test.js`
Expected: PASS (5 tests — the original 3 plus the 2 new). The original "emits an update event only when the model changed" test must still pass: two identical ticks produce no item change and no stale flip, so exactly one emit.

- [ ] **Step 5: Commit**

```bash
git add daemon/scheduler.js daemon/scheduler.test.js
git commit -m "feat(daemon): scheduler reports newAtRisk + staleFlips for toasts"
```

---

### Task 7: Wire the notifier and panel into the daemon

**Files:**
- Modify: `daemon/daemon.js`

- [ ] **Step 1: Import the notifier**

Add to the imports in `daemon/daemon.js` (after the wiring import, line 16):

```js
import { notify } from "./notifier.js";
```

- [ ] **Step 2: Fire toasts on tick events**

The `emit` callback passed into `deps` currently only broadcasts SSE (line 86). Change the `tick()` function so emitted events both broadcast to the panel AND fire a toast when the event carries a `notify` payload:

```js
  async function tick() {
    try {
      await runTick(deps((e) => {
        server.broadcastUpdate(e);
        if (e?.notify) notify(e.notify); // fire-and-forget; never throws
      }));
      lastTickAt = new Date().toISOString();
    } catch (err) {
      process.stderr.write(`tick error: ${err.message}\n`);
    }
  }
```

- [ ] **Step 3: Confirm the panel is reachable**

The server already serves `daemon/web/` via the Task 1 default `webDir`. No change needed — the daemon's `createApiServer({ store, ctxFor, getLastTickAt })` call uses the default web dir. Add a one-line confirmation to the startup log (change line 81):

```js
    process.stdout.write(JSON.stringify({ type: "daemon-started", url: `http://localhost:${port}`, panel: `http://localhost:${port}/` }) + "\n");
```

- [ ] **Step 4: Verify nothing regressed**

Run: `npm test`
Expected: all daemon + scripts tests green.
Run: `node daemon/daemon.js --once`
Expected: same clean behavior as Plan 1 (JSON tick summary if live config present, else a clean missing-config error — NOT a SyntaxError/ReferenceError from the new imports).

- [ ] **Step 5: Commit**

```bash
git add daemon/daemon.js
git commit -m "feat(daemon): wire panel serving + toast notifier into the daemon"
```

---

### Task 8: Manual verification + docs

**Files:**
- Create: `daemon/seed-demo.js` (a tiny dev helper to seed a demo world model so the panel can be viewed without live email)
- Modify: `daemon/README.md`

- [ ] **Step 1: Create `daemon/seed-demo.js`** — writes a demo model+queue into a data dir so the panel renders without connectors:

```js
/**
 * seed-demo.js — dev-only: seed a demo world model + queue so the panel can be
 * viewed without live email. Usage: node daemon/seed-demo.js [dataDir]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.argv[2] || join(root, "data");
const store = createStore(dataDir);

const now = new Date().toISOString();
store.saveModel({
  generatedAt: now,
  accounts: { brickell: { status: "ok", lastTickAt: now }, summit: { status: "stale", lastTickAt: now } },
  items: [
    { id: "brickell:owed_risk:card_4821", jobType: "owed_risk", account: "brickell",
      title: "2 failed payments — one root cause", status: "at_risk",
      group: { rootCause: "card_4821", members: [{ vendor: "Acme", from: "billing@acme.com", subject: "Payment failed", emailId: "e1" }, { vendor: "Globex", from: "ar@globex.com", subject: "Declined", emailId: "e2" }] },
      source: [{ kind: "thread", emailId: "e1" }, { kind: "url", url: "https://pay.example/portal" }],
      proposedActions: ["draft_chase", "route:billing_portal"], lastChanged: now },
  ],
});
store.saveQueue({ proposals: [
  { id: "brickell:owed_risk:card_4821::draft_chase", itemId: "brickell:owed_risk:card_4821", action: "draft_chase",
    params: { account: "brickell", drafts: [{}, {}] }, preview: { summary: "2 failed payments — one root cause", drafts: [{}, {}] }, state: "pending" },
] });
process.stdout.write(`seeded demo model at ${dataDir}\n`);
```

- [ ] **Step 2: Run the manual verification**

Run, in two terminals (or background the first):
```bash
node daemon/seed-demo.js /tmp/officeos-demo
BRAINSTORM_unused=1 node -e "1"   # noop placeholder; ignore
```
Then start a server pointed at the demo data by temporarily seeding the real data dir, OR run:
```bash
node daemon/seed-demo.js          # seeds ./data
node daemon/daemon.js --port 8138 # in another terminal; Ctrl-C when done
```
Open `http://localhost:8138/` in a browser. **Verify by observation:**
- the header shows "2 need you" and a stale warning for `summit`;
- the card shows the title, `card_4821`, vendors, an **Approve** button and an **Open** link;
- the filter box narrows the list;
- selecting the card enables **Approve selected**.

Capture a screenshot of the panel for the record (use the platform's screenshot/preview tool). If approving in the demo errors (no real Graph creds), that is expected — the demo seeds drafts as empty objects; the executor will fail gracefully and the proposal will show `failed`. To verify the toast path on Windows, run:
```bash
node -e "import('./daemon/notifier.js').then(m=>console.log(m.notify({newAtRisk:[{title:'2 failed payments — one root cause'}],staleFlips:['summit']})))"
```
Expected: a Windows toast appears (or `{shown:false, reason:'not-windows'}` off-Windows). Record the result.

- [ ] **Step 3: Update `daemon/README.md`** — replace the "Headless in this milestone" note and add a Panel section. Change the intro paragraph to:

```markdown
Always-on local service that turns the email pipeline into a live world model +
staged proposal queue, served over `localhost`. Includes a glanceable web panel
(grouped "needs you" list, approve/dismiss, drill-in workbench) and daemon-fired
Windows toasts on threshold-crossing changes.
```

And add this section after the "API" section:

```markdown
## Panel

Open `http://localhost:8138/` (served by the daemon). It live-updates via SSE,
shows what needs you grouped by account, and lets you approve/dismiss proposals
or multi-select for a bulk approve. Pin it as a standalone window for an ambient
glance. Toasts fire automatically when new at-risk items appear or an account
goes stale.

Dev preview without live email:

\`\`\`bash
node daemon/seed-demo.js   # seed a demo world model into ./data
node daemon/daemon.js      # then open http://localhost:8138/
\`\`\`
```

- [ ] **Step 4: Commit**

```bash
git add daemon/seed-demo.js daemon/README.md
git commit -m "docs(daemon): panel usage + demo seed; manual verification"
```

---

## Self-Review (completed during authoring)

**Spec coverage (against the design doc):** §4 packaging "pinned localhost panel + daemon toasts" → Tasks 1,3,5,7. The panel as the consuming surface (ambient glance + agent proposals + drill-in) → Tasks 3 (list + approve/dismiss = A+B) and 4 (workbench drill-in = C). §9 liveness (SSE live updates) → Task 3; §10 error handling (stale account surfaced, executor failure visible) → render of `staleAccounts` + the `failed` proposal state already returned by the Plan-1 API. §11 rails: the notifier and panel contain no send/delete; `notifier.js` is documented and the executor rails-guard remains green. Notifier ambience (§4) → Tasks 5–7. The "account status changes don't emit" gap from the Plan-1 final review → fixed in Task 6 (`staleFlips` triggers emit + toast).

**Placeholder scan:** no TBD/TODO; every code step has complete code; the one deliberate stray-`};` in the Task 3 test is called out with its fix immediately below it.

**Type consistency:** `toPanelView`/`filterItems`/`renderHeader`/`renderItemCard`/`renderSelectControls`/`toggle`/`pendingApprovalsFor`/`decideNotification`/`buildToastPowerShell`/`notify` names match across definition and call sites. The view's item shape (`item.proposals` attached by `toPanelView`) is what `renderItemCard`, `pendingApprovalsFor`, and the bulk-approve handler all consume. The scheduler's `notify` payload (`{newAtRisk, staleFlips}`) matches `decideNotification`'s parameter exactly.

**Scope check:** single coherent surface milestone; other job-types + reasoner fallback correctly deferred to Plan 3.

**Known follow-ups (not gold-plated here):** the panel polls the full `/model` on each SSE tick (simple and fine at single-user scale); toast click does not deep-link into the panel (informational only — the panel is pinned); these match the spec's "simplest thing that delivers the rich experience."
```
