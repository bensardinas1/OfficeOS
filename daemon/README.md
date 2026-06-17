# OfficeOS daemon (Ambient Proposal Panel — core)

Always-on local service that turns the email pipeline into a live world model +
staged proposal queue, served over `localhost`. Surfaces the `owed_risk`,
`handled`, `gateway`, and `audit` jobs today (more are config + a normalizer away). Includes a glanceable
web panel (grouped "needs you" list, approve/dismiss, drill-in workbench) and
daemon-fired Windows toasts on threshold-crossing changes.

## Run

```bash
node daemon/daemon.js            # start server on http://localhost:8138 + schedule ticks
node daemon/daemon.js --port 9000
node daemon/daemon.js --once     # run one tick, print summary, exit
```

## API (binds 127.0.0.1 only)

- `GET  /health` — `{ ok, lastTickAt }`
- `GET  /model` — world model + proposals
- `GET  /events` — SSE; emits `{type:"update"}` when a tick changes the model
- `POST /proposals/:id/approve` — approve + execute (route → URL, draft_chase → drafts)
- `POST /proposals/:id/dismiss` — dismiss

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
