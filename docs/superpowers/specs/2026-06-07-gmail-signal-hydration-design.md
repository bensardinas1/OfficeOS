# Gmail Signal Hydration — Design Spec

**Date:** 2026-06-07
**Status:** Approved by user; ready for implementation planning
**Builds on / motivated by:** `docs/superpowers/specs/2026-06-07-candidate-confidence-tier-design.md` (the confidence tier) and its shadow load test (below). The Outlook analog was Leak-2 (`mapOutlookMessage`, merged in `f038e0d`).

## Problem

The confidence tier's shadow load test (2026-06-07, 5,506 msgs live) showed `eligibleGroups: 0` at `scoreCutoff: 3` — the tier reclaimed nothing. Diagnosis of the bundle revealed the structural cause for the largest candidate lane:

**`personal` (Gmail, 1,275 candidates — the biggest lane) caps at `bulkScore` 2.** It can only ever score List-Unsubscribe (1) + marketing-subdomain (1). It never reaches the signals `detectBulkSignals` already knows how to score, because `build-bundle.js`'s Gmail fetch (`fetchAllGmail`) requests only `["From","Subject","Date","List-Unsubscribe"]` and discards `labelIds`. So the Gmail lane is blind to:

- **Gmail category labels** (`CATEGORY_PROMOTIONS` / `CATEGORY_FORUMS`) — the single strongest structural bulk signal Gmail offers, and exactly what `detectBulkSignals`' `gmail-category` check reads from `email.gmailCategories`.
- **`Precedence: bulk`** header.
- **`To`/`Cc`** recipients (the BCC signal — user not in To/Cc).

candidate `bulkScore` distribution from the load test:

| account | provider | 0 | 1 | 2 | 3 |
|---|---|---|---|---|---|
| healthcarema | outlook | 7 | 462 | 275 | 50 |
| brickellpay | outlook | 13 | 493 | 52 | 0 |
| summitmiami | outlook | 2 | 262 | 18 | 0 |
| personal | **gmail** | 204 | 856 | 215 | **0** |

**Root cause beyond the one call site:** three Gmail fetch sites have **divergent** per-message mapping, and they have drifted:

- `scripts/build-bundle.js` (`fetchAllGmail`): headers `From,Subject,Date,List-Unsubscribe`; **no** `gmailCategories`, `precedence`, or recipients. (The deficient one.)
- `scripts/fetch-gmail.js`: headers `…,Precedence`; `gmailCategories: res.data.labelIds` (**all** labels, unfiltered); no recipients.
- `scripts/triage.js`: headers `…,Precedence,To,Cc`; `gmailCategories: labelIds.filter(CATEGORY_*)`; recipients present. (The complete one.)

Fixing only `build-bundle` would leave the 3-way drift to recur. The durable fix is one shared mapper.

## Goal

Hydrate the same bulk signals from Gmail that Leak-2 hydrated from Outlook, via a single shared `mapGmailMessage` used by all three fetch sites — so `detectBulkSignals` can score genuinely-bulk Gmail mail ≥3, giving the confidence tier real signal on the Gmail lane. This is a **correctness / data-completeness** fix; it does not itself change the tier's cutoff or disposition logic.

## Non-goals

- **Tier `scoreCutoff` recalibration.** That is the existing graduation-gate process, run *after* this lands (re-run build-bundle, re-measure the distribution, validate false-trash). Out of scope here.
- Changing `detectBulkSignals` scoring logic — it already handles all these signals; it just wasn't receiving the data on the Gmail path.
- Switching Gmail fetch off `format: "metadata"` (no body parsing) or addressing the sequential-hydration perf TODO.
- Outlook path — already complete (`mapOutlookMessage`).

## Architecture & components

### New — `scripts/gmail-client.js`

Export `mapGmailMessage(messageResource, opts = {})` — pure, mirrors the exported `mapOutlookMessage`. Input: a Gmail `users.messages.get` resource fetched with `format: "metadata"` and `metadataHeaders: ["From","Subject","Date","List-Unsubscribe","Precedence","To","Cc"]`. Output: one normalized **superset** email object that satisfies all three current consumers:

```js
{
  id, threadId, subject,
  from, fromName,
  received,        // ISO from the Date header (raw string fallback if unparseable)
  receivedAt,      // ISO from internalDate when present, else `received`
  isRead,          // !labelIds.includes("UNREAD")
  importance,      // labelIds.includes("IMPORTANT") ? "high" : "normal"
  hasAttachments,  // (payload.parts||[]).some(p => p.filename?.length) — false in metadata-only
  preview,         // snippet, sliced to opts.previewLimit if given
  hasListUnsubscribe,        // !!List-Unsubscribe header
  precedence,                // header value lowercased, or "" 
  toRecipients, ccRecipients,// raw To/Cc header strings
  gmailCategories            // labelIds.filter(l => l.startsWith("CATEGORY_"))
}
```

Reconciliation decisions (where the three sites currently differ):
- **`gmailCategories` = `CATEGORY_*`-filtered** (triage's form), not raw labelIds (fetch-gmail's form). `detectBulkSignals` only inspects `CATEGORY_PROMOTIONS`/`CATEGORY_FORUMS`, so filtering is correct and removes noise.
- **`from`/`fromName`** = one robust `"Name <addr>"` parser; `fromName` empty string when no display name (callers keep their own fallback — e.g. triage's `fromName || from`). Bare-address `From` → `from = address`, `fromName = ""`.
- **`received`** standardized to **ISO** (fetch-gmail currently emits the raw Date header here — a safe, minor improvement). **`receivedAt`** prefers `internalDate` (epoch ms), preserving build-bundle's more-reliable basis. Both fields are emitted so every caller keeps the one it uses.
- **`precedence`** lowercased (so `detectBulkSignals`' `=== "bulk"|"list"` check matches).

### Modified — three fetch sites use the shared mapper

- **`scripts/build-bundle.js` (`fetchAllGmail`)** — widen `metadataHeaders` to the full set; replace the inline object with `mapGmailMessage(res.data)`. This is the call site that fixes the diagnosed tier blind spot.
- **`scripts/fetch-gmail.js`** — widen `metadataHeaders`; replace inline mapping with `mapGmailMessage`. (Behavior change: `gmailCategories` becomes `CATEGORY_*`-filtered instead of all labels; `received` becomes ISO. Both are safe/correct.)
- **`scripts/triage.js`** — replace inline mapping with `mapGmailMessage`. Already fetches the full header set; output shape must stay equivalent (it is the reference for the superset). Preserve triage's downstream `fromName || from` usage.

Each site keeps its own list/pagination/concurrency and output concerns; only the per-message field extraction is centralized.

### Why this fixes the diagnosis

A `personal` promo currently scoring 2 (List-Unsubscribe + marketing-subdomain) will, once the category label / precedence / BCC are hydrated, reach 3–4 — moving genuine Gmail blasts above a meaningful tier cutoff, so the 1,275-candidate Gmail lane stops being structurally invisible to the tier.

## Data flow (unchanged except richer Gmail emails)

```
gmail.users.messages.get(format:metadata, full headers) → mapGmailMessage(res)
  → normalized email with gmailCategories / precedence / to+cc / list-unsub
  → detectBulkSignals(email, myEmail) can now reach score ≥3 on bulk Gmail
  → (build-bundle) candidate bulkScore → confidence tier has real Gmail signal
```

## Error handling

`mapGmailMessage` must not throw on missing fields (mirror `mapOutlookMessage`'s defensiveness): absent headers → empty strings; missing `labelIds` → `[]` (so `gmailCategories` is `[]`, `isRead` true, `importance` "normal"); missing `internalDate` → fall back to the Date header for `receivedAt`; unparseable Date → keep the raw string for `received`.

## Testing

**New — `scripts/test/gmail-client.test.js`** (mirror `mapOutlookMessage`'s tests):
- Extracts subject/from/fromName from `"Name <addr>"` and from a bare address.
- `gmailCategories` = `CATEGORY_*` only (drops `INBOX`, `UNREAD`, `IMPORTANT`, etc.).
- `precedence` lowercased; `toRecipients`/`ccRecipients` from headers; `hasListUnsubscribe` boolean.
- `receivedAt` from `internalDate`; falls back to Date header when `internalDate` absent.
- Missing headers / missing `labelIds` / missing `internalDate` → no throw, correct defaults.
- **Integration with the scorer:** a Gmail promo with `CATEGORY_PROMOTIONS` + List-Unsubscribe + `Precedence: bulk` + user-not-in-To yields `detectBulkSignals(mapGmailMessage(m), myEmail).score >= 3` (the whole point).

**Behavior-preservation (the main risk) — the three consumers must not regress:**
- Run the existing suite green (`fetch-sent-emails`, `gmail-verify`, `morning-brief`, etc.).
- Confirm `triage.js` output shape is unchanged for its consumers (esp. `fromName` fallback, `isRead`, `importance`, `gmailCategories` already `CATEGORY_*`-filtered there). If `triage.js`/`fetch-gmail.js` lack direct unit tests, add a focused mapper-substitution test or assert via `morning-brief` fixtures.

## File structure summary

**Create:**
- `scripts/test/gmail-client.test.js`.

**Modify:**
- `scripts/gmail-client.js` — add `export function mapGmailMessage(...)` (file already exists with `buildGmailClient`).
- `scripts/build-bundle.js` (`fetchAllGmail`: widen headers, use mapper)
- `scripts/fetch-gmail.js` (widen headers, use mapper)
- `scripts/triage.js` (use mapper)

**New runtime behavior:** richer Gmail emails carry `gmailCategories`/`precedence`/recipients downstream; no schema change to bundles/config.

## Validation (post-implementation, manual — the existing graduation gate)

After this lands: re-run `node scripts/build-bundle.js --since 30d` in the main repo, re-inspect the candidate `bulkScore` distribution (expect `personal` to now populate score 3–4), then recalibrate the tier `scoreCutoff` and run the `/issues` shadow + `tier-audit` false-trash gate. That decides whether the tier graduates to `active`.

## Open questions

None. All decisions locked.
