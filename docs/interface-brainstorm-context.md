# OfficeOS — Interface Brainstorm Context

> Purpose: brief a fresh session on the **next big question for OfficeOS — what is the right
> way to perceive and act on the operational reality this system models?** The data substrate
> is mature. The interface is wide open. This brainstorm exists to **open the design space**,
> not narrow it — so two assumptions are deliberately ON THE TABLE, not given:
>
> 1. **The interface is NOT assumed to be Claude Code** (or any single host/app).
> 2. **The output is NOT a report or dashboard.** We want something richer than snapshots
>    you read.
>
> Explore boldly first. Recommend later. Do not jump to "a dashboard built in X."

## Read this first (the substrate, not the destination)
This repo is the **data + logic substrate** — the thing that knows what's true. It is also,
today, *operated* through Claude Code. Don't confuse the two: the operating surface so far is
incidental, not the answer. Ground yourself in:
- `CLAUDE.md` — layered architecture + non-negotiable safety rules
- `config/account-types.json`, `config/companies.json` — config-as-source-of-truth (gitignored)
- `scripts/build-bundle.js`, `scripts/classify-emails.js` — fetch → classify → clean pipeline
- `scripts/correspondents.js`, `scripts/promote-senders.js`, `scripts/record-deletions.js` — protection + learning loop
- `.claude/commands/` — the current skill/command layer

Architecture has a **UI-Readiness Rule**: business logic lives in scripts so logic and surface
are separable. Treat the substrate as something a *service/API* could expose to **any** client.

## What the system already knows (mature)
A single-user executive operating system spanning four accounts — Healthcare M&A, Brickell
Payments, Summit Miami (Microsoft 365 / Graph) and Personal (Gmail):
- Hardened email pipeline: fetch → classify → collapse duplicates → deterministic confidence
  tier (auto-trash corroborated bulk) → LLM reasoner for the rest → soft-delete connectors.
  Safety (non-negotiable): **soft-delete only, never permanent, never auto-send.**
- ~800-sender guarded kill-list, "never delete anyone I've emailed" correspondent rule,
  rotating-domain scam patterns, an auto-promote learning loop, ~40k+ emails cleaned.
- Beyond inbox hygiene, it can already *reason over* the mail to answer real operational
  questions (see "jobs" below). It emits structured JSON. **Knowing the data is solved.**

## The two assumptions we are dropping (this is the whole point)

### 1. Drop "the interface = Claude Code"
The target surface is open. The substrate could be exposed (local service/API) to whatever
form actually fits an executive's life. Don't pre-rank these — invent past them:
- a dedicated app (web / native desktop / **mobile**),
- **ambient / proactive** surfaces (lock-screen, home-screen widget, watch, a glanceable
  always-on panel) that bring the right thing to me instead of me going to look,
- **conversational + visual** (talk or type, it *shows* the relevant view and I act on it),
- **embedded where I already am** (inside the mail client, Teams, calendar, phone),
- a **multimodal agent** I delegate to that perceives, proposes, and executes with approval.
Claude Code may end up being the *authoring/control* plane while the *consuming* surface is
something else entirely. Keep that separation live.

### 2. Drop "the output = a report / dashboard"
Reports are snapshots you *read*. That's the failure mode we keep hitting (a wall of text I
must consume; output as long as the input). Aim for something **living and act-in-able**:
- a **continuously-updated model** of my operational world I can pivot/drill/query in real time,
- **proactive surfacing** — the system decides what deserves attention *now* and brings it,
- **direct manipulation** — items are objects I group/act on, not rows I scroll,
- **agentic** — the surface proposes and (with approval) executes; the display is secondary
  to the decision,
- **decision-shaped, not document-shaped** — it should reduce what I read and let me act in
  one gesture, not hand me a longer thing to read.
Richer paradigms welcome and encouraged; the four "jobs" below are *what I need to do*, not
four screens to render.

## The jobs to be done (requirements as questions + actions, NOT reports)
These recurred all arc — each is a standing question I ask and an action I take, ideally
something the surface keeps live and acts on, not something I request and read:
1. **"Is my world handled?"** — per account: what's clean, what's left, what's waiting on me.
2. **"What do I owe / what's at risk?"** — vendors with past-due/failed payments, grouped,
   with status and **root cause** (e.g. one expired card causing many), across accounts.
   Action: pay / chase / dismiss.
3. **"Where do my audits/compliance stand?"** — open action-items, evidence owed, what the
   auditor closed, by control. Action: assign / upload / respond.
4. **"What's exposed?"** — security findings (e.g. Defender attack paths), deduped to real
   findings with risk + affected resource. Action: route / acknowledge / link to source.
Shared shape: many records, deduped/grouped, continuously changing, each needing
status + drill-in + a light action. **Assume more jobs will be added** — design for a class,
not these four.

## The brainstorm's mandate
Explore the space across **paradigm × host × modality × feed**, then recommend. For each
genuinely-different direction: what the experience *is*, how it's fed from the substrate (the
pipeline already emits JSON — what does it need to become: a service? an event stream? a
local store?), what it takes to build/run, refresh/liveness model, and trade-offs. Push for at
least a couple that are NOT "a dashboard" and NOT hosted in Claude Code. Then right-size.

## Constraints (respect, don't let them shrink the vision prematurely)
- Single user; **sensitive data** (financial, PCI/compliance, personal); mostly local; config
  + OAuth tokens are gitignored and machine-local. Privacy and where data lives matter.
- Keep the rails: **soft-delete only, never auto-send**; logic stays in the substrate so any
  surface shares it.
- Executive, not a full-time operator: **perception and action must be near-frictionless** —
  glanceable in, one gesture out. This is a *richness + low-friction* goal, not a feature count.
- Bias to exploring boldly, then choosing the simplest thing that delivers the rich experience
  the substrate can actually feed. Don't gold-plate; don't pre-shrink to a report either.

## Hard-won lessons (don't relearn)
- Every failure this arc was the **interface paradigm**, not the data. The engine is good.
- Conversational chat is a strong *command* surface and a poor *display/decision* surface.
- Bulk realities can't be worked by typing; the surface must support select/act or act-on-glance.
- Truth sometimes lives **outside email** (e.g. Defender attack-path resource names are
  Azure-portal-only) — surfaces must **link out to the system of record, never fabricate**.
- "Show me everything" in a transcript is the anti-pattern. The win is **bring me the few
  things that matter and let me act**, with depth on demand.
