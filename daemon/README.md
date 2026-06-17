# OfficeOS daemon (Ambient Proposal Panel — core)

Always-on local service that turns the email pipeline into a live world model +
staged proposal queue, served over `localhost`. Headless in this milestone
(REST/SSE only; the web panel and toasts come in later plans).

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

## Config

- `config/account-types.json` → `<type>.jobTypes.owed_risk` (detection signals, grouping order, threshold)
- `config/companies.json` → per account: `links.billing_portal`, optional `pollMinutes`

## Safety rails (enforced by `daemon/executors/rails-guard.test.js`)

Executors never send mail and never permanently delete. Drafts only; soft-delete only.
The guard test fails the build if any executor references a send or permanent-delete API.

## Test

```bash
npm test
```
