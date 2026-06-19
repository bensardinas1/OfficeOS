# Panel Summary Drill-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `handled` summary tile's Details list its underlying emails (newest-first, capped at 50), and make the detail panel scale: auto-load bodies only for ≤5-message tiles; larger tiles get a per-row "Show message" click-to-expand.

**Architecture:** `handled.js` populates `group.members` from the classified non-ignore emails (it already counts them) plus a `moreCount`. `renderDetailPanel` switches body rendering on member count; `app.js` gains a `data-loadbody` handler and skips auto-fetch for large tiles.

**Tech Stack:** Node ESM, `node:test`, vanilla browser JS/CSS.

**Spec:** `docs/superpowers/specs/2026-06-18-panel-undo-and-summary-detail-design.md` (Feature 2; Plan 2 of 2).

**Baseline:** full suite green (540/540). Run `npm test`. Keep green.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `daemon/normalizers/handled.js` | per-account summary item | populate members (cap 50) + `moreCount` |
| `daemon/web/render.js` | detail panel | ≤5 auto-body / >5 click-to-expand + "+N more" |
| `daemon/web/app.js` | DOM glue | auto-load only ≤5; `data-loadbody` handler |
| `daemon/web/styles.css` | styling | `.showbody`, `.dmore` |
| tests | `handled.test.js`, `render.test.js`, `contract.test.js` | extend |

---

## Task 1: `handled.js` populates its emails (capped) + `moreCount`

**Files:**
- Modify: `daemon/normalizers/handled.js`
- Test: `daemon/normalizers/handled.test.js`

- [ ] **Step 1: Write failing tests**

In `daemon/normalizers/handled.test.js`, add (the existing `classifiedWith` helper makes emails `{ id: "<cat><i>" }`; we add a fixture with richer emails):

```js
  it("populates members from non-ignore emails, newest-first, capped at 50", () => {
    const emails = (n, cat) => Array.from({ length: n }, (_, i) => ({ id: `${cat}${i}`, subject: `${cat}-${i}`, from: `${cat}${i}@x.com`, fromName: cat, receivedAt: `2026-06-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z` }));
    const classified = { categories: { action: { emails: emails(30, "a") }, fyi: { emails: emails(40, "f") }, ignore: { emails: emails(5, "ig") } } };
    const it0 = normalizeHandled(classified, account, typeConfig)[0];
    assert.equal(it0.group.members.length, 50);          // capped
    assert.equal(it0.group.moreCount, 20);               // 70 non-ignore - 50
    // newest-first: first member's receivedAt >= second's
    assert.ok(it0.group.members[0].receivedAt >= it0.group.members[1].receivedAt);
    // ignore bucket excluded
    assert.ok(!it0.group.members.some(m => m.emailId.startsWith("ig")));
    // member shape
    assert.ok("subject" in it0.group.members[0] && "from" in it0.group.members[0] && "emailId" in it0.group.members[0]);
  });
  it("sets moreCount 0 and keeps members empty when nothing is non-ignore", () => {
    const it0 = normalizeHandled(classifiedWith({ ignore: 4 }), account, typeConfig)[0];
    assert.equal(it0.group.members.length, 0);
    assert.equal(it0.group.moreCount, 0);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test daemon/normalizers/handled.test.js`
Expected: FAIL — members is `[]`, `moreCount` undefined.

- [ ] **Step 3: Populate members in `daemon/normalizers/handled.js`**

Replace the body of `normalizeHandled` (from the `let needsYou` line through the `return [...]`) with:

```js
  const actionable = actionableIds(typeConfig);
  const { lookbackHours, nowMs = Date.now() } = opts;
  let needsYou = 0;
  let waiting = 0;
  const all = [];
  for (const [id, bucket] of Object.entries(classified.categories || {})) {
    if (id === "ignore") continue;
    const emails = (bucket.emails || []).filter(e => !lookbackHours || withinLookback(e, lookbackHours, nowMs));
    if (actionable.has(id)) needsYou += emails.length; else waiting += emails.length;
    for (const e of emails) all.push({ subject: e.subject, from: e.from, fromName: e.fromName, receivedAt: e.receivedAt || e.received, emailId: e.id });
  }
  all.sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
  const CAP = 50;
  const members = all.slice(0, CAP);
  const moreCount = Math.max(0, all.length - CAP);

  // Lead with the one number that requires the user (a reply or decision);
  // demote the heterogeneous "everything else" pile to a quiet subtitle.
  const title = needsYou > 0
    ? `${needsYou} ${needsYou === 1 ? "needs" : "need"} a reply or decision`
    : (waiting > 0 ? "Nothing needs a reply" : "Inbox clear");
  const subtitle = waiting > 0 ? `+ ${waiting} informational` : "";
  return [{
    id: `${account.id}:handled`,
    jobType: "handled",
    account: account.id,
    title,
    subtitle,
    status: "ok",
    group: { rootCause: "handled", members, moreCount, counts: { needsYou, waiting } },
    source: [],
    proposedActions: [],
    lastChanged: null,
  }];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test daemon/normalizers/handled.test.js`
Expected: PASS (all — the counts/title/subtitle tests still pass since the count logic is unchanged).

- [ ] **Step 5: Commit**

```bash
git add daemon/normalizers/handled.js daemon/normalizers/handled.test.js
git commit -m "feat(handled): summary tile carries its emails (newest-first, cap 50)"
```

---

## Task 2: Detail panel scales (≤5 auto-body / >5 click-to-expand + "+N more")

**Files:**
- Modify: `daemon/web/render.js`, `daemon/web/app.js`, `daemon/web/styles.css`
- Test: `daemon/web/render.test.js`, `daemon/web/contract.test.js`

- [ ] **Step 1: Add failing tests**

In `daemon/web/render.test.js`, append:

```js
describe("detail body scaling", () => {
  const mk = (n) => ({
    id: "brickell:handled", account: "brickell", jobType: "handled", title: "T", status: "ok",
    display: { accountLabel: "Brickell Pay" },
    group: { rootCause: "handled", moreCount: n > 50 ? n - 50 : 0, members: Array.from({ length: Math.min(n, 50) }, (_, i) => ({ subject: `s${i}`, from: `a${i}@x.com`, fromName: "X", emailId: `e${i}`, receivedAt: `2026-06-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z` })) },
    source: [], proposals: [],
  });
  it("auto-loads bodies when ≤5 messages (data-body-for, no toggle)", () => {
    const html = renderDetailPanel(mk(3), 0);
    assert.match(html, /data-body-for="e0"/);
    assert.doesNotMatch(html, /data-loadbody/);
  });
  it("uses click-to-expand when >5 messages (data-loadbody + hidden body)", () => {
    const html = renderDetailPanel(mk(8), 0);
    assert.match(html, /data-loadbody="e0"/);
    assert.match(html, /Show message/);
    assert.match(html, /data-body-for="e0" hidden/);
  });
  it("shows a '+N more' note when moreCount > 0", () => {
    assert.match(renderDetailPanel(mk(60), 0), /\+ 10 more/);
  });
});
```

In `daemon/web/contract.test.js`, add inside the top-level describe:

```js
  it("app handles the click-to-expand body action", () => {
    assert.match(render, /data-loadbody/, "render must emit data-loadbody for large tiles");
    assert.match(app, /\[data-loadbody\]/, "app must select [data-loadbody]");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test daemon/web/render.test.js daemon/web/contract.test.js`
Expected: FAIL — no `data-loadbody`, no "+N more", app lacks the handler.

- [ ] **Step 3: Update `renderDetailPanel` in `daemon/web/render.js`**

Replace the `const msgs = members.map(...)` block and the `dmsgs` line. First compute `autoBodies` before the map and build each row's body region conditionally:

```js
  const autoBodies = members.length <= 5;
  const msgs = members.map(m => {
    const who = m.fromName || m.from || m.vendor || "";
    const when = relativeTime(m.receivedAt, nowMs);
    const bodyRegion = m.emailId
      ? (autoBodies
          ? `<div class="msgbody" data-body-for="${esc(m.emailId)}"><span class="bodyload">Loading…</span></div>`
          : `<button class="showbody" data-loadbody="${esc(m.emailId)}">Show message</button><div class="msgbody" data-body-for="${esc(m.emailId)}" hidden></div>`)
      : "";
    const rowDel = m.emailId ? confirmBtn({ cls: "del", attr: "data-delete", value: item.account, extra: ` data-ids="${esc(m.emailId)}"`, token: `del:msg:${m.emailId}`, verb: "delete", confirm }) : "";
    const rowKill = m.from ? confirmBtn({ cls: "kill", attr: "data-killlist", value: item.account, extra: ` data-sender="${esc(m.from)}"`, token: `kill:msg:${m.emailId || m.from}`, verb: "kill list", confirm }) : "";
    return `<div class="msg"><div class="msgsub">${esc(m.subject || "(no subject)")}</div>`
      + `<div class="msgmeta">${esc(who)}${who && when ? " · " : ""}${esc(when)}</div>`
      + `<div class="msgactions">${rowDel}${rowKill}</div>`
      + `${bodyRegion}</div>`;
  }).join("");
  const moreNote = g.moreCount > 0 ? `<div class="dmore">+ ${esc(g.moreCount)} more not shown</div>` : "";
```

Then change the `dmsgs` line in the return to append the note:

```js
    + `<div class="dmsgs-h">Messages</div><div class="dmsgs">${msgs}</div>${moreNote}`
```

- [ ] **Step 4: Update `daemon/web/app.js`**

(a) In `loadBodies`, skip auto-fetch for large tiles. Change the start of `loadBodies` to:

```js
function loadBodies(item) {
  if (!item) return;
  const members = item.group?.members || [];
  if (members.length > 5) return; // large tiles use click-to-expand (data-loadbody)
  for (const m of members) {
```

(b) Add a `data-loadbody` click handler. In the click listener, after the `[data-killlist]` block and BEFORE the shared `ui.confirm = null; ui.notice = null;` line, add:

```js
  const lb = e.target.closest("[data-loadbody]");
  if (lb) {
    const id = lb.dataset.loadbody;
    const v = toPanelView(lastModel);
    const item = ui.detailItemId ? findItem(v, ui.detailItemId) : null;
    const account = item?.account;
    const el = appEl.querySelector(`[data-body-for="${CSS.escape(id)}"]`);
    if (el && account) {
      el.hidden = false;
      lb.remove();
      if (bodyCache.has(id)) { fillBody(el, bodyCache.get(id)); }
      else {
        el.textContent = "Loading…";
        fetch(`/messages/${encodeURIComponent(id)}/body?account=${encodeURIComponent(account)}`)
          .then(r => r.json())
          .then(d => { const val = d.ok === false ? { error: d.error || "error" } : { text: d.body || "" }; bodyCache.set(id, val); fillBody(el, val); })
          .catch(() => fillBody(el, { error: "Couldn't load body" }));
      }
    }
    return;
  }
```

- [ ] **Step 5: Style in `daemon/web/styles.css`**

Append:

```css
.showbody { background:transparent; color:var(--accent); border:1px solid var(--line); border-radius:6px; padding:4px 10px; font-size:12px; cursor:pointer; margin-top:8px; }
.dmore { color:#8a94a6; font-size:12px; margin-top:10px; }
```

- [ ] **Step 6: Run the web suite**

Run: `node --test daemon/web`
Expected: PASS — including the Plan A test ("renders a lazy body placeholder per message keyed by emailId") which uses a 2-member item (≤5 → auto), and the new scaling tests.

- [ ] **Step 7: Commit**

```bash
git add daemon/web/render.js daemon/web/app.js daemon/web/styles.css daemon/web/render.test.js daemon/web/contract.test.js
git commit -m "feat(panel): detail bodies scale — ≤5 auto, >5 click-to-expand, +N more"
```

---

## Task 3: Full suite + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS, total above the 540 baseline. (Note: a single reasoner test shells the `claude` CLI and logs "claude down" when unavailable but fail-opens to deterministic grouping — it still passes; if it ever shows as failed, re-run, it's an environment flake, not this plan.)

- [ ] **Step 2: Manual smoke (operator)**

Restart the daemon from the main checkout and open the panel. Click **Details** on a summary (handled) tile, e.g. "Personal · + N informational". Confirm: the underlying emails are listed (sender · subject · date), newest first; for a small inbox (≤5) bodies auto-load; for a larger one each row shows **"Show message"** that loads that one body on click; a **"+N more not shown"** note appears when the inbox exceeds 50. (Delete / Kill list on those rows come from Plan B.)

No commit unless the smoke surfaces a fix.

---

## Self-Review

**Spec coverage (Feature 2):**
- Summary tile lists underlying emails, newest-first, cap 50, "+N more" → Task 1 (members + moreCount) + Task 2 (note). ✓
- Body fetch at scale: ≤5 auto / >5 click-to-expand → Task 2 (`autoBodies`, `data-loadbody`, `loadBodies` guard). ✓
- Counts/title/subtitle/`status: ok` unchanged; fingerprint unaffected (handled not acknowledgeable) → Task 1 keeps the count logic and item shape. ✓
- Existing finding tiles (≤5 members) keep auto-load → Task 2 `autoBodies` true for them. ✓

**Placeholder scan:** none — full code in every step.

**Type/name consistency:** `group.members` (objects `{subject, from, fromName, receivedAt, emailId}`), `group.moreCount`, render `autoBodies`/`data-loadbody`/`.dmore`/`.showbody`, app `loadBodies` guard + `[data-loadbody]` handler reusing `bodyCache`/`fillBody`. The `data-loadbody` body fetch uses the same `/messages/:id/body?account=` endpoint and `{body}`/`{ok:false}` shape as Plan A. Consistent. ✓
