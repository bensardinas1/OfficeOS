# OfficeOS — Ambient Proposal Panel (design)

> Date: 2026-06-16
> Status: approved design, pre-implementation
> Supersedes the open question in `docs/interface-brainstorm-context.md` ("what is the right way to
> perceive and act on the operational reality this system models?").

## 1. Summary

OfficeOS has a mature data + logic substrate (fetch → classify → confidence-tier → reasoner →
soft-delete, plus a guarded kill-list and a correspondent-protection learning loop) but no good
*consuming surface*. Every failure this arc was the interface paradigm, not the data: chat is a poor
display/decision surface, reports are walls of text, and bulk realities can't be worked by typing.

This design adds an **Ambient Proposal Panel**: a single always-on **local daemon** turns the existing
pipeline into a continuously-maintained **world model** plus a queue of **staged proposals**, served
over `localhost` to a glanceable panel. The few things that matter **come to you** (badge + native OS
toast on a real change), each rendered as a **proposal you approve/dismiss/edit in one gesture**, with a
**drill-in workbench** for browsing and bulk select-and-act on demand. Claude Code remains the
authoring/control plane; it controls the daemon but does not host the UI.

This is the hybrid of two explored directions — **A (ambient menubar/glance)** + **B (agent proposal
inbox)** — with **C (live workbench)** folded in as drill-in. It deliberately rejects **D (mobile/watch)**
for v1 because that would push PCI/financial/personal data off-box; D remains a clean later addition fed
by the same daemon.

## 2. Goals & non-goals

**Goals**
- Bring the few things that matter to the user; do not require them to go read a report.
- Act in one gesture; depth on demand. Glanceable in, one-gesture out.
- Keep sensitive data on-box (daemon binds `127.0.0.1`).
- Design for a *class* of jobs, not four screens — adding a job = a normalizer rule + executors.
- Preserve the rails as build invariants: **never auto-send, soft-delete only**.
- Make "start soft, go harder later" cheap via a thin executor seam.

**Non-goals (v1)**
- Mobile / watch surface (Direction D).
- Native tray / Electron / Tauri packaging.
- Real API execution into external systems (bank, Azure, GRC) — these are link-outs in v1.
- Multi-user, any cloud, any data egress.

## 3. The jobs (a class, not a list)

The four standing jobs share one shape — many records, deduped/grouped, continuously changing, each
needing **status + drill-in + one light action**:

1. **"Is my world handled?"** — per account: clean / left / waiting on me.
2. **"What do I owe / what's at risk?"** — vendors with past-due/failed payments, grouped, with root
   cause (e.g. one expired card → many failures). Action: pay / chase / dismiss.
3. **"Where do my audits/compliance stand?"** — open action-items, evidence owed, what the auditor
   closed, by control. Action: assign / upload / respond.
4. **"What's exposed?"** — security findings (e.g. Defender attack paths), deduped to real findings with
   risk + affected resource. Action: route / acknowledge / link to source.

The design targets this class. A fifth job is a normalizer rule + executor(s) + config, never a new screen.

## 4. Architecture

```
[ Layer 1 connectors: scripts/ (unchanged) ]
        │  raw JSON per account
        ▼
┌──────────────────────────────── OfficeOS daemon (NEW, long-running, binds 127.0.0.1) ───────┐
│  scheduler  → normalizer → proposals → executors/* → store → api (REST + SSE push)           │
│  (rails enforced inside executors: no send · soft-delete only)                               │
└───────────────┬───────────────────────────────────────────────┬─────────────────────────────┘
                │ REST + SSE                                      │ fires OS toast on threshold
                ▼                                                 ▼
        [ pinned localhost panel + drill-in workbench ]   [ Windows toast → opens panel deep-linked ]

[ Claude Code = authoring/control plane: edits config, owns reasoner logic, defines executors, runs
  pipeline on demand. Controls the daemon; does not host the UI. ]
```

**Why a daemon (the one genuinely new piece):** the existing pipeline runs on-demand inside Claude Code.
A glanceable, "comes-to-me" surface needs something resident to keep the model fresh and to push. The
daemon is that resident process. Everything else reuses or wraps existing scripts.

**Packaging — resolved (no Electron in v1):** because the daemon is always-on, *it* owns the ambience.
On Windows 11 it fires native **toast notifications** directly (PowerShell / BurntToast or equivalent)
when a threshold trips; clicking the toast opens/focuses the pinned **localhost panel** deep-linked to the
item. Rich interaction = web; "comes to me" = daemon-driven toasts. Native tray/Tauri is optional later
polish, not v1.

## 5. Components (each testable in isolation)

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `scheduler` | Decide when to run the pipeline (per-account interval, on-demand trigger) | config |
| `normalizer` | Pure transform: raw pipeline JSON → world-model items (dedup, group, root-cause, status, source, proposedActions) | config (rules) |
| `proposals` | Stage proposals; own the lifecycle state machine | normalizer output |
| `executors/*` | One file per action; execute or route; **rails live here** | connectors / URLs |
| `store` | Persist world model + proposal queue to `data/` (gitignored) | — |
| `api` | Serve REST (model, queue) + SSE push; `/health` | store, proposals |
| `web/` | Panel ("N need you" + proposals) and drill-in workbench (filter/pivot/multi-select) | api |
| `notifier` | Fire Windows toasts on threshold-crossing diffs; deep-link back to panel | diff output |

Job-types, thresholds, action-mappings, and poll intervals are **config-driven** in
`config/account-types.json` (type defaults) with per-account overrides in `config/companies.json`, per the
Golden Rule. Nothing company- or job-specific is hardcoded in the daemon or web code.

## 6. Data model

**Item** — one deduped/grouped unit of operational reality:
```
{
  id, jobType,            // "handled" | "owed_risk" | "audit" | "exposed" | <future>
  account,                // e.g. "brickell"
  title, status,          // status ∈ {clean, waiting, at_risk, open, ...} per job-type
  group: { rootCause, members: [ref...] },   // grouping key + grouped members
  source: [ threadRef..., externalURL... ],  // systems of record; external truth is a link-out only
  proposedActions: [ actionName... ],        // names resolved by the executor registry
  lastChanged
}
```

**Proposal** — a staged action awaiting approval:
```
{
  id, itemId, action,     // e.g. "draft_chase"
  params, preview,        // e.g. { drafts: [...] } — staged, NOT sent
  state                   // pending | approved | executed | failed | dismissed | snoozed
}
```

**Action / executor** — `name → executor(params) → { kind: "route", url } | { kind: "execute", result }`.
`route` executors just return a URL (cheapest handler). `execute` executors call a connector under the
rails. Escalating an action from route → execute later is a one-executor change; the surface, data model,
and approval gesture do not move.

## 7. Data flow (one tick)

1. **fetch** — scheduler runs the pipeline per account → raw JSON (existing scripts, unchanged).
2. **normalize** — raw → items: dedup, group, attach root-cause + status + source link.
3. **stage** — reasoner/rules attach `proposedActions`; queue proposals worth doing.
4. **diff** — compare to last persisted model: new "needs you" items? threshold crossed?
5. **push** — SSE to the panel (live); fire an OS toast only if a threshold was crossed.
6. **act** — user approves → executor runs (rails) → result recorded → model updates → existing learning
   loop (record-deletions / promote-senders) fed where relevant.

## 8. Grouping / root-cause inference (the opinionated part)

**Deterministic-first, reasoner as opt-in fallback.** Grouping and root-cause run first as
**config-driven deterministic rules** (shared expired-card token, same vendor domain, same error code,
etc.) — predictable, cheap, fully testable. Only **ungrouped stragglers** left after the rules are passed
to the **reasoner as an opt-in fallback** to propose groupings, which rules then confirm. This keeps every
tick cheap and predictable and bounds token cost to genuine residue.

## 9. Liveness

- Scheduled poll every **N minutes**, per-account, config-driven; plus **manual refresh**; plus
  **on-demand** trigger from Claude Code.
- World model + queue are **persisted to disk**, so a daemon restart resumes from last-good with no cold
  rebuild.
- Idle-cheap: nothing recomputed unless a tick runs or the user acts.
- **Push fires only on a real diff** — the panel badge and OS toasts never cry wolf.

## 10. Error handling (never blank, never fabricate)

- **Per-account pipeline failure** → mark that account `stale` in the model, keep its last-good items,
  show a soft "couldn't refresh <account>" banner. One account failing never blanks the panel.
- **Executor failure** → proposal → `failed` with reason, stays visible. Soft-delete rails mean the worst
  case is a no-op; nothing is silently dropped.
- **Auth/token expiry** → surface a re-auth link-out proposal; the daemon does not crash.
- **Portal-only truth** (e.g. Defender resource names) → always a link-out in `source`; never invented.
- **Daemon crash** → model+queue on disk; restart resumes; `/health` lets the panel show "daemon down."

## 11. Safety rails (non-negotiable, enforced and tested)

- **Never auto-send.** No code path references a send-email API. Drafts only — sending is the user's
  action in their mail client.
- **Soft-delete only.** Outlook `POST /me/messages/{id}/move` → `deleteditems`; Gmail
  `users.messages.trash`. Never permanent-delete, never empty trash.
- Rails live **inside executors** and are verified by the executor guard test (§12), making them a build
  invariant rather than a convention.

## 12. Testing

- **Normalizer** — pure unit tests: raw JSON → items; dedup/group/root-cause rules against fixtures.
- **Proposal lifecycle** — state-machine tests across all transitions.
- **Executor guard test** — scans the executor registry and **fails the build if any executor references a
  send or permanent-delete API**. Mirrors the CLAUDE.md rails.
- **API contract** — endpoints return the shape the panel expects.
- **Reasoner fallback** — a fixture of ungrouped stragglers confirms it fires only on residue.
- Existing `scripts/*` are already hardened and are reused, not retested here.

## 13. Repo impact

- **New:** `daemon/` (`scheduler`, `normalizer`, `proposals`, `executors/`, `store`, `api`, `notifier`),
  `web/` (panel + drill-in workbench).
- **Config:** additions to `config/account-types.json` — job-types, statuses, thresholds, action-mappings,
  poll intervals; per-account overrides in `config/companies.json`.
- **Reused unchanged:** `scripts/*` connectors and the `record-deletions` / `promote-senders` learning loop.
- **Layering:** the daemon honors the OfficeOS layers — business logic stays in scripts + normalizer
  (separable from surface), the daemon orchestrates, the web layer only renders + dispatches actions.
- **Gitignore:** daemon state under `data/` is local-only; `.superpowers/` brainstorm artifacts are
  local-only.

## 14. Decisions locked during brainstorm

- Output of this brainstorm: **recommend + spec** (no code yet).
- **Always-on local daemon** is acceptable (enables push/ambient).
- **Action layer = thin executors, escalatable** ("execute where safe, else route"); start soft, harden
  per-action later — cheap because the seam is specced now.
- Direction: **hybrid A + B**, C as drill-in, D deferred.
- Packaging: **daemon-fired Windows toasts + pinned localhost panel**; native tray deferred.
- Grouping: **deterministic-first, reasoner fallback for stragglers**.

## 15. Open questions for implementation planning

- Daemon runtime/process manager on Windows (Node service vs Task Scheduler vs login item) and how Claude
  Code starts/stops/controls it.
- SSE vs WebSocket for push (SSE leans simpler for one-way server→panel updates).
- Concrete toast mechanism (BurntToast module vs raw PowerShell toast) and deep-link scheme back to the
  panel.
- Persistence format for the world model/queue (flat JSON vs SQLite) given expected item volume.
- Exact status vocabularies per job-type and their threshold definitions (config schema).
```
