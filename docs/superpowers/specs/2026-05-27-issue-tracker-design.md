# Issue Tracker — Design Spec

**Date:** 2026-05-27
**Status:** Approved by user (section-by-section); ready for implementation planning
**Builds on:** `docs/superpowers/specs/2026-05-21-morning-brief-design.md` (the morning-brief system, which this coexists with)

## Problem

The morning-brief system is a rule-based classifier with a surfacing layer. Both layers harden into stale lists the moment they're useful: `alwaysDelete` over-deletes, the classifier mis-categorizes, and every correction adds another deterministic rule that itself goes stale. The user's diagnosis: *"We're in a loop of evaluating what is deleted instead of a conversation about the messages and issues."*

The concrete demonstration: 18 emails mentioning "SEAA" (Southeast Acquirers Association conference) arrived at the Brickell Pay inbox over 7 days. Two were genuine personalized partner meeting requests (Neal Zeleznak/NMI — both are in `prioritySenders`; Brad Staudt/North — also a priority sender). Sixteen were broadcast "stop by our booth" marketing blasts. A rule-based classifier cannot separate them: keyword `meeting`/`invite`/`connect` flags all 18 as action (drowning the 2), or sender-domain rules miss the personalization entirely. Only content-level reasoning distinguishes "I saw your name on the attendee list, want to connect?" from "Visit Booth 107."

## Goal

Add a **reasoning layer + topic-based issue graph** on top of the existing pipeline. Email becomes a feed *into* issues; issues are the unit the user converses with. The user asks `pp?` and gets three lines about Path Peptides; says `draft pp` and gets a context-aware reply. No brief to read, no list to scroll — a conversation about issues, not a queue of deletions to approve.

This is **v1, scope 2**: foundation (bootstrap + issue files + `/issues` + drill-in) plus context-aware drafting. The morning-brief system continues to run alongside; it is not retired in v1.

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Daily experience shape | **Issue-centric**, both user- and agent-initiated | Matches how the user thinks about work (by issue, not by email) |
| Issue granularity | **Topic-based** — issues span threads, contacts, time | "Path Peptides" not "Re: chain from 5/22"; threads too narrow, decisions-only too restrictive |
| v1 scope | **Foundation + context-aware drafting; morning-brief coexists** | Smallest swing that breaks the plateau without all-or-nothing risk |
| Reasoner cadence | **Piggyback on morning-brief + on-demand `/issues` refresh** | Zero new fetch cost for the daily path; mid-day currency when wanted |
| New-issue birth | **Auto-create, quarantine provisional singletons** | No per-email approval treadmill; real issue list stays signal-dense |
| Reasoner/deletion boundary | **Reasoner reviews heuristic deletions, honors explicit rules** | Explicit per-sender rules stay fast & deterministic; heuristic guesses get content evaluation |

## Non-goals (v1)

- **Not** retiring morning-brief (that's a later step once issues prove out).
- **Not** agent-initiated pings/notifications (requires a notification surface — Cowork, push, or scheduled task — separate project). The `waiting_on` field is designed to enable this later.
- **Not** second-guessing explicit `alwaysDelete`/`neverDelete` (those are deliberate user decisions).
- **Not** per-email LLM calls (cost) — one batched call per run.
- **No auto-send** and **no permanent delete** — inherits CLAUDE.md's non-negotiable rails.

## Architecture (three-layer model, per CLAUDE.md)

### Layer 1 — Connectors (`scripts/`)

- **New: `scripts/issue-store.js`** — deterministic CRUD over `data/issues/*.md`. Pure functions, no LLM, no judgment. Exports: `loadIssues`, `loadProvisional`, `findByAlias`, `listByStatus`, `createIssue`, `saveIssue`, `mergeIssues`, `markDone`, `snoozeIssue`, `graduateProvisional`, `slugify`. Atomic writes via existing `fs-utils.atomicWrite`.
- **Reused as-is:** `fetch-emails.js`, `fetch-gmail.js`, `classify-emails.js`, `save-draft.js`, `save-gmail-draft.js`, `delete-emails.js`, `delete-gmail-emails.js`, `gmail-verify.js`, `fs-utils.js`.
- **Modified: `scripts/morning-brief.js`** — gains `--defer-heuristic-deletes` flag (below). Otherwise unchanged; standalone behavior preserved.

### Layer 2 — Skill (`.claude/commands/issues/issues.md`)

The `/issues` command. Where the LLM reasoning lives (repo convention: scripts are deterministic, skills reason). Drives the assignment pass, the bootstrap, the status/drill-in views, and the verbs. Accepts `$ARGUMENTS`.

### Data flow, one incremental run

1. Fetch + `classify-emails.js` → explicit `alwaysDelete` trashed (soft), `neverDelete`/priority protected. Cheap, deterministic, no LLM.
2. Bundle: survivors **+** heuristic-deletion candidates (bulk-signal, auto-discovered scamPattern hits) **+** compact issue index **+** `attention-profile.md`.
3. **One batched LLM pass** (the skill) → per-email verdict + issue assignment (see Reasoner Pass).
4. `issue-store.js` applies: update/create issue files, quarantine singletons, soft-delete confirmed noise.

## Issue data model

One file per issue: `data/issues/<slug>.md` (real) or `data/issues/provisional/<slug>.md` (quarantined singletons). Markdown + YAML frontmatter, matching the repo's memory-file convention.

```markdown
---
id: path-peptides-onboarding
title: Path Peptides Onboarding
aliases: [pp, peptides]
status: open                 # open | snoozed | done
accounts: [brickellpay]      # may list more than one
participants:
  - Luis Raventos <lraventos@brickellpay.com>
  - Jared Kernodle <jared.kernodle@trxservices.com>
opened: 2026-05-22
last_activity: 2026-05-27
snooze_until: null           # ISO date when status == snoozed
next_action: "Waiting on Jared to send onboarding docs (said this weekend)"
waiting_on: jared            # you | <participant> | nobody
---

## Decisions made
- 2026-05-22: Proceeding with TRX as processor for Path Peptides

## Open questions
- When does Tua respond re: plastic-surgeon vertical?

## Linked messages
- msgid:AAMk… — Luis, 5/22 — "thanks, asking about Tua"
- msgid:AAMk… — Jared, 5/22 — "will send docs this weekend"

## Log
- 5/27 reasoner: no new mail; still waiting on Jared
```

Fields doing real work:
- **`aliases`** — how the user addresses the issue (`pp?`). Skill resolves alias → file; ambiguous → numbered shortlist.
- **`waiting_on`** — powers terse answers and (future) agent-initiated nudges.
- **`next_action`** — the one-line the reasoner keeps current; what `/issues` displays.
- **`status: snoozed`** + **`snooze_until`** — hidden from default view until the date or new activity.
- **Linked messages** are msgid references, never copies — body stays in the mailbox, issue file stays small and greppable.

**State file** — `data/issue-assignment-state.json`: `{ lastAssignedAt: { <accountId>: ISO } }`. Lets on-demand `/issues` fetch only the delta. Analogous to `last-run-state.json`.

## The reasoner pass

A single batched LLM call. The brain of the system.

**Input** (assembled by the skill):
- Batch of emails, each tagged `survivor` or `heuristic-delete-candidate`. Per email: sender, subject, preview/body, date, account, thread-id, has-list-unsubscribe, and (for candidates) why the heuristic flagged it.
- Compact issue index: per open issue — `id`, `title`, `aliases`, one-line `next_action`, `participants`. Not full files.
- `attention-profile.md` as judgment context.

**Output** (structured JSON, schema-validated at the skill boundary): one record per email —
```json
{
  "msgid": "…",
  "verdict": "keep | trash",
  "issue": "<existing-id> | NEW:Proposed Title | null",
  "reason": "<one line>",
  "next_action_update": "<new next_action, or null>",
  "waiting_on_update": "you | <name> | nobody | null"
}
```

**Resolution per case:**
- Heuristic candidate + `trash` → soft-deleted (pattern was right).
- Heuristic candidate + `keep` → **rescued**, then assigned like a survivor. (This is "rules aren't absolute" in action.)
- Survivor + `issue: <existing-id>` → appended; `next_action`/`waiting_on` updated.
- Survivor + `issue: NEW:…` → new issue. If only email + no decision detected → `provisional/`.
- Survivor + `issue: null` → kept in mailbox, untracked (pure FYI). Not deleted, not an issue.

**SEAA validation:** 16 promos → `trash` or `issue: null`; Neal/NMI + Brad/North → `NEW:SEAA Partner Meetings`, 2 emails + clear decision → graduates to real open issue immediately.

**Cost:** one call per run, dominated by the email batch (issue index is small). At ~50–200 kept+candidate emails/run after explicit-rule deletion, a single mid-size call — cents. On-demand refresh runs only over the delta, so mid-day checks are tiny.

## Commands & interaction

One skill, `/issues`, `$ARGUMENTS`-driven. Terse by default; verbose only on explicit `more`.

**Status view** — `/issues` (no args):
```
Open (4):
  pp   Path Peptides — waiting on Jared (docs this weekend)
  ms   MS billing — YOU: card declined ×2, update payment
  seaa SEAA Partner Meetings — YOU: reply Neal(NMI) + Brad(North)
  hhc  HHC Schedule 1 — YOU: Levy needs it Fri
Provisional (3) · Snoozed (1) · `/issues more` for detail
```
Sorted `waiting_on: you` first, then waiting-on-others. Provisional/snoozed collapsed to counts.

**Drill-in** — `/issues pp` or `pp?`:
```
Path Peptides Onboarding · brickellpay · since 5/22
Next: waiting on Jared (onboarding docs, said this weekend)
Last: 5/27 Luis thanked Jared, asked re: Tua
Open Q: when does Tua respond on plastic-surgeon vertical?
```
`pp more` → full log + linked messages.

**Verbs** — `/issues <verb> <alias>`:
- `draft <alias>` → reply composed from the account voice profile **+** the issue's accumulated context; saved to Drafts-OfficeOS; 1-line preview shown. Never sent.
- `done <alias>` → status→done, archived.
- `snooze <alias> <when>` (`3d`, `friday`) → hidden until then or new activity.
- `merge <a> <b>` → fold one issue into another; msgids deduped.
- `ignore <provisional-slug>` → discard a provisional singleton.
- `graduate <provisional-slug>` → promote a provisional to real open issue.

Alias resolution from each issue's `aliases:`; ambiguous → one-line numbered shortlist.

## morning-brief integration & deletion boundary

**The one change to `morning-brief.js`:** flag `--defer-heuristic-deletes`. When set:
- Explicit `alwaysDelete` → still trashed immediately (user decisions, fast, free).
- `neverDelete`/priority → still protected.
- Heuristic candidates (bulk-signal, scamPattern) → **not trashed**; emitted in JSON under `heuristicCandidates[]` for the reasoner.

Without the flag, morning-brief behaves exactly as today.

**Cadence C — two run paths:**
1. **Piggyback** — the reasoner-pass instructions live in a shared reference file (`.claude/commands/issues/_reasoner-pass.md`) that *both* the `/issues` skill and the morning-brief skill include. (Skills are prompts, not callable functions; sharing is by include/reference, not invocation.) The morning-brief skill, after its orchestrator run, follows that shared fragment using the already-fetched bundle — no second fetch. The brief gains a section: "Issues updated: N open, M new, K heuristic deletes rescued."
2. **On-demand** — `/issues` run directly reads `issue-assignment-state.json`, fetches only the delta since last assignment, runs the same shared reasoner-pass fragment, answers.

Note: the shared reasoner-pass fragment is a prompt include, not code. The deterministic apply step it hands off to (`issue-store.js`) is the testable code boundary.

**Deletion boundary (decision B), concrete:**
- alwaysDelete / approved scamPatterns / neverDelete → handled by `classify-emails.js`, never reach the reasoner.
- bulk-signal + auto-discovered scamPattern hits → reasoner reviews before trash.
- All trashing is **soft-delete only** — reasoner `verdict: trash` calls the same move-to-deleted-items / Gmail-trash path. Nothing the reasoner does can permanently delete.

**Safety inheritance:** `/issues` inherits morning-brief's invariants — never auto-send (drafts only), soft-delete only, atomic issue-file writes (`fs-utils.atomicWrite`), and a first-run guard: if no issue store exists, the first `/issues` run is the bootstrap and **never trashes**.

## Bootstrap

First `/issues` run with no issue store → cold-start detection → wider pass: fetch 14–30d across all accounts, reason over it, propose ~5–10 candidate issues written as **provisional**, show the list. The user sweeps once: `graduate` real ones, `merge` dupes, `ignore` junk, rename/alias. **The bootstrap pass never trashes** — read-and-organize only, zero-risk cold start. Normal incremental assignment takes over afterward.

## Testing

Split by deterministic vs. judgment:

- **`scripts/issue-store.js` — full unit coverage** (the bulk): create/slugify, load-all, find-by-alias (incl. ambiguous → list), status filters, merge (two files → one, msgids deduped), graduate (provisional/ → issues/), snooze-with-date, atomic writes, corrupt-file resilience.
- **`morning-brief.js --defer-heuristic-deletes`** — unit tests on the injected-deps harness: explicit alwaysDelete still trashes; heuristic candidates emitted not trashed; neverDelete protected.
- **Reasoner pass (LLM judgment)** — *not* asserted for exact output (non-deterministic). Instead: skill output is schema-validated; the **applier** is tested against fixed reasoner-output fixtures → does `issue-store` create/update/quarantine/trash correctly?
- **Golden SEAA fixture** — the 18 SEAA emails frozen as a fixture: given expected reasoner verdicts, assert the applier produces one "SEAA Partner Meetings" issue with Neal+Brad and trashes/no-issues the 16 promos. Pins the canonical case end-to-end on the deterministic side.

## Opportunistic fix (in scope as final cleanup)

The deferred `discoverAutoTrash` bug: it re-proposes senders already in `alwaysDelete` (this morning's duplicate p-007 of the approved p-001). Fix in `scripts/pattern-discovery.js` — `discoverAutoTrash` must also skip senders already present in the account's `alwaysDelete` (not just `neverDelete`/`prioritySenders`). Add a regression test. Folded in because this work touches the deletion boundary.

## File structure summary

**Create:**
- `scripts/issue-store.js` + `scripts/test/issue-store.test.js`
- `.claude/commands/issues/issues.md` (the `/issues` skill)
- `.claude/commands/issues/_reasoner-pass.md` (shared reasoner-pass prompt fragment, included by both `/issues` and the morning-brief skill)
- `scripts/test/fixtures/issues.js` (issue files, reasoner-output fixtures, SEAA email fixture)
- `scripts/test/issue-applier.test.js` (applier given reasoner-output fixtures)

**Modify:**
- `scripts/morning-brief.js` (+ `--defer-heuristic-deletes`) + its test
- `scripts/pattern-discovery.js` (discoverAutoTrash alwaysDelete check) + its test
- `.claude/commands/reports/morning-brief.md` (piggyback invocation of `/issues` at end of run)

**New runtime data (gitignored):**
- `data/issues/*.md`, `data/issues/provisional/*.md`
- `data/issue-assignment-state.json`

## Open questions

None. All six architectural decisions locked.
