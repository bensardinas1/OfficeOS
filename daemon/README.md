# OfficeOS daemon (Ambient Proposal Panel — core)

Always-on local service that turns the email pipeline into a live world model +
staged proposal queue, served over `localhost`. Surfaces the `owed_risk`,
`handled`, `gateway`, `audit`, and `exposed` jobs today (more are config + a normalizer away). Includes a glanceable
web panel (grouped "needs you" list, approve/dismiss, drill-in workbench) and
daemon-fired Windows toasts on threshold-crossing changes.

## Run

```bash
node daemon/daemon.js            # start server on http://localhost:8138 + schedule ticks
node daemon/daemon.js --port 9000
node daemon/daemon.js --once     # run one tick, print summary, exit
```

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

## Mail connector library

`scripts/mail.js` is the single library for all mail operations: fetch, delete,
restore, fetch-body, and delete-by-sender. Every mail-touching path (CLI scripts,
triage, morning-brief, the daemon) goes through it so pagination, provider dispatch
(Outlook/Gmail), the unified email shape, and safety rails live in exactly one place.

**Soft-delete only.** Outlook moves to `deleteditems`; Gmail trashes. Never permanent
delete, never send. Client cache is per-account with Gmail account verification built
in (a stale token for the wrong mailbox fails before any operation can proceed).

CLI scripts (`fetch-emails.js`, `delete-emails.js`, `restore-emails.js`, etc.) are
thin shims that invoke mail.js functions. The daemon calls mail.js in-process via
`deleteFn`, `restoreFn`, `fetchBodyFn`, and `deleteBySenderFn`.

**Delete-by-sender guards** (applied before any API call):
- Strict email shape validation (rejects operator characters)
- Protected senders + correspondents are refused
- Inbox only; 30-day default window (sinceHours), clamped to [1h, 1y]
- Match cap: 1000 emails per invocation
- Audit entries carry `bySender` + the actual `emailIds` array so Undo works

## API (binds 127.0.0.1 only)

- `GET  /health` — `{ ok, lastTickAt, pid, startedAt }`
- `GET  /model` — world model + proposals
- `GET  /actions?days=7` — audit entries + derived acted map
- `GET  /events` — SSE; emits `{type:"update"}` when a tick changes the model
- `GET  /messages/:id/body?account=<id>` — fetch message body
- `POST /proposals/:id/approve` — approve + execute (route → URL, draft_chase → drafts)
- `POST /proposals/:id/dismiss` — dismiss
- `POST /messages/delete` — soft-delete messages by ID
- `POST /messages/restore` — restore messages from trash
- `POST /senders/killlist` — add sender to kill-list (auto-delete future + optionally retroactive)
- `POST /senders/killlist/remove` — remove sender from kill-list
- `POST /senders/delete-all` — soft-delete all messages from a sender (bounded by sinceHours)

## Panel

Open `http://localhost:8138/` (served by the daemon). It live-updates via SSE,
shows what needs you grouped by account, and lets you approve/dismiss proposals
or multi-select for a bulk approve. Pin it as a standalone window for an ambient
glance. Toasts fire automatically when new at-risk items appear or an account
goes stale.

Dev preview without live email:

```bash
node daemon/seed-demo.js   # seed a demo world model into ./data
node daemon/daemon.js      # then open http://localhost:8138/
```

## Config

- `config/account-types.json` → `<type>.jobTypes`: `owed_risk` (detection signals,
  grouping order, threshold), `handled` (`{}` — derives from triage categories), and
  `gateway.recognizers.nmi` (subject pattern, ticket URL template, issue keywords, resolved markers).
- `config/account-types.json` → `<type>.jobTypes.audit.recognizers.secureframe` (sender domains,
  Secureframe base URL, action/comment/resolved markers).
- `config/account-types.json` → `<type>.jobTypes.exposed.recognizers` (defenderCloud, defenderEndpoint,
  pciTamper, entra — sender domains/hints, subject markers, portal URLs) + `atRiskSeverities`.
- `config/companies.json` → per account: `links.billing_portal`, optional `pollMinutes`.

## Gateway (processing incidents)

The `gateway` job surfaces processing incidents affecting your merchants. v1 recognizes NMI
support tickets (subject `[NMI Ticket <#>]`), groups the whole thread into one item per ticket,
marks it resolved (ok) once a closure message appears, and links out to the NMI ticket. Adding
another processor is a new recognizer under `jobTypes.gateway.recognizers`.

## Audit (compliance fieldwork)

The `audit` job surfaces Secureframe auditor requests during fieldwork: "Action required" and
"new comment / upload" events, one item per test, linking out to Secureframe. It's self-windowing —
Secureframe only emails during the ~3-month fieldwork window, so outside it nothing surfaces.

## Exposed (security findings)

The `exposed` job surfaces security findings from four sources — Defender for Cloud attack paths,
Defender for Endpoint CVEs, BrickellPay PCI tamper alerts, and Entra ID Protection digests — deduped
by stable ID (attack-path ID, CVE, PCI type+URL, digest counts), severity-ranked, and acknowledgeable.
Clean Entra digests (0 risky users/sign-ins) are suppressed. Findings link out to the system of record
(Azure portal / PCI dashboard) — exact resource names live there and are never reconstructed. Adding a
fifth security source is a new recognizer under `jobTypes.exposed.recognizers`.

## Acknowledge

Findings/tickets (gateway, audit, and exposed) show an **Acknowledge** button. Acknowledging records
the item's fingerprint locally (`data/acknowledged.json`) and drops it from "needs you" — until the
finding materially changes (severity, status, title), at which point its fingerprint changes and it
re-alerts. Acknowledge is local state only: no mail, no external calls.

## Grouping reasoner (optional)

`owed_risk` groups deterministically (card token, then vendor domain). Emails the
rules can't group are passed to the `claude` CLI to propose a grouping; the split
is only applied when the model returns ≥2 confident keys. If `claude` isn't
installed (or hangs past 30s), grouping silently stays deterministic.

## Safety rails (enforced by `daemon/executors/rails-guard.test.js`)

Executors never send mail and never permanently delete. Drafts only; soft-delete only.
The guard test fails the build if any executor references a send or permanent-delete API.

## Test

```bash
npm test
```
