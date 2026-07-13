# Daemon Reliability + Observability (Cluster A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daemon survive crashes/reboots (Scheduled Task + process handlers), log its life (`data/daemon.log`), record every mutating action in an append-only audit log (`data/actions.jsonl`) that drives persistent acted/Undo state in the panel, and add a hermetic Playwright smoke (`npm run test:e2e`).

**Architecture:** Two new small daemon modules (`log.js` operational logger, `action-log.js` audit log + pure `deriveActed`), threaded into `api.js` (append on mutation, new `GET /actions`) and `daemon.js` (crash handlers, singleton guard, `--data-dir`/`--config-dir` flags, opt-in fake connectors). The panel hydrates its existing `ui.acted` map from `GET /actions`. A PowerShell installer registers the at-logon Scheduled Task. Spec: `docs/superpowers/specs/2026-07-13-daemon-reliability-observability-design.md`.

**Tech Stack:** Node 24 ESM, `node:test` + `node:assert/strict`, zero runtime dependencies (Playwright is a devDependency only), PowerShell 7 for the installer, Windows Task Scheduler.

## Global Constraints

- **Zero runtime dependencies.** `@playwright/test` goes in `devDependencies` only.
- **Safety rails unchanged:** no new mail-touching code paths; logs are local files only; soft-delete/config-only semantics untouched; no auto-send anywhere.
- **Fake connectors activate ONLY when `process.env.OFFICEOS_FAKE_CONNECTORS === "1"`** — never the default.
- **Append-only files:** `actions.jsonl` and `daemon.log` are never rewritten in place (rotation renames whole files). Corrupt lines/files degrade to empty — never throw (matches `store.js` philosophy).
- **All file writes to data dirs must tolerate OneDrive locks** — use `appendFileSync` (append is safe) or helpers from `scripts/fs-utils.js` (`atomicWrite`, `safeRename`).
- Tests run with `npm test` (`node --test "scripts/test/**/*.test.js" "daemon/**/*.test.js"`). Full suite currently 576 passing; it must stay green after every task.
- Commit after every task with a conventional-commit message.

---

## File map

| File | Task | Role |
|---|---|---|
| `daemon/log.js` (create) | 1 | operational JSONL logger + startup rotation |
| `daemon/log.test.js` (create) | 1 | |
| `daemon/action-log.js` (create) | 2 | append-only audit log + pure `deriveActed` |
| `daemon/action-log.test.js` (create) | 2 | |
| `daemon/api.js` (modify) | 3 | append entries on mutations, `GET /actions`, richer `/health` |
| `daemon/api.test.js` (modify) | 3 | |
| `daemon/fake-connectors.js` (create) | 4 | canned-success connector set for e2e |
| `daemon/wiring.js` (modify) | 4 | pure `chooseConnectors(env, real, fake)` |
| `daemon/wiring.test.js` (modify) | 4 | |
| `daemon/daemon.js` (modify) | 4 | flags, crash handlers, singleton guard, logger + action-log wiring |
| `daemon/web/app.js` (modify) | 5 | hydrate `ui.acted` from `/actions`, send `undoOf` + `emailIds` |
| `daemon/web/contract.test.js` (modify) | 5 | |
| `e2e/panel.smoke.spec.js` (create) | 6 | Playwright smoke |
| `playwright.config.js` (create) | 6 | |
| `package.json` (modify) | 6 | `test:e2e` script + devDependency |
| `scripts/install-daemon-task.ps1` (create) | 7 | Scheduled Task installer |
| `daemon/README.md` (modify) | 7 | document all of the above |

---

### Task 1: `daemon/log.js` — operational logger

**Files:**
- Create: `daemon/log.js`
- Test: `daemon/log.test.js`

**Interfaces:**
- Produces: `createLogger(dataDir) -> { log(level, event, fields?) }`. Appends one JSON line `{at, level, event, ...fields}` to `<dataDir>/daemon.log`, echoes to stdout (info) / stderr (error), never throws. On creation, if the file exceeds 5 MB it is renamed to `daemon.log.1` (replacing any previous `.1`).

- [ ] **Step 1: Write the failing test**

Create `daemon/log.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./log.js";

function tmp() { return mkdtempSync(join(tmpdir(), "officeos-log-")); }

describe("createLogger", () => {
  it("appends one JSON line per event with at/level/event + fields", () => {
    const dir = tmp();
    const logger = createLogger(dir);
    logger.log("info", "daemon-started", { pid: 123, port: 8138 });
    logger.log("error", "tick-error", { stack: "boom" });
    const lines = readFileSync(join(dir, "daemon.log"), "utf-8").trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].event, "daemon-started");
    assert.equal(lines[0].level, "info");
    assert.equal(lines[0].pid, 123);
    assert.ok(Date.parse(lines[0].at) > 0);
    assert.equal(lines[1].level, "error");
    assert.equal(lines[1].stack, "boom");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rotates an oversized log to .1 at creation time", () => {
    const dir = tmp();
    writeFileSync(join(dir, "daemon.log"), "x".repeat(5 * 1024 * 1024 + 1), "utf-8");
    createLogger(dir);
    assert.ok(existsSync(join(dir, "daemon.log.1")));
    assert.ok(!existsSync(join(dir, "daemon.log")));
    rmSync(dir, { recursive: true, force: true });
  });

  it("never throws when the data dir is unwritable", () => {
    // point at a path that cannot exist as a dir (file in the way)
    const dir = tmp();
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "file", "utf-8");
    const logger = createLogger(join(blocked, "sub")); // mkdir will fail
    assert.doesNotThrow(() => logger.log("info", "x", {}));
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test daemon/log.test.js`
Expected: FAIL — `Cannot find module ... log.js`

- [ ] **Step 3: Write minimal implementation**

Create `daemon/log.js`:

```js
/**
 * log.js — operational JSONL logger for the daemon. One line per event:
 * {at, level, event, ...fields} appended to <dataDir>/daemon.log and echoed
 * to stdout/stderr. Logging must never crash the daemon: every fs call is
 * wrapped. Rotation happens only at creation (daemon restarts often enough):
 * >5MB renames to daemon.log.1, replacing any previous .1.
 */
import { appendFileSync, existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { safeRename } from "../scripts/fs-utils.js";

const MAX_BYTES = 5 * 1024 * 1024;

export function createLogger(dataDir) {
  const path = join(dataDir, "daemon.log");
  try {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      const prev = path + ".1";
      if (existsSync(prev)) rmSync(prev, { force: true });
      safeRename(path, prev);
    }
  } catch { /* logging must never throw */ }
  return {
    log(level, event, fields = {}) {
      const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...fields });
      try { (level === "error" ? process.stderr : process.stdout).write(line + "\n"); } catch {}
      try { appendFileSync(path, line + "\n", "utf-8"); } catch {}
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test daemon/log.test.js`
Expected: 3 passing

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected all green (579 total).

```bash
git add daemon/log.js daemon/log.test.js
git commit -m "feat(daemon): operational JSONL logger with startup rotation"
```

---

### Task 2: `daemon/action-log.js` — audit log + `deriveActed`

**Files:**
- Create: `daemon/action-log.js`
- Test: `daemon/action-log.test.js`

**Interfaces:**
- Produces:
  - `createActionLog(dataDir, clock?) -> { append(entry) -> fullEntry, recent({days=7}?) -> entry[] }`.
    `append` stamps `{id, at}` onto the entry and appends one JSON line to `<dataDir>/actions.jsonl`; returns the full entry (Task 3 returns `entryId` to clients from it). `clock` defaults to `{ now: () => new Date().toISOString() }` and is injectable for tests.
  - `deriveActed(entries) -> { [emailId]: {deleted?, killed?, account, emailIds, sender?, deleteEntryId?, killEntryId?} }` — pure. Rules: entries with `result.error` are ignored; `killlist_add` requires `result.added === true`; an entry referenced by a later entry's `undoOf` is neutralized; undo entries themselves (`undoOf` set) never contribute; maps are keyed **by emailId only** (each value's `emailIds` is `[thatId]`, matching the panel's existing per-row shape).

Entry shape (from the spec):

```json
{ "id": "<ts36>-<hex>", "at": "ISO", "action": "delete|restore|killlist_add|killlist_remove|triage",
  "account": "brickellpay", "emailIds": ["..."], "sender": "x@y.com",
  "result": { "trashed": 3, "failed": 0 }, "undoOf": "<entry id, optional>" }
```

- [ ] **Step 1: Write the failing test**

Create `daemon/action-log.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActionLog, deriveActed } from "./action-log.js";

function tmp() { return mkdtempSync(join(tmpdir(), "officeos-actions-")); }

describe("createActionLog", () => {
  it("round-trips appended entries with generated id + at", () => {
    const dir = tmp();
    const log = createActionLog(dir);
    const e = log.append({ action: "delete", account: "brickell", emailIds: ["a"], result: { trashed: 1, failed: 0 } });
    assert.ok(e.id);
    assert.ok(Date.parse(e.at) > 0);
    const back = log.recent();
    assert.equal(back.length, 1);
    assert.equal(back[0].id, e.id);
    assert.equal(back[0].action, "delete");
    rmSync(dir, { recursive: true, force: true });
  });

  it("recent() filters by day window and skips corrupt lines", () => {
    const dir = tmp();
    const old = { now: () => "2026-01-01T00:00:00.000Z" };
    createActionLog(dir, old).append({ action: "delete", account: "b", emailIds: ["old"], result: { trashed: 1 } });
    appendFileSync(join(dir, "actions.jsonl"), "{not json\n", "utf-8");
    const log = createActionLog(dir);
    log.append({ action: "delete", account: "b", emailIds: ["new"], result: { trashed: 1 } });
    const back = log.recent({ days: 7 });
    assert.equal(back.length, 1);
    assert.deepEqual(back[0].emailIds, ["new"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("recent() returns [] when the file is missing", () => {
    const dir = tmp();
    assert.deepEqual(createActionLog(dir).recent(), []);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("deriveActed", () => {
  const del = { id: "d1", at: "t", action: "delete", account: "b", emailIds: ["e1", "e2"], result: { trashed: 2, failed: 0 } };
  const kill = { id: "k1", at: "t", action: "killlist_add", account: "b", sender: "spam@x.com", emailIds: ["e1"], result: { added: true } };

  it("marks deleted emailIds per-row, with the contributing entry id", () => {
    const acted = deriveActed([del]);
    assert.deepEqual(acted.e1, { deleted: true, account: "b", emailIds: ["e1"], deleteEntryId: "d1" });
    assert.deepEqual(acted.e2, { deleted: true, account: "b", emailIds: ["e2"], deleteEntryId: "d1" });
  });

  it("merges kill onto the same row and records sender + killEntryId", () => {
    const acted = deriveActed([del, kill]);
    assert.equal(acted.e1.deleted, true);
    assert.equal(acted.e1.killed, true);
    assert.equal(acted.e1.sender, "spam@x.com");
    assert.equal(acted.e1.killEntryId, "k1");
    assert.equal(acted.e2.killed, undefined);
  });

  it("an undoOf entry neutralizes its target and contributes nothing itself", () => {
    const undo = { id: "r1", at: "t", action: "restore", account: "b", emailIds: ["e1", "e2"], result: { restored: 2 }, undoOf: "d1" };
    assert.deepEqual(deriveActed([del, undo]), {});
  });

  it("failed results and refused kills contribute nothing", () => {
    const failedDel = { id: "d2", at: "t", action: "delete", account: "b", emailIds: ["e9"], result: { error: "boom" } };
    const refusedKill = { id: "k2", at: "t", action: "killlist_add", account: "b", sender: "vip@x.com", emailIds: ["e9"], result: { added: false, reason: "protected" } };
    assert.deepEqual(deriveActed([failedDel, refusedKill]), {});
  });

  it("triage and restore (non-undo) entries contribute nothing", () => {
    const triage = { id: "t1", at: "t", action: "triage", account: null, result: { ok: true } };
    const plainRestore = { id: "r2", at: "t", action: "restore", account: "b", emailIds: ["e1"], result: { restored: 1 } };
    assert.deepEqual(deriveActed([triage, plainRestore]), {});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test daemon/action-log.test.js`
Expected: FAIL — `Cannot find module ... action-log.js`

- [ ] **Step 3: Write minimal implementation**

Create `daemon/action-log.js`:

```js
/**
 * action-log.js — append-only audit log of every mutating action the daemon
 * performs (data/actions.jsonl), plus the pure deriveActed() fold that turns
 * recent entries into the panel's acted map. Undo is append-only: a reversing
 * entry carries undoOf=<original id>; nothing is ever rewritten (OneDrive-safe,
 * and the file doubles as a permanent audit trail). Corrupt lines are skipped.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export function createActionLog(dataDir, clock = { now: () => new Date().toISOString() }) {
  const path = join(dataDir, "actions.jsonl");
  try { mkdirSync(dataDir, { recursive: true }); } catch {}
  return {
    append(entry) {
      const full = { id: `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`, at: clock.now(), ...entry };
      try { appendFileSync(path, JSON.stringify(full) + "\n", "utf-8"); } catch {}
      return full;
    },
    recent({ days = 7 } = {}) {
      if (!existsSync(path)) return [];
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const out = [];
      let raw;
      try { raw = readFileSync(path, "utf-8"); } catch { return []; }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (Date.parse(e.at) >= cutoff) out.push(e);
        } catch { /* skip corrupt line */ }
      }
      return out;
    },
  };
}

/** Pure fold: recent entries (oldest-first) -> the panel's acted map, keyed by emailId. */
export function deriveActed(entries) {
  const undone = new Set(entries.filter(e => e.undoOf).map(e => e.undoOf));
  const acted = {};
  for (const e of entries) {
    if (e.undoOf || undone.has(e.id) || e.result?.error) continue;
    if (e.action === "delete") {
      for (const id of e.emailIds || []) {
        acted[id] = { ...(acted[id] || {}), deleted: true, account: e.account, emailIds: [id], deleteEntryId: e.id };
      }
    } else if (e.action === "killlist_add" && e.result?.added === true) {
      for (const id of e.emailIds || []) {
        acted[id] = { ...(acted[id] || {}), killed: true, account: e.account, emailIds: [id], sender: e.sender, killEntryId: e.id };
      }
    }
  }
  return acted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test daemon/action-log.test.js`
Expected: 8 passing

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected all green.

```bash
git add daemon/action-log.js daemon/action-log.test.js
git commit -m "feat(daemon): append-only action audit log + pure deriveActed fold"
```

---

### Task 3: api.js — append on mutations, `GET /actions`, richer `/health`

**Files:**
- Modify: `daemon/api.js`
- Test: `daemon/api.test.js`

**Interfaces:**
- Consumes: `createActionLog(...)` instance injected as `deps.actionLog` (optional — all appends are `actionLog?.…`); `deriveActed` imported from `./action-log.js`.
- Produces:
  - Every mutating endpoint appends an entry AND adds `entryId` to its JSON response (success and failure paths).
  - Mutating request bodies may carry `undoOf` (stamped onto the entry) and — for killlist — `emailIds` (recorded for derivation only, not passed to the connector).
  - `GET /actions?days=7` → `{ acted: <derived map>, entries: [...] }`.
  - `GET /health` → `{ ok, lastTickAt, pid, startedAt }` (`deps.startedAt` ISO string).

- [ ] **Step 1: Write the failing tests**

In `daemon/api.test.js`:

1. Add to imports: nothing new needed (uses fetch + existing harness).
2. In the `before()` block, after `const killlistRemoveFn = ...`, create a real action log in the temp dir and pass it plus `startedAt` into `createApiServer`:

```js
  const { createActionLog } = await import("./action-log.js");
  actionLog = createActionLog(dir);
  server = createApiServer({ store, ctxFor, getLastTickAt: () => "t", ackStore, clock: { now: () => "t" },
    accounts: [{ id: "brickell" }], fetchBodyFn, deleteFn, killlistFn, runTriageFn, onTriage, restoreFn, killlistRemoveFn,
    actionLog, startedAt: "2026-07-13T00:00:00.000Z" });
```

   and add `actionLog` to the `let server, base, dir, ...` declaration line.

3. Append a new describe block at the end of the file:

```js
describe("action audit log", () => {
  it("delete appends an entry and returns its entryId", async () => {
    const body = await (await fetch(`${base}/messages/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", emailIds: ["x1", "x2"] }) })).json();
    assert.ok(body.entryId);
    const entries = actionLog.recent();
    const e = entries.find(en => en.id === body.entryId);
    assert.equal(e.action, "delete");
    assert.deepEqual(e.emailIds, ["x1", "x2"]);
    assert.equal(e.result.trashed, 2);
  });

  it("killlist records emailIds from the body and stamps undoOf on remove", async () => {
    const add = await (await fetch(`${base}/senders/killlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", sender: "promo2@x.com", emailIds: ["k1"] }) })).json();
    assert.ok(add.entryId);
    const rm = await (await fetch(`${base}/senders/killlist/remove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", sender: "promo2@x.com", undoOf: add.entryId }) })).json();
    assert.ok(rm.entryId);
    const entries = actionLog.recent();
    assert.equal(entries.find(e => e.id === add.entryId).emailIds[0], "k1");
    assert.equal(entries.find(e => e.id === rm.entryId).undoOf, add.entryId);
  });

  it("GET /actions returns the derived acted map", async () => {
    const del = await (await fetch(`${base}/messages/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", emailIds: ["m9"] }) })).json();
    const res = await (await fetch(`${base}/actions`)).json();
    assert.equal(res.acted.m9.deleted, true);
    assert.equal(res.acted.m9.deleteEntryId, del.entryId);
    assert.ok(Array.isArray(res.entries));
  });

  it("undo (restore with undoOf) removes the row from the derived map", async () => {
    const del = await (await fetch(`${base}/messages/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", emailIds: ["u1"] }) })).json();
    await (await fetch(`${base}/messages/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "brickell", emailIds: ["u1"], undoOf: del.entryId }) })).json();
    const res = await (await fetch(`${base}/actions`)).json();
    assert.equal(res.acted.u1, undefined);
  });

  it("health includes pid and startedAt", async () => {
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(typeof h.pid, "number");
    assert.equal(h.startedAt, "2026-07-13T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --test daemon/api.test.js`
Expected: the 5 new tests FAIL (`entryId` undefined / 404 on `/actions` / missing pid); all pre-existing tests still pass.

- [ ] **Step 3: Implement in `daemon/api.js`**

1. Import at top: `import { deriveActed } from "./action-log.js";`
2. Destructure new deps in `createApiServer`: add `actionLog, startedAt` to the existing `const { store, ctxFor, ... } = deps;` line.
3. `/health` route becomes:

```js
    if (req.method === "GET" && path === "/health") {
      return send(res, 200, { ok: true, lastTickAt: getLastTickAt?.() ?? null, pid: process.pid, startedAt: startedAt ?? null });
    }
```

4. Add the `/actions` route right after `/model`:

```js
    if (req.method === "GET" && path === "/actions") {
      const days = Number(url.searchParams.get("days")) || 7;
      const entries = actionLog?.recent({ days }) ?? [];
      return send(res, 200, { acted: deriveActed(entries), entries });
    }
```

5. Rework the four mutating routes + triage to append. Replace the bodies of the existing routes with:

```js
    if (req.method === "POST" && path === "/messages/delete") {
      const body = await readJson(req);
      const account = body?.account, ids = body?.emailIds;
      if (!accounts.some(a => a.id === account) || !Array.isArray(ids) || ids.length === 0) return send(res, 400, { error: "account and non-empty emailIds required" });
      const base = { action: "delete", account, emailIds: ids, ...(body?.undoOf ? { undoOf: body.undoOf } : {}) };
      try {
        const result = await deleteFn(account, ids);
        const entry = actionLog?.append({ ...base, result });
        return send(res, 200, { ...result, entryId: entry?.id });
      } catch (err) {
        const entry = actionLog?.append({ ...base, result: { error: err.message } });
        return send(res, 200, { ok: false, error: err.message, entryId: entry?.id });
      }
    }
    if (req.method === "POST" && path === "/senders/killlist") {
      const body = await readJson(req);
      const account = body?.account, sender = body?.sender;
      if (!accounts.some(a => a.id === account) || !sender) return send(res, 400, { error: "account and sender required" });
      const base = { action: "killlist_add", account, sender, emailIds: body?.emailIds || [], ...(body?.undoOf ? { undoOf: body.undoOf } : {}) };
      try {
        const result = await killlistFn(account, sender);
        const entry = actionLog?.append({ ...base, result });
        return send(res, 200, { ...result, entryId: entry?.id });
      } catch (err) {
        const entry = actionLog?.append({ ...base, result: { error: err.message } });
        return send(res, 200, { ok: false, error: err.message, entryId: entry?.id });
      }
    }
    if (req.method === "POST" && path === "/messages/restore") {
      const body = await readJson(req);
      const account = body?.account, ids = body?.emailIds;
      if (!accounts.some(a => a.id === account) || !Array.isArray(ids) || ids.length === 0) return send(res, 400, { error: "account and non-empty emailIds required" });
      const base = { action: "restore", account, emailIds: ids, ...(body?.undoOf ? { undoOf: body.undoOf } : {}) };
      try {
        const result = await restoreFn(account, ids);
        const entry = actionLog?.append({ ...base, result });
        return send(res, 200, { ...result, entryId: entry?.id });
      } catch (err) {
        const entry = actionLog?.append({ ...base, result: { error: err.message } });
        return send(res, 200, { ok: false, error: err.message, entryId: entry?.id });
      }
    }
    if (req.method === "POST" && path === "/senders/killlist/remove") {
      const body = await readJson(req);
      const account = body?.account, sender = body?.sender;
      if (!accounts.some(a => a.id === account) || !sender) return send(res, 400, { error: "account and sender required" });
      const base = { action: "killlist_remove", account, sender, ...(body?.undoOf ? { undoOf: body.undoOf } : {}) };
      try {
        const result = await killlistRemoveFn(account, sender);
        const entry = actionLog?.append({ ...base, result });
        return send(res, 200, { ...result, entryId: entry?.id });
      } catch (err) {
        const entry = actionLog?.append({ ...base, result: { error: err.message } });
        return send(res, 200, { ok: false, error: err.message, entryId: entry?.id });
      }
    }
```

   and in the `/actions/triage` route, after `const r = await runTriageFn(...)` add `actionLog?.append({ action: "triage", account: body?.account || null, result: { ok: true, lookbackHours } });` (and in its catch, `actionLog?.append({ action: "triage", account: body?.account || null, result: { error: err.message } });`).

   Keep the existing lookbackHours clamp logic in the triage route exactly as is.

- [ ] **Step 4: Run tests**

Run: `node --test daemon/api.test.js` — all pass (old + 5 new).
Run: `npm test` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add daemon/api.js daemon/api.test.js
git commit -m "feat(api): audit-log every mutating action, GET /actions, pid+startedAt in health"
```

---

### Task 4: daemon.js — crash handlers, singleton guard, dir flags, fake connectors, log wiring

**Files:**
- Create: `daemon/fake-connectors.js`
- Modify: `daemon/wiring.js`, `daemon/wiring.test.js` (create if absent), `daemon/daemon.js`

**Interfaces:**
- Consumes: `createLogger` (Task 1), `createActionLog` (Task 2), `createApiServer` deps `actionLog`/`startedAt` (Task 3).
- Produces:
  - `makeFakeConnectors()` in `daemon/fake-connectors.js` → `{ deleteFn, restoreFn, killlistFn, killlistRemoveFn, runTriageFn, fetchBodyFn, fetchFn }` (canned; `fetchFn` throws `"fake mode"` so the scheduler's stale-retention keeps seeded items).
  - `chooseConnectors(env, real, fake)` in `daemon/wiring.js` — returns `fake` only when `env.OFFICEOS_FAKE_CONNECTORS === "1"`.
  - daemon flags: `--data-dir <path>`, `--config-dir <path>` (defaults `<root>/data`, `<root>/config`).

- [ ] **Step 1: Write the failing tests**

Create `daemon/fake-connectors.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFakeConnectors } from "./fake-connectors.js";
import { chooseConnectors } from "./wiring.js";

describe("fake connectors", () => {
  it("return canned successes and a throwing fetchFn", async () => {
    const f = makeFakeConnectors();
    assert.deepEqual(await f.deleteFn("a", ["1", "2"]), { trashed: 2, failed: 0 });
    assert.deepEqual(await f.restoreFn("a", ["1"]), { restored: 1, failed: 0 });
    assert.equal((await f.killlistFn("a", "s@x.com")).added, true);
    assert.equal((await f.killlistRemoveFn("a", "s@x.com")).removed, true);
    assert.equal((await f.runTriageFn(null, null)).ok, true);
    assert.match((await f.fetchBodyFn("a", "e1")).body, /e1/);
    await assert.rejects(() => f.fetchFn("a", "inbox", 24), /fake mode/);
  });
});

describe("chooseConnectors", () => {
  const real = { tag: "real" }, fake = { tag: "fake" };
  it("uses real connectors unless the env var is exactly '1'", () => {
    assert.equal(chooseConnectors({}, real, fake).tag, "real");
    assert.equal(chooseConnectors({ OFFICEOS_FAKE_CONNECTORS: "" }, real, fake).tag, "real");
    assert.equal(chooseConnectors({ OFFICEOS_FAKE_CONNECTORS: "true" }, real, fake).tag, "real");
    assert.equal(chooseConnectors({ OFFICEOS_FAKE_CONNECTORS: "1" }, real, fake).tag, "fake");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test daemon/fake-connectors.test.js`
Expected: FAIL — modules/functions missing.

- [ ] **Step 3: Implement**

Create `daemon/fake-connectors.js`:

```js
/**
 * fake-connectors.js — canned-success connector set for the hermetic e2e smoke.
 * ONLY wired when OFFICEOS_FAKE_CONNECTORS === "1" (see wiring.chooseConnectors);
 * never the default. fetchFn throws so the scheduler's stale-retention path keeps
 * the seeded world model intact (accounts flip stale; items persist).
 */
export function makeFakeConnectors() {
  return {
    deleteFn: async (account, ids) => ({ trashed: ids.length, failed: 0 }),
    restoreFn: async (account, ids) => ({ restored: ids.length, failed: 0 }),
    killlistFn: async (account, sender) => ({ added: true, value: sender }),
    killlistRemoveFn: async (account, sender) => ({ removed: true }),
    runTriageFn: async () => ({ ok: true }),
    fetchBodyFn: async (account, emailId) => ({ id: emailId, body: `demo body for ${emailId}` }),
    fetchFn: async () => { throw new Error("fake mode: no live fetch"); },
  };
}
```

Append to `daemon/wiring.js`:

```js
/** Fake connectors are opt-in ONLY via env — never default (e2e uses them). */
export function chooseConnectors(env, real, fake) {
  return env.OFFICEOS_FAKE_CONNECTORS === "1" ? fake : real;
}
```

Modify `daemon/daemon.js`:

1. Add imports: `import { createLogger } from "./log.js";`, `import { createActionLog } from "./action-log.js";`, `import { makeFakeConnectors } from "./fake-connectors.js";`, and extend the wiring import to `import { buildCtxFor, resolvePollMs, chooseConnectors } from "./wiring.js";`
2. `loadConfig` takes a dir: `function loadConfig(configDir) { const companies = JSON.parse(readFileSync(join(configDir, "companies.json"), "utf-8")); const accountTypes = JSON.parse(readFileSync(join(configDir, "account-types.json"), "utf-8")); return { companies, accountTypes }; }`
3. The connector factories that call `loadConfig()` internally (`fetchSubprocess`, `makeDeleteFn`, `makeRestoreFn`) take `companies` as their first parameter instead (thread it from `main`): e.g. `async function fetchSubprocess(companies, accountId, folder, hours) { const account = companies.companies.find(...); ... }`, `function makeDeleteFn(companies) { return async (accountId, ids) => { const account = companies.companies.find(...); ... }; }` — same for restore. `getPendingDeletions(dataDir)` similarly takes the data dir.
4. In `main()`:

```js
  const args = process.argv.slice(2);
  const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : DEFAULT_PORT;
  const once = args.includes("--once");
  const dataDir = args.includes("--data-dir") ? args[args.indexOf("--data-dir") + 1] : join(root, "data");
  const configDir = args.includes("--config-dir") ? args[args.indexOf("--config-dir") + 1] : join(root, "config");

  const logger = createLogger(dataDir);
  const startedAt = new Date().toISOString();
  process.on("uncaughtException", (err) => { logger.log("error", "fatal", { stack: String(err.stack || err) }); process.exit(1); });
  process.on("unhandledRejection", (err) => { logger.log("error", "fatal", { stack: String(err?.stack || err) }); process.exit(1); });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { logger.log("info", "shutdown", { signal: sig }); process.exit(0); });

  const { companies, accountTypes } = loadConfig(configDir);
  const store = createStore(dataDir);
  const ackStore = createAckStore(dataDir);
  const actionLog = createActionLog(dataDir);
```

5. Build the connector set once and choose real vs fake:

```js
  const real = {
    deleteFn: makeDeleteFn(companies), restoreFn: makeRestoreFn(companies),
    killlistFn, killlistRemoveFn, runTriageFn, fetchBodyFn: fetchBody,
    fetchFn: (accountId, folder, hours) => fetchSubprocess(companies, accountId, folder, hours),
  };
  const conn = chooseConnectors(process.env, real, makeFakeConnectors());
```

   Use `conn.fetchFn` in `deps`, and pass `conn.*` plus `actionLog` and `startedAt` into `createApiServer` (replacing the current individually-named args).
6. Listen path with singleton guard, and route startup/tick logging through the logger:

```js
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") { logger.log("info", "already-running", { port }); process.exit(0); }
    logger.log("error", "fatal", { stack: String(err.stack || err) }); process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    logger.log("info", "daemon-started", { pid: process.pid, port });
  });

  async function tick() {
    const t0 = Date.now();
    try {
      const summary = await runTick(deps((e) => {
        server.broadcastUpdate(e);
        if (e?.notify && process.env.OFFICEOS_FAKE_CONNECTORS !== "1") notify(e.notify);
      }));
      lastTickAt = new Date().toISOString();
      logger.log("info", "tick-end", { ms: Date.now() - t0, items: summary.itemCount, changed: summary.changed, warnings: summary.warnings });
    } catch (err) {
      logger.log("error", "tick-error", { stack: String(err.stack || err) });
    }
  }
```

   (Note `runTick` already returns `{ changed, warnings, itemCount, notify }` — capture it as `summary`. Toasts are suppressed in fake mode so e2e runs don't pop desktop notifications.)

- [ ] **Step 4: Run tests + manual boot check**

Run: `node --test daemon/fake-connectors.test.js` — passing.
Run: `npm test` — full suite green.
Manual boot from the worktree (config lives only in the main checkout, so expect a clean fatal, which itself proves the handler works): `node daemon/daemon.js --port 8991 --data-dir <temp> --config-dir <nonexistent>` → exits with a `fatal` line in `<temp>/daemon.log`.

- [ ] **Step 5: Commit**

```bash
git add daemon/fake-connectors.js daemon/fake-connectors.test.js daemon/wiring.js daemon/daemon.js
git commit -m "feat(daemon): crash handlers, singleton guard, dir flags, opt-in fake connectors, log wiring"
```

---

### Task 5: Panel — hydrate acted state from `/actions`, send `undoOf` + killlist `emailIds`

**Files:**
- Modify: `daemon/web/app.js`
- Test: `daemon/web/contract.test.js`

**Interfaces:**
- Consumes: `GET /actions` → `{ acted }` (Task 3); acted values may carry `deleteEntryId` / `killEntryId`.
- Produces: mutating POSTs include `undoOf` when undoing; killlist POSTs include `emailIds`; `markActed` patches include entry ids from responses.

- [ ] **Step 1: Write the failing contract test**

In `daemon/web/contract.test.js`, add to the existing describe:

```js
  it("app hydrates acted state from /actions and links undos via undoOf", () => {
    assert.match(app, /fetch\("\/actions"\)/, "app must fetch /actions");
    assert.match(app, /undoOf/, "app must send undoOf when undoing");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test daemon/web/contract.test.js`
Expected: new test FAILS.

- [ ] **Step 3: Implement in `daemon/web/app.js`**

1. `load()` hydrates acted state (server wins — every completed client action is already in the log; in-flight ones aren't in `ui.acted` yet):

```js
async function load() {
  const model = await (await fetch("/model")).json();
  lastModel = model;
  try {
    const a = await (await fetch("/actions")).json();
    ui.acted = { ...ui.acted, ...(a.acted || {}) };
  } catch { /* daemon without action log — panel still works */ }
  draw();
}
```

2. The `[data-undo-acted]` handler sends `undoOf` (existing lines shown with the additions):

```js
        if (a.deleted) { const r = await postJson("/messages/restore", { account: a.account, emailIds: a.emailIds, ...(a.deleteEntryId ? { undoOf: a.deleteEntryId } : {}) }); if (r.ok === false) throw new Error(r.error); }
        if (a.killed) { const r = await postJson("/senders/killlist/remove", { account: a.account, sender: a.sender, ...(a.killEntryId ? { undoOf: a.killEntryId } : {}) }); if (r.ok === false) throw new Error(r.error); }
```

3. The delete handler records the entry id in its `markActed` patch (change the success branch):

```js
    return void confirmThen(token, async () => { ui.undo = null; ui.notice = null; const r = await postJson("/messages/delete", { account, emailIds: ids }); if (r.ok !== false) markActed(token, key, ids, { deleted: true, account, emailIds: ids, deleteEntryId: r.entryId }); ui.notice = r.ok === false ? `Delete failed: ${r.error}` : `Moved ${r.trashed} to Trash`; await load(); });
```

4. The killlist handler sends `emailIds` and records `killEntryId`:

```js
    return void confirmThen(token, async () => { ui.undo = null; ui.notice = null; const r = await postJson("/senders/killlist", { account, sender, emailIds: ids }); if (r.added) markActed(token, key, ids, { killed: true, account, sender, killEntryId: r.entryId }); ui.notice = r.added ? `Kill-listed ${sender}` : `Not kill-listed: ${r.reason || r.error}`; await load(); });
```

5. The delete-and-kill handler does both:

```js
      const dr = await postJson("/messages/delete", { account, emailIds: ids });
      const kr = await postJson("/senders/killlist", { account, sender, emailIds: ids });
      const deleted = dr.ok !== false, killed = !!kr.added;
      if (deleted || killed) markActed(token, key, ids, { deleted, killed, account, emailIds: ids, sender, deleteEntryId: dr.entryId, killEntryId: kr.entryId });
```

- [ ] **Step 4: Run tests**

Run: `node --test daemon/web/contract.test.js` then `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add daemon/web/app.js daemon/web/contract.test.js
git commit -m "feat(panel): persistent acted state hydrated from the action log; undo links via undoOf"
```

---

### Task 6: Playwright smoke — `npm run test:e2e`

**Files:**
- Create: `playwright.config.js`, `e2e/panel.smoke.spec.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: daemon flags + fake connectors (Task 4); `/actions`-hydrated acted state (Tasks 3+5); `store.js` file formats.
- Produces: `npm run test:e2e`.

- [ ] **Step 1: Install Playwright (devDependency) + browser**

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

Add to `package.json` scripts: `"test:e2e": "playwright test"`.

- [ ] **Step 2: Config**

Create `playwright.config.js`:

```js
export default {
  testDir: "./e2e",
  timeout: 60000,
  fullyParallel: false,
  use: { headless: true },
};
```

- [ ] **Step 3: Write the smoke**

Create `e2e/panel.smoke.spec.js`. The fixture writes its own world model (12 members, so the detail pane genuinely scrolls) rather than reusing seed-demo's 2-member demo — same hermetic intent, meaningful scroll assertions:

```js
import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8993;
const BASE = `http://127.0.0.1:${PORT}`;

let daemon, dir;

function seed(dataDir) {
  const now = new Date().toISOString();
  const members = Array.from({ length: 12 }, (_, i) => ({
    subject: `[TEST] message ${i}`, from: "noise@example.com", fromName: "Noise Co",
    emailId: `e${i}`, receivedAt: now,
  }));
  writeFileSync(join(dataDir, "world-model.json"), JSON.stringify({
    generatedAt: now,
    accounts: { brickell: { status: "ok", lastTickAt: now, label: "Brickell", accountType: "business" } },
    items: [{
      id: "brickell:handled", jobType: "handled", account: "brickell",
      title: "12 need a reply or decision", subtitle: "", status: "ok",
      display: { accountLabel: "Brickell" },
      group: { rootCause: "handled", members, counts: { needsYou: 12, waiting: 0 }, moreCount: 0 },
      source: [], proposedActions: [], lastChanged: now,
    }],
  }, null, 2), "utf-8");
  writeFileSync(join(dataDir, "proposal-queue.json"), JSON.stringify({ proposals: [] }), "utf-8");
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "officeos-e2e-"));
  const dataDir = join(dir, "data"), configDir = join(dir, "config");
  mkdirSync(dataDir, { recursive: true }); mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "companies.json"), JSON.stringify({ companies: [
    { id: "brickell", name: "Brickell", accountType: "business", provider: "outlook", pollMinutes: 999 },
  ] }), "utf-8");
  writeFileSync(join(configDir, "account-types.json"), JSON.stringify({
    business: { jobTypes: { handled: {} } },
  }), "utf-8");
  seed(dataDir);
  daemon = spawn("node", [join(root, "daemon", "daemon.js"), "--port", String(PORT), "--data-dir", dataDir, "--config-dir", configDir],
    { env: { ...process.env, OFFICEOS_FAKE_CONNECTORS: "1" }, windowsHide: true });
  // wait for /health
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("daemon did not come up");
});

test.afterAll(() => {
  daemon?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("delete → working → acted → undo → survives reload", async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator(".sechdr .seclabel")).toContainText("Brickell");

  // open details, scroll the pane, arm a per-cluster delete
  await page.locator("button.detail").first().click();
  const pane = page.locator("aside.detail");
  await expect(pane).toBeVisible();
  await pane.evaluate(el => { el.scrollTop = 300; });
  await page.locator("aside.detail .del").first().click();          // arm
  await expect(page.locator("aside.detail .del.armed").first()).toContainText("Confirm");
  const scrollAfterArm = await pane.evaluate(el => el.scrollTop);
  expect(scrollAfterArm).toBeGreaterThan(200);                       // scroll preserved

  // confirm → Working… → acted rows with Undo
  await page.locator("aside.detail .del.armed").first().click();
  await expect(page.locator("aside.detail .msg.acted").first()).toBeVisible();
  await expect(page.locator('[data-undo-acted]').first()).toBeVisible();

  // reload — acted state must survive (served from the action log)
  await page.reload();
  await page.locator("button.detail").first().click();
  await expect(page.locator("aside.detail .msg.acted").first()).toBeVisible();

  // undo the first acted row — its dim clears
  const actedBefore = await page.locator("aside.detail .msg.acted").count();
  await page.locator('[data-undo-acted]').first().click();
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(actedBefore - 1);

  // and the undo also survives a reload
  await page.reload();
  await page.locator("button.detail").first().click();
  await expect(page.locator("aside.detail .msg.acted")).toHaveCount(actedBefore - 1);
});
```

- [ ] **Step 4: Run it**

Run: `npm run test:e2e`
Expected: 1 passing. If the arm-click assertion flakes because "Working…" resolves instantly (fake connectors are fast), the acted-state assertions are the real gate — they must pass.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.js e2e/panel.smoke.spec.js package.json package-lock.json
git commit -m "test(e2e): hermetic Playwright smoke — delete/confirm/undo/reload against seeded daemon"
```

---

### Task 7: Scheduled Task installer + README

**Files:**
- Create: `scripts/install-daemon-task.ps1`
- Modify: `daemon/README.md`

**Interfaces:**
- Consumes: `daemon/daemon.js` singleton guard (Task 4) — restart loops can't double-start.
- Produces: Scheduled Task **"OfficeOS Daemon"**; operator-run only.

- [ ] **Step 1: Write the installer**

Create `scripts/install-daemon-task.ps1`:

```powershell
<#
install-daemon-task.ps1 — register (or remove) the "OfficeOS Daemon" Scheduled Task.
Run from any location; the repo root is derived from this script's path.

  pwsh scripts/install-daemon-task.ps1            # install/replace the task
  pwsh scripts/install-daemon-task.ps1 -Start     # install and start now
  pwsh scripts/install-daemon-task.ps1 -Uninstall # remove the task

The task runs `node daemon\daemon.js` at your logon, in your user session
(OneDrive paths, Graph token caches, and toasts all work), and restarts it
every minute on failure. The daemon's EADDRINUSE singleton guard makes
restart loops safe (a second instance exits 0 immediately).
#>
param([switch]$Uninstall, [switch]$Start)

$TaskName = "OfficeOS Daemon"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
  Write-Output "Removed scheduled task '$TaskName'."
  exit 0
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = (Get-Command node -ErrorAction Stop).Source

$action   = New-ScheduledTaskAction -Execute $node -Argument "daemon\daemon.js" -WorkingDirectory $repo
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "Registered scheduled task '$TaskName' (at logon, restart every 1 min on failure)."
Write-Output "Working directory: $repo"

if ($Start) { Start-ScheduledTask -TaskName $TaskName; Write-Output "Started." }
```

- [ ] **Step 2: Manual verification commands (operator-run — creating a standing task is the operator's action)**

Document in the PR/report; do NOT run automatically:

```powershell
pwsh scripts/install-daemon-task.ps1 -Start
schtasks /query /tn "OfficeOS Daemon" /v /fo LIST   # confirm trigger + restart policy
Invoke-RestMethod http://localhost:8138/health       # daemon up (pid, startedAt present)
Get-Content data\daemon.log -Tail 5                  # daemon-started + tick-end events
```

- [ ] **Step 3: Update `daemon/README.md`**

Add these sections (after "## Run"):

```markdown
## Always-on (Scheduled Task)

`pwsh scripts/install-daemon-task.ps1 -Start` registers the "OfficeOS Daemon"
task: starts at your logon, restarts every minute on failure, never expires.
`-Uninstall` removes it. A second instance exits immediately (port guard), so
restart loops are safe. Flags: `--data-dir` / `--config-dir` override the
default `data/` + `config/` (used by e2e).

## Logs

- `data/daemon.log` — operational JSONL: daemon-started, tick-end {ms, items,
  changed, warnings}, tick-error, fatal, shutdown, already-running. Rotates to
  `.1` at startup past 5 MB.
- `data/actions.jsonl` — append-only audit of every mutating action (delete /
  restore / killlist add+remove / triage) with results. Undo appends a reversing
  entry (undoOf) — nothing is rewritten. `GET /actions` serves the derived
  acted map; the panel's dim/strike + Undo state survives reloads and restarts.

## E2E smoke

`npm run test:e2e` (Playwright, devDependency) boots a hermetic daemon —
temp data/config dirs, `OFFICEOS_FAKE_CONNECTORS=1` (canned connector results;
never the default) — and walks delete → confirm → acted → undo → reload.
```

- [ ] **Step 4: Full suite + commit**

Run: `npm test` — green.

```bash
git add scripts/install-daemon-task.ps1 daemon/README.md
git commit -m "feat(ops): Scheduled Task installer for always-on daemon + README for logs/e2e"
```

---

## Self-review notes (already applied)

- Spec coverage: Component 1 → Tasks 4+7; Component 2 → Tasks 1+4; Component 3 → Tasks 2+3+5; Component 4 → Tasks 4+6. Health `pid/startedAt` → Task 3. Toast suppression in fake mode → Task 4.
- Deviation from spec, intentional: the e2e fixture writes its own 12-member world model instead of calling seed-demo (seed-demo's 2-member model can't produce a scrollable detail pane, making the scroll-preservation assertion vacuous). seed-demo already accepts a dataDir argument, so the spec's "seed-demo accepts a target dir" item needs no work.
- Type consistency: `deriveActed` value shape `{deleted?, killed?, account, emailIds, sender?, deleteEntryId?, killEntryId?}` matches what app.js `markActed` patches produce (Task 5) and what render.js already consumes (`actedBadge` reads `deleted`/`killed`; undo reads `emailIds`/`sender`).
- The operator step (registering the task) is explicitly manual — consistent with the session rule that standing system changes are the operator's action.
