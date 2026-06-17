# OfficeOS — `audit`, `exposed`, `gateway` job-types (design)

> Date: 2026-06-17
> Status: approved design, pre-implementation
> Extends the Ambient Proposal Panel (Plans 1–3). Adds the three remaining standing jobs from
> `docs/interface-brainstorm-context.md`, grounded in real sample emails the user supplied.

## 1. Summary

The daemon already runs `owed_risk` and `handled` through a normalizer **registry** (one job = a
normalizer + config recognizers; scheduler/panel/store/api are generic). This design adds the three
remaining jobs the executive actually faces, each grounded in real `.msg` samples:

- **`audit`** — compliance fieldwork driven by **Secureframe** (`hello@secureframe.com`): per-test
  action-required / comment-upload requests during the ~3-month window before each yearly cert.
- **`exposed`** — security findings from four sources: **Defender for Cloud** attack paths, **Defender
  for Endpoint** CVEs, **BrickellPay PCI** tamper alerts, **Entra ID Protection** digests.
- **`gateway`** — operational processing incidents affecting the user's merchants, via **NMI** support
  tickets (`support@nmi.com`): settlement batch failures, tokenization errors, keyed by ticket #.

All three land in the **Brickell Payments business inbox** (`bsardinas@brickellpay.com`) already
fetched. Each is config-driven and per-source, so adding a future processor (TSYS), security tool, or
GRC platform is "another recognizer," never a new screen. The design also adds a small, shared
**acknowledge** capability so a finding/ticket the user has handled stops re-alerting until it changes.

## 2. Goals & non-goals

**Goals**
- Cover all three jobs as registry normalizers; reuse scheduler/panel/store/api unchanged in shape.
- Deterministic, config-driven recognition keyed off the exact senders/subjects from the samples.
- Dedupe each job to stable real-world IDs (test name, attack-path ID, CVE, PCI URL+type, ticket #).
- **Link out to the system of record, never fabricate** (Azure portal, PCI dashboard, Secureframe, NMI).
- Surface only real, actionable items; suppress clean digests and sandbox/test noise.
- Add **acknowledge** so handled items clear and only re-alert on a real change.
- Preserve the rails: **never auto-send, soft-delete only**; new actions are link-out + local state.

**Non-goals (this design)**
- No API execution into Azure/Secureframe/NMI (route + acknowledge only). Drafting a reply to an NMI
  ticket is a clean later extension (rails-safe, drafts only) but is out of scope for v1.
- No new account/mailbox: everything is the existing Brickell business inbox.
- The BrickellPay gateway "bug report" intake (`IR-…`) seen earlier was test data — deferred as an
  optional `gateway` recognizer.

## 3. Grounded recognizers (from the real `.msg` files)

| Job | Source | From (exact) | Identity / dedupe key | Link-out | Severity/status signal |
| --- | --- | --- | --- | --- | --- |
| `audit` | Secureframe | `hello@secureframe.com` (envelope `*.secureframe.com`) | test name | "View test in Secureframe" URL | subject/body: *Action required* / *new comment* → `at_risk`; *ready for review*/*passed* → `ok` |
| `exposed` | Defender for Cloud | `MSSecurity-noreply@microsoft.com` | `attackPathId` | "View the attack path" (Azure portal) | risk level Critical/High → `at_risk` |
| `exposed` | Defender for Endpoint | `defender-noreply@microsoft.com` | `CVE-id` | "View recommendations" | severity/CVSS → `at_risk` for High+ |
| `exposed` | BrickellPay PCI | `noreply@brickellpay.com` + subject `Tamper Detection` | URL + change-type | PCI dashboard URL | `SEVERITY: HIGH` → `at_risk` |
| `exposed` | Entra ID Protection | `azure-noreply@microsoft.com` | digest period | Entra admin center | non-zero risky users/sign-ins → `at_risk`; **0 → suppressed** |
| `gateway` | NMI | `support@nmi.com` (+ `*.nmi.com` agents) | NMI ticket # (`[NMI Ticket (\d+)]`) | `https://support.nmi.com/hc/requests/<#>` | latest message: *closing this ticket* → `resolved/ok`; question awaiting Brickell → `at_risk` |

Senders are config values (`config/account-types.json` recognizers), not hardcoded in code.

## 4. Architecture

No new infrastructure — three normalizers added to the existing registry plus a shared acknowledge
store.

```
scheduler.runTick → classifyFn → runNormalizers(classified, account, typeConfig, {reasonerFn, acks})
   registry adapters:  owed_risk · handled · audit · exposed · gateway
                                              │
                                              ▼
                          items (+ acknowledge state applied) → store → api → panel
```

- **Per-job normalizers** (`daemon/normalizers/{audit,exposed,gateway}.js`): pure
  `(classified, account, jobRules) => Item[]`. `exposed` delegates to per-source **recognizers** (one
  module each) so each email format is isolated and independently testable.
- **Recognizers** (`daemon/normalizers/exposed/{defender-cloud,defender-endpoint,pci-tamper,entra}.js`):
  pure `(email) => Finding | null`. The `exposed` normalizer runs every recognizer over the candidate
  emails, keeps non-null findings, dedupes by identity key, maps severity → status.
- **Acknowledge store**: `data/acknowledged.json` — a map of `itemId → { fingerprint, ackedAt }`.
  Applied after normalization: if an item's fingerprint matches its ack, status is forced to `ok`
  (acknowledged) and it drops out of the panel's "needs you". A changed fingerprint (new severity,
  reopened ticket, new auditor comment) clears the ack → it re-alerts.

## 5. Item shape (canonical, unchanged) + per-job specifics

All jobs emit the canonical Item (`id, jobType, account, title, status, group{rootCause,members}, source,
proposedActions, lastChanged`). Per-job notes:

- **`audit`**: `id = ${account}:audit:${slug(testName)}`; `group.rootCause = testName`; members = the
  auditor emails for that test; `proposedActions = ["route:secureframe"]`; `source` includes the
  Secureframe test URL.
- **`exposed`**: `id = ${account}:exposed:${identityKey}` (e.g. `…:exposed:CVE-2026-48778`,
  `…:exposed:attackpath:7a226bfd…`); `group.rootCause = identityKey`; `group.severity` carried for the
  UI; `source` = the portal link-out (+ thread ref); `proposedActions = ["route:source"]` where the
  recognizer supplies the URL.
- **`gateway`**: `id = ${account}:gateway:nmi:${ticket}`; `group.rootCause = "nmi:"+ticket`;
  `group.merchant` / `group.gwId` carried; members = thread messages; `source` = the NMI ticket URL;
  `proposedActions = ["route:nmi_ticket"]`.

`status` is `at_risk` only for genuinely open/actionable items; summaries and resolved/acknowledged
items are `ok` so they never inflate the panel's "N need you".

## 6. Acknowledge capability (shared)

- New executor `acknowledge` (in `daemon/executors/`): records `{itemId, fingerprint}` into the
  acknowledge store. It is **local-state only** — no mail, no external call — so it passes the executor
  rails-guard unchanged.
- Each `audit`/`exposed`/`gateway` item carries an `acknowledge` proposal in addition to its `route:*`
  proposal, so the panel shows an **Acknowledge** button next to **Open**.
- **Fingerprint** = a hash of the item's salient fields (severity + identity + latest-state marker), so
  re-alert fires precisely when the finding materially changes.
- The scheduler loads the ack store, passes it to `runNormalizers`, and applies it after normalization.

## 7. Noise handling

- Entra digest with 0 risky users/sign-ins → recognizer returns `null` (not surfaced).
- Sandbox/test entries (`sandbox.` URLs, subjects/bodies containing `Test … for Bug`, obvious
  non-production markers) → suppressed via a config `ignoreMarkers` list per job.
- Resolved NMI tickets and acknowledged findings → `status: ok`, excluded from "needs you" (still
  visible in drill-in if the user filters for them).

## 8. Actions & rails

- **route:** `route:secureframe` / `route:source` / `route:nmi_ticket` → the recognizer-supplied URL
  (executor returns `{kind:"route", url}`; existing `route:` executor handles it).
- **acknowledge:** local state only (§6).
- Rails intact: no send, no permanent-delete anywhere; the executor rails-guard still passes (the new
  `acknowledge` executor contains no mail API). External truth is always a link-out — exact Azure
  resource names, NMI thread detail, etc. live in the system of record and are never reconstructed.

## 9. Config

`config/account-types.json` → `<type>.jobTypes` gains `audit`, `exposed`, `gateway`, each with its
recognizer config (sender patterns, subject patterns, severity map, `ignoreMarkers`, link templates).
`config/companies.json` may carry per-account link bases where needed. Enable the three jobs on the
Brickell business account. Personal accounts keep only `handled`.

## 10. Error handling

- A recognizer that can't parse an email returns `null` (the email is simply not a finding) — never
  throws; one malformed email never blanks the job.
- Account/fetch failure → existing stale-account handling (Plan 1) retains last-good items.
- Acknowledge-store corruption → degrade to empty (treat nothing as acknowledged), mirroring the
  world-model store's corrupt-file tolerance.
- Status heuristics (gateway "resolved", audit "ready") are deterministic config-driven markers;
  ambiguous threads default to `at_risk` (fail toward surfacing, never toward hiding a real issue).

## 11. Testing

- Each recognizer: pure unit tests against fixtures derived from the real samples (sender + subject +
  body → expected Finding / null), including the noise cases (Entra 0, sandbox/test).
- Each normalizer: dedupe/grouping + severity→status mapping + acknowledge application.
- Acknowledge executor: records state, forces `ok`, re-alerts on fingerprint change; rails-guard test
  still passes with the new executor present.
- Registry/scheduler: a tick produces items for all enabled jobs; diff-gated emit + newAtRisk/staleFlips
  still hold with the new job-types present.
- Reuse the redacted sample bodies as fixtures (no real secrets committed).

## 12. Sequencing (implementation plans — controller-decided)

Three plans, in this order (live-impact first, hardest last):

1. **Plan 4 — `gateway` (NMI):** most operationally live (active threads, merchants waiting). One
   recognizer, ticket-thread grouping, status-from-latest-message. Includes the shared **acknowledge**
   capability (executor + store + panel button), since `gateway` is the first job that needs it.
2. **Plan 5 — `audit` (Secureframe):** small; two sub-types, per-test grouping, route to Secureframe.
3. **Plan 6 — `exposed`:** largest; four recognizers (Defender Cloud, Defender Endpoint, PCI, Entra)
   behind one normalizer, severity mapping, digest-noise suppression.

Each plan is independently shippable, follows the registry pattern, and ends green + merged.

## 13. Decisions locked

- Build all three (`audit`, `exposed`, `gateway`); sequence gateway → audit → exposed.
- Account: Brickell Payments business inbox; recognizers config-driven.
- Noise: surface only real/actionable; suppress 0-count digests + sandbox/test.
- Actions: route (link-out) + acknowledge (local); no API execution; NMI draft-reply deferred.
- Acknowledge via fingerprint, re-alert on change; ack store corrupt-tolerant.
- Designed for the class: NMI/TSYS/etc. are recognizers; gateway-bug `IR-…` intake deferred.

## 14. Open questions for planning

- Exact deterministic markers for `gateway` status ("resolved"/"waiting-on-you") — refine the keyword
  set against more real threads during Plan 4; default-to-`at_risk` keeps it safe meanwhile.
- Fingerprint field selection per job (which fields count as "materially changed").
- Whether `exposed` should emit a `handled`-style per-source "all clear" line (deferred unless wanted).
- Secureframe test-name slugging for stable ids across comment/action-required emails on the same test.
