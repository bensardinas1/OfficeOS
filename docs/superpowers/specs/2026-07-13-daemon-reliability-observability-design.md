# Daemon Reliability + Observability (Cluster A) — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorm complete)
**Context:** The Ambient Proposal Panel's daemon has no supervision and no process-level
error handlers. It is launched ad hoc, dies with logouts/reboots/session cleanup, and
leaves empty logs. Mutating actions (delete/kill/restore/triage) leave no server-side
record: acted/undo state lives only in browser memory, so a reload strands it, and
"did the delete execute?" can only be answered by querying the provider directly.
This cluster makes the daemon stay alive and tell the truth.

**Decisions locked during brainstorm:**
- Supervision = Windows Scheduled Task at logon (user context), not a service, not a watchdog.
- Acted state persists until the item vanishes naturally from ticks (no timers), derived
  from the action log, surviving reloads and restarts.
- Playwright smoke runs as a separate `npm run test:e2e` — the unit suite stays
  dependency-free and fast.

---

## Component 1 — Lifecycle: Scheduled Task + crash handling

### `scripts/install-daemon-task.ps1` (new)
One-time installer the operator runs (creating a standing system task is the operator's
action; the script is merely checked in):

- Registers Scheduled Task **"OfficeOS Daemon"**:
  - Trigger: at logon of the current user.
  - Action: `node daemon\daemon.js`, working directory = the main checkout root
    (derived from the script's own location: `$PSScriptRoot\..`).
  - Run in the user's session (interactive token) so OneDrive paths, Graph token
    caches (`data/.token-cache-*.json`), and Windows toasts work.
  - Restart on failure: every 1 minute, effectively unlimited
    (`RestartCount` set to 999).
  - `StartWhenAvailable = $true`; battery throttling disabled
    (`-DontStopIfGoingOnBatteries -AllowStartIfOnBatteries`); no idle stop;
    `ExecutionTimeLimit = 0` (never kill a long-running instance).
- `-Uninstall` switch removes the task.
- `-Start` switch (optional convenience) starts the task immediately after install.
- Idempotent: re-running replaces the existing task definition.

### `daemon/daemon.js` hardening
- `process.on("uncaughtException", handler)` and `process.on("unhandledRejection", handler)`:
  log a `fatal` event with the stack (Component 2), then `process.exit(1)` — the
  Scheduled Task restarts it.
- `SIGINT` / `SIGTERM`: log a `shutdown {signal}` event, then exit 0.
- **Singleton guard:** if `server.listen` fails with `EADDRINUSE`, log
  `already-running {port}` and exit **0** (not 1), so the task's restart loop cannot
  spawn duplicates or thrash.

---

## Component 2 — Operational log: `data/daemon.log`

### `daemon/log.js` (new, dependency-free)
- `createLogger(dataDir)` → `{ log(level, event, fields) }`.
- Appends one JSON line per event: `{ at: ISO, level: "info"|"error", event, ...fields }`.
- Also echoes to stdout/stderr (so redirected launch logs still work).
- **Rotation at startup:** if `daemon.log` exceeds 5 MB, rename to `daemon.log.1`
  (replacing any prior `.1`). No rotation mid-run — the daemon restarts often enough
  and events are small.
- Append failures are swallowed (logging must never crash the daemon).

### Events written
| Event | Fields | When |
|---|---|---|
| `daemon-started` | `pid, port` | after listen succeeds |
| `tick-end` | `ms, items, changed, warnings` | after each tick |
| `tick-error` | `stack` | tick threw |
| `fatal` | `stack` | uncaughtException / unhandledRejection |
| `shutdown` | `signal` | SIGINT/SIGTERM |
| `already-running` | `port` | EADDRINUSE at startup |

Existing bare `process.stdout/stderr.write` calls in daemon.js route through the logger.
`GET /health` additionally returns `pid` and `startedAt` (uptime derivable).

---

## Component 3 — Action audit log + persistent acted/Undo: `data/actions.jsonl`

### `daemon/action-log.js` (new)
- `createActionLog(dataDir)` → `{ append(entry), recent({days}) }`.
- Append-only JSONL. Entry shape:
  ```json
  { "id": "<timestamp>-<rand>", "at": "ISO", "action": "delete|restore|killlist_add|killlist_remove|triage",
    "account": "brickellpay", "emailIds": ["..."], "sender": "x@y.com",
    "result": { "trashed": 3, "failed": 0 }, "undoOf": "<entry id or absent>" }
  ```
- **Undo is append-only:** undoing appends the reverse action (`restore` with
  `undoOf: <delete entry id>`, `killlist_remove` with `undoOf: <killlist_add id>`).
  No file rewrites — OneDrive-safe, and the log doubles as a full audit trail.
- `deriveActed(entries)` (pure, exported): folds entries newest-last into the acted map
  the panel already understands — keyed by emailId (`{deleted, account, emailIds}`)
  and/or sender (`{killed, account, sender}`); an entry is active unless a later entry
  references it via `undoOf`. Only entries from the last 7 days are considered (bounds
  the panel payload; the file itself is kept forever — it's small).
- Corrupt lines are skipped, never thrown (same degrade-to-empty philosophy as store.js).

### API integration (`daemon/api.js`)
- Each mutating endpoint appends after the connector call resolves, recording the actual
  result (including failures — a failed delete is logged with its error, but failed
  actions do NOT contribute to the acted map).
- Endpoints append: `POST /messages/delete`, `/messages/restore`,
  `/senders/killlist`, `/senders/killlist/remove`, `/actions/triage`.
- Undo endpoints accept an optional `undoOf` field in the body and stamp it into the entry.
- **New:** `GET /actions?days=7` → `{ acted: <derived map>, entries: [recent entries] }`.

### Panel integration (`daemon/web/app.js`)
- On load and after each SSE-triggered reload, fetch `/actions` and merge the server's
  `acted` map into `ui.acted` (server entries win; in-flight client entries kept).
- Undo buttons send `undoOf: <entry id>` when the acted record came from the server, so
  the reversal is linked in the log.
- Everything else (dim/strike render, badges, per-row Undo) is unchanged — acted state
  simply stops being memory-only.

---

## Component 4 — Playwright smoke: `npm run test:e2e`

### Hermetic daemon seams (small additions)
- `daemon/daemon.js` gains `--data-dir <path>` and `--config-dir <path>` flags
  (default: current `<root>/data`, `<root>/config`).
- `daemon/seed-demo.js` accepts a target data dir argument.
- **Fake-connector mode:** when env `OFFICEOS_FAKE_CONNECTORS=1` is set, daemon.js wires
  canned-success `deleteFn/restoreFn/killlistFn/killlistRemoveFn/runTriageFn/fetchBodyFn`
  instead of shelling real connectors. Never the default; a unit test asserts real
  connectors are wired when the env var is absent.

### The smoke (`e2e/panel.smoke.spec.js`, Playwright as devDependency)
1. Create temp data+config dirs; write a minimal fake `companies.json`/`account-types.json`;
   seed the world model via seed-demo.
2. Launch `node daemon/daemon.js --port <scratch> --data-dir <tmp> --config-dir <tmp>`
   with `OFFICEOS_FAKE_CONNECTORS=1`; wait for `/health`.
3. Assert: account sections render; open a Details pane; scroll it down; arm a Delete
   (label flips to "Confirm delete?", **scroll position preserved**); confirm
   ("Working…" appears, then acted badge + Undo); Undo clears the acted state;
   **reload the page** → acted/undone state still correct (served from the action log).
4. Kill the daemon; temp dirs removed.
- `package.json`: `"test:e2e": "playwright test e2e/"`; run before merging panel-touching
  changes. `npm test` is untouched.

---

## Testing strategy
- `daemon/log.test.js` — appender shape, rotation, never-throws.
- `daemon/action-log.test.js` — append/read round-trip, `deriveActed` (delete → acted;
  undo neutralizes; failed results excluded; 7-day window; corrupt-line skip).
- `daemon/api.test.js` — mutating endpoints append entries; `GET /actions` returns the
  derived map; `undoOf` stamped.
- `daemon/daemon` wiring — fake-connector mode only when env set.
- Contract test — app.js fetches `/actions`.
- Installer script: manual verification (operator runs it; `schtasks /query` confirms).

## Safety rails (unchanged, restated)
- Both logs are local files; no new mail-touching code paths; soft-delete/config-only
  semantics of existing connectors untouched; no auto-send anywhere.
- Fake connectors are opt-in via env var only and never ship enabled.

## Out of scope (later clusters)
- Intent-level bulk actions (delete-by-sender), fetch unification, in-process connectors
  (Cluster B); multi-select bulk action bar (Cluster B, item 9); handled-count tuning and
  config validator (Cluster C).
