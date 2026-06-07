# Candidate-Lane Confidence Tier — Design Spec

**Date:** 2026-06-07
**Status:** Approved by user (section-by-section); ready for implementation planning
**Builds on / amends:** `docs/superpowers/specs/2026-06-05-issue-tracker-remediation-design.md` (the shipped build-bundle/collapse funnel)
**Empirical baseline:** `docs/superpowers/reports/2026-06-07-load-test.md` (R-7 load test: fetched 5535 → reasoned 3239, R/fetched 58.5%)

## Problem

After the R-7 load test, the funnel showed `reasoningUnits` (R) is dominated by two floors: the **candidate lane** — 2,580 heuristic-delete candidates, each collapsed then given a full per-representative **rescue judgment** by the reasoner — and the irreducible business-inbox survivor floor. The remediation spec's confirmed invariant is that R moves only via explicit-drop (user-approved `alwaysDelete`/`scamPatterns`) and collapse. Leak-1 batch approval proved a **marginal** lever: the high-volume batches are nearly all keeps/traps (leads, github, td, cardpointe), so approvable noise is a small long tail.

The candidate lane is the real untapped lever: a large share of those 2,580 rescue judgments are spent on mail that is *mechanically, structurally* a bulk blast — the reasoner reliably confirms it as noise. Spending a model judgment to re-derive "yes, this List-Unsubscribe + Precedence:bulk + repeated-template blast is noise" is the wasteful reasoning the design philosophy exists to eliminate.

**The cardinal sin this design must not commit:** wrongly skipping a candidate that *should* have been rescued — a real person with a specific ask, mis-scored as bulk — is **silent loss**. It is strictly worse than spending a judgment. Every decision below is subordinated to making silent loss observable and reversible, and to *proving* its absence before the tier is allowed to act.

## Design philosophy (how this reconciles with the locked spec)

The 2026-06-05 spec rejects "capping what reaches the reasoner" and lists "auto-dropping any noise class" as a non-goal, with the only delete path being user-approved rules. This design is **not** a cap and **not** a new pre-reasoner auto-drop in that sense, for one structural reason:

> The reasoner **already** soft-deletes candidates it judges as noise (`verdict: trash` in `_reasoner-pass.md`) with **no per-sender approved rule**. `trash` is a model *judgment*, not an `alwaysDelete` entry.

The confidence tier **delegates that existing judgment to a deterministic score for the obvious, corroborated cases** — which is precisely what the spec's own feedback loop prescribes: *"high reasoner load is a signal to strengthen a deterministic layer."* It strengthens the deterministic layer rather than capping the reasoner.

This design therefore **amends** two clauses of the 2026-06-05 spec (a back-pointer is added there):

1. *"No reasoner cap … capping what reaches the reasoner drops processing and is rejected"* → **"no _silent / incomplete_ truncation."** Every fetched email still receives a disposition and (if trashed) a recoverable soft-delete. Nothing is dropped from *processing*; the cheap-to-classify, corroborated-bulk subset simply receives its disposition deterministically instead of from the model. The illegitimate thing the original clause guards against — silently *not processing* mail and reintroducing incomplete information — does not happen here.
2. **R-reduction invariant** gains a third lever: R moves via *explicit-drop, collapse, **and the validated confidence tier***.

**Data-preservation invariant (unchanged):** the tier changes *who decides* (deterministic score vs. model) for a corroborated-bulk subset; it never changes *what mail exists* and never hard-deletes. Soft-delete only, always recoverable, never auto-empties trash.

## Locked decisions

| Decision | Choice |
|---|---|
| Framing | **Deterministic pre-verdict** that produces the same `verdict: trash` record the reasoner would, gated by score + corroboration + not-protected. Strengthens the deterministic layer; amends "no cap" → "no silent truncation". |
| Validation | **Reasoner-as-oracle shadow diff.** Tier graduates to `active` only when false-trash (tier=trash ∧ reasoner=keep) is **zero** across the load set. |
| Eligibility | **Both signals required:** structural bulk score ≥ cutoff **AND** collapse-grouped (`alert-batch`/`exact-dup`, size ≥ minGroupSize). Plus sender-not-protected (defense-in-depth). |
| Signal source | **Structural only** — the full `detectBulkSignals` score (List-Unsubscribe, `Precedence:bulk`, Gmail PROMOTIONS/FORUMS category label, BCC-to-me, marketing-subdomain). All five are sender-*infrastructure* facts, not content matches. **Never** the classify flag-reason (downrank keyword / deletion pattern / triage category) — that is not part of `bulkScore`, and personalization stays the reasoner's call. |
| Drift guard | **Permanent shadow sample + auto-demote.** In active mode a configurable % of eligible groups are still reasoned each run; disagreement over threshold flips the account back to `shadow` and alerts. |
| Audit sampling | **Deterministic by msgid hash** (`hash(msgid) % 100 < auditSamplePercent`), not `Math.random` — reproducible, non-flapping. |
| Default state | `candidateTier` **absent ⇒ tier OFF** (existing behavior). Opted-in accounts ship `mode:"shadow"`; `active` is a deliberate post-graduation edit. |

## Non-goals (this pass)

- Content-based or per-sender learned scoring — structural signals only.
- Auto-graduation from shadow → active. Graduation is a human-reviewed config edit after the gate passes; only *demotion* is automatic (safe direction).
- Changing `collapse.js` grouping or `classify-emails.js` internals.
- Touching the survivor floor (out of scope; a separate lever).
- Hard-delete or trash-emptying — soft-delete only, always.

## Architecture & components

### New — `scripts/`

**`confidence-tier.js`** — pure, deterministic, no I/O, densely unit-testable (mirrors `collapse.js`). This is where the silent-loss risk is quarantined; the orchestrator stays thin.

```js
applyConfidenceTier(candidateItems, groups, { accountConfigById, now })
  → {
      decisions: { [representativeMsgid]: { verdict: "trash", score, groupId, audited: boolean } },
      tierRecords: [ { msgid, verdict: "trash", issue: null, reason: "tier:bulk-score>=N+grouped", next_action_update: "", waiting_on_update: null } ],
      stats: { eligibleGroups, trashedGroups, auditedGroups, trashedMembers, perAccount: { ... } }
    }
```

- Operates on **candidate** bundle items only (`tag === "heuristic-delete-candidate"`). Survivors are never touched.
- **Eligibility** per group (evaluated on the representative):
  - `group.kind ∈ {"alert-batch", "exact-dup"}` and `group.size ≥ cfg.minGroupSize`
  - representative's `bulkScore ≥ cfg.scoreCutoff`
  - `!isProtectedSender(account, sender)` (re-uses the build-bundle helper; protected senders are already kept as survivors by classify, so this is defense-in-depth)
- **Mode behavior:**
  - `mode: "shadow"` → record a `decision` with verdict `trash` for the representative, but emit **no** `tierRecords`. The reasoner still judges it. (Validation only.)
  - `mode: "active"` → for each eligible group, decide audit membership via the deterministic hash. Audited groups behave like shadow (still reasoned, decision recorded with `audited:true`). Non-audited groups are **auto-trashed**: emit `tierRecords` for **every member msgid** of the group.
  - `mode` absent / unrecognized → tier is a no-op (returns empty decisions/records).
- `tierRecords` carry the same shape `issue-apply.js` consumes from the reasoner, so they concatenate transparently. The trash `reason` is machine-tagged (`tier:...`) for downstream filtering/audit.

**`tier-audit.js`** — pure, unit-testable. Compares tier verdicts against reasoner verdicts.

```js
auditTier(bundle, reasonerRecords, { demoteThresholdPercent })
  → {
      agree, falseTrash, falseTrashRate,
      falseTrashList: [ { msgid, account, sender, subject } ],   // NEVER summarized
      demoteRecommended: boolean,
      perAccount: { [id]: { agree, falseTrash, falseTrashRate, demoteRecommended } }
    }
```

For every msgid that carries a tier verdict, classify against the reasoner's verdict for the same msgid:

| | reasoner: trash | reasoner: keep |
|---|---|---|
| **tier: trash** | agree | **false-trash (harm)** |

The tier never emits `keep`, so these are the only cells. `falseTrashRate = falseTrash / (agree + falseTrash)` — the fraction of *tier-trash decisions* that the reasoner would have rescued (denominator is the count of msgids the tier marked trash, not all msgids). `falseTrashList` is emitted in full (per the no-compress-deletions rule) so the user sees exactly which mail would have been wrongly lost. `demoteRecommended` (per account) is true when `falseTrashRate > demoteThresholdPercent`.

### Modified — `scripts/`

- **`build-bundle.js`**:
  - Compute `bulkScore = detectBulkSignals(e, account.myEmail).score` for each candidate while building `toCollapse`; carry it on the bundle item.
  - After `groupForReasoning`, call `applyConfidenceTier(...)`. Stamp each decided representative's bundle item with `tier: { verdict, score, mode, audited }`. Attach `tierRecords` to the output. Subtract auto-trashed groups from `reasoningUnits` and extend the funnel.
  - Extend the CLI account mapping (already carries `myEmail`/`prioritySenders`/`neverDelete` from the Leak-1 meta-fix) to also carry the **resolved** `candidateTier` config (type default → account override).
  - **Build-bundle still never deletes.** It only stamps verdicts and emits `tierRecords`. Soft-delete remains the `/issues` skill's action via the existing connectors.

### Modified — skills/docs

- **`.claude/commands/issues/_reasoner-pass.md`**: add a rule — *if a representative carries an **active** tier verdict (`tier.mode === "active"` and `!tier.audited`), do NOT judge it; it has already been dispositioned deterministically. Shadow and audited representatives ARE judged normally.* And: the skill concatenates `bundle.tierRecords` with the reasoner's records before invoking `issue-apply.js`; then runs `tier-audit.js` over the audited sample and applies/surfaces demotion.
- **`.claude/commands/issues/issues.md`**: document the tier stage in the bundle→reason→apply flow and the shadow/active/audit lifecycle.
- **2026-06-05 remediation spec**: add the back-pointer + amendment note described under "Design philosophy".

## Data flow

```
fetch → classify → survivors + candidates → collapse (groups)
  → confidence-tier:
       eligible ⇔ candidate ∧ kind∈{alert-batch,exact-dup} ∧ size≥minGroupSize
                  ∧ bulkScore≥scoreCutoff ∧ ¬protected
       · shadow → stamp decision; reasoner still judges; no tierRecords
       · active → audit-sampled groups reasoned (decision.audited=true);
                  rest auto-trashed → tierRecords for all members
  → reasoner judges remaining representatives → records[]
  → concat(records, bundle.tierRecords) → issue-apply.js → soft-delete (recoverable)
  → tier-audit.js over audited sample → demote account to shadow if drift
```

### Funnel (extended; reconciliation preserved)

```
fetched → explicit-dropped → survivors + candidates → collapse N→G units
  → tier auto-trashed T groups (M members) → reasoned (G − T)
```

New `funnel.tier`:
```json
"tier": {
  "mode": "shadow|active|off",
  "eligibleGroups": 0,
  "trashedGroups": 0,
  "auditedGroups": 0,
  "trashedMembers": 0,
  "perAccount": { "<id>": { "mode": "...", "eligibleGroups": 0, "trashedGroups": 0, "auditedGroups": 0, "trashedMembers": 0 } }
}
```
Invariant: `reasoningUnits === groups.length − tier.trashedGroups`. In `shadow`/`off`, `trashedGroups === 0` and `reasoningUnits` is unchanged from today.

## Validation & lifecycle

**Mode lifecycle (per account):** `off (absent) → shadow → active`, with automatic `active → shadow` on drift. Forward transitions are deliberate human edits; the backward (safe) transition is automatic.

1. **Graduation gate (human-reviewed, one-time per account):**
   - Run `build-bundle` in `shadow` over the full load window. Run the reasoner over everything (shadow representatives included). Feed bundle + `records[]` to `tier-audit.js`.
   - Graduate the account to `active` **only when `falseTrash === 0`** across the sample.
   - Choose `scoreCutoff` as the **lowest** value that still yields zero false-trash (maximum R reduction at zero harm). The audit's per-cutoff false-trash counts inform this — re-run `tier-audit` at candidate cutoffs.

2. **Ongoing drift guard (automatic, every active run):**
   - The `auditSamplePercent` of eligible groups held back are reasoned, producing a live tier-vs-reasoner comparison.
   - `tier-audit.js` runs over that sample. If `perAccount.falseTrashRate > demoteThresholdPercent`, it **atomically flips that account's `mode` to `"shadow"`** in `config/companies.json`, logs the reason + offending senders, and the run surfaces a loud warning. Self-healing: a vendor that starts personalizing demotes the tier without human intervention.

## Config

`config/account-types.json` provides type defaults; `config/companies.json` overrides per account (account wins for scalars, per the merge order). **Absent ⇒ tier OFF.**

```json
"candidateTier": {
  "mode": "shadow",            // off (absent) | shadow | active
  "scoreCutoff": 3,            // structural bulk signals (detectBulkSignals score)
  "minGroupSize": 4,           // ≥ alert-batch N
  "auditSamplePercent": 10,    // % of eligible groups still reasoned in active mode
  "demoteThresholdPercent": 0  // 0 ⇒ any false-trash demotes
}
```

Ships `mode:"shadow"` for opted-in accounts. brickellpay (business-critical, ~89% keep floor) stays the most conservative — graduated last, highest cutoff, lowest sample tolerance.

## Testing

**`confidence-tier.js` (dense — this is the risk surface):**
- Both signals required: score-only (ungrouped) → ineligible; grouped + low-score → ineligible; eligible-score + group below `minGroupSize` → ineligible.
- Content-flagged candidate (low structural score, flagged by keyword/category) → **never** eligible.
- Protected sender (priority/neverDelete/internal domain) → excluded even if grouped + high score.
- Survivors → never considered.
- `shadow`: decision recorded, **no** `tierRecords` emitted.
- `active`: non-audited eligible group → `tierRecords` for **every** member msgid (count == group size); funnel members conserved.
- Audit sampling deterministic by msgid hash; an audited group is reasoned (decision.audited=true), not trashed; same msgid → same audit status across runs.
- `mode` absent/unrecognized → no-op.

**`build-bundle.js` (integration):**
- Funnel reconciles: `reasoningUnits === groups − tier.trashedGroups`; `fetched === explicitDropped + survivors + heuristicCandidates`; members conserved.
- `shadow`/`off` leave `reasoningUnits` unchanged vs. pre-tier.
- `bulkScore` present on candidate items; `tier` stamped on decided representatives; `tierRecords` present in output.

**`tier-audit.js`:**
- Confusion matrix correctness; false-trash detection (tier=trash ∧ reasoner=keep).
- `falseTrashList` emitted in full (not truncated/summarized).
- `demoteRecommended` true exactly when rate > threshold; per-account isolation.

**Golden:** extend the SEAA fixture so a corroborated-bulk batch flows bundle→tier(active)→tierRecords→issue-apply→soft-delete, AND a personalized-but-bulk-looking email in the same batch is held by audit-sampling / rescued by the reasoner (proves no silent loss on the mixed case).

**`_reasoner-pass.md` behavior:** active+non-audited representatives skipped; shadow + audited representatives judged.

## File structure summary

**Create:**
- `scripts/confidence-tier.js` + `scripts/test/confidence-tier.test.js`
- `scripts/tier-audit.js` + `scripts/test/tier-audit.test.js`

**Modify:**
- `scripts/build-bundle.js` (bulkScore, tier call, funnel, tierRecords, CLI config plumbing) + `scripts/test/build-bundle.test.js`
- `.claude/commands/issues/_reasoner-pass.md` (skip active tier verdicts; concat tierRecords; run tier-audit)
- `.claude/commands/issues/issues.md` (document tier stage + lifecycle)
- `config/account-types.json` (candidateTier defaults — gitignored), `config/companies.json` (per-account, gitignored)
- `docs/superpowers/specs/2026-06-05-issue-tracker-remediation-design.md` (back-pointer + amendment note)

**New runtime data (gitignored):** none beyond existing artifacts. (`tier-audit` output can be written to `data/.last-tier-audit.json` for inspection; optional, gitignored.)

## Open questions

None. All decisions locked.
