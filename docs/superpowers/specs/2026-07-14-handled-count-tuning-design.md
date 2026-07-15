# Handled-Count Tuning + Config Validator (Cluster C) — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorm complete)
**Context:** The handled tiles' "need a reply" counts are inflated — live model shows
healthcarema at 124 and brickellpay at 32, when the honest number is a fraction of
that. Diagnosis against live data found four stacked mechanisms:

1. The user's own mail counts. `{"type":"domain","value":"healthcarema.com"}` is a
   prioritySender, so ALL internal mail — including 33 visible tile members from
   bsardinas@healthcarema.com itself — classifies actionable, and the user's own
   address passes the "looks human" check.
2. Urgency flags match as raw substrings of subject+preview. Flags like "need",
   "request", "hold" fire on "needed", "no need to reply", "shareholder".
   healthcarema's config literally says "All requests are urgent for now — refine
   later."
3. `looksAutomated` checks only the sender local-part (plus List-Unsubscribe), so
   `capitalone@notification.capitalone.com` and
   `americanexpress@welcome.americanexpress.com` read as human — the automation
   signal is in the domain, a pattern `detectBulkSignals` already knows via
   `MARKETING_SUBDOMAINS` but this check never consults.
4. No reply-awareness: a thread the user already answered keeps counting every
   inbound message within the lookback.

**Decisions locked during brainstorm:**
- Reply-awareness = conversation-aware (use B2's `conversationId` plumbing); not
  simple own-address exclusion, not sent-items correlation.
- Fix the urgency matcher to word-boundary semantics AND curate per-account flag
  lists (curation is a live `config/companies.json` edit — never committed).
- Urgency flags are **scoped to senders with standing** (correspondents,
  prioritySenders, own domain) — cold outreach cannot keyword itself into
  "needs a reply". Chosen over unscoped flags and over a first-touch exception.
- Config validator runs warn-and-continue: daemon starts, findings logged and
  surfaced as a panel warning strip; malformed rules are skipped, valid ones apply.

---

## Component 1 — Conversation-aware needsYou (daemon/normalizers/handled.js)

The unit of counting changes from messages to **conversations** — the honest
number of distinct threads awaiting the user.

Pure helper in `handled.js` (exported for tests):

```
countConversations(actionableEmails, myEmail)
  -> { needsYou, waiting }   // conversation counts, not message counts
```

Rules:
- Group actionable-category emails by `conversationId`; an email lacking
  `conversationId` forms a singleton conversation keyed by its email id.
- Within each conversation, order by `receivedAt` (ISO string compare, matching
  existing member sort). Find the newest **non-automated** message
  (`looksAutomated` is the existing verdict, upgraded by Component 3).
- The conversation **needs you** iff that newest non-automated message exists and
  its `from` is not `myEmail` (case-insensitive exact match).
- A conversation whose newest non-automated message is from `myEmail` (user had
  the last word), or which contains only automated messages, counts into
  **waiting** (as one conversation).
- Non-actionable categories keep today's semantics: their emails count into
  `waiting` per-message (they are informational volume, not threads awaiting a
  decision). `group.counts` therefore stays `{needsYou, waiting}` with needsYou
  now conversation-denominated.

Title copy (render unchanged — the normalizer already owns the title):
- `N conversation(s) need a reply` / `1 conversation needs a reply`
- zero → `Nothing needs a reply` / `Inbox clear` exactly as today.
- Subtitle stays `+ N informational` (waiting = mixed conversations + messages;
  the word "informational" already covers both).

Members, CAP 50, moreCount, drill-in grouping: unchanged (B2's
`groupHandledMembers` already displays by conversation).

`normalizeHandled` needs `account.myEmail` — it already receives the account
object; no signature change.

## Component 2 — Word-boundary urgency matcher + curated flags

### Matcher (scripts/classify-emails.js)

`matchesUrgencyFlags(email, flags)` compiles each flag to a boundary-anchored
regex, case-insensitive, regex-escaped:

```
new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i")
```

- Word characters for boundary purposes are `[a-z0-9]` — so "need" matches
  "we need this" and "need-by date" but not "needed" or "kneading"; "hold" no
  longer fires on "shareholder"; "audit" no longer fires on "auditorium".
- Multi-word flags ("ACH hold", "call me", "close of escrow") match as phrases:
  internal whitespace in the flag matches any whitespace run (`\s+`), boundaries
  applied at both ends.
- Same function everywhere — triage category routing and account-level urgency
  routing both improve. This is a deliberate global semantics change (approved).

### Flag scoping — flags only promote senders with standing

Rationale: a genuine marketing blast is stopped by the bulk-signal gate before
flags run, but cold outreach from a plain mailbox ("Call me about your
underwriting", no List-Unsubscribe, addressed To: you) scores below the bulk
threshold and would keyword itself into action. Flags therefore only fire when
the sender has **standing**:

```
senderHasStanding(email, account, correspondents) -> bool
```

true when any of (all case-insensitive):
- sender's address is in the account's correspondents set (sent-mail derived —
  already loaded by `classify()`),
- sender matches the account's `prioritySenders` (existing `matchesSender`),
- sender's domain equals `account.myEmail`'s domain.

In `classifyEmail`, the account-level urgency-flag step (step 4) requires
`senderHasStanding` before routing to action/respond. Category-level
`urgencyRules` (rich category overrides, step 4 of the override loop) get the
same standing gate — same reasoning, same mechanism. Senders without standing
fall through to the account-type default (`fyi` for business) and count as
informational, never needsYou. `classifyEmail` gains a `correspondents`
parameter (already available at the `classify()` call site; tests pass a Set).
Note: prioritySenders continue to route to action *directly* (step 3) — the
standing gate changes nothing for them; it only gates keyword promotion.

### Flag curation (live config edit, applied during implementation, not committed)

Proposed per-account lists — final values confirmed with the user at apply time:

- **healthcarema** (drop bare "request", "question", "need"):
  `["urgent", "call me", "please review", "deadline", "asap"]`
- **brickellpay** (drop bare "hold" — "ACH hold" already covers the meaningful
  case; word boundaries make the rest safe):
  `["ACH hold", "account termination", "terminated", "boarding issue",
    "underwriting", "account review", "audit", "risk alert", "chargeback",
    "reserve", "retrieval", "suspended", "declined"]`
- **summitmiami** (drop bare "deal", "title", "contract" — too generic even with
  boundaries; keep transaction-specific terms):
  `["closing", "close of escrow", "due diligence", "wire", "lender",
    "commitment", "inspection", "deadline", "urgent"]`
- **personal**: stays `[]`.

Also update each account's `urgencyRules.currentRule` prose to describe the
curated intent (healthcarema's "refine later" note is now stale).

## Component 3 — Domain-aware looksAutomated (scripts/sender-guards.js)

- Move the marketing-subdomain prefix list into `sender-guards.js` as the single
  exported source: `export const MARKETING_SUBDOMAINS = ["mail.", "email.",
  "news.", "marketing.", "updates.", "info.", "noreply.", "notification.",
  "notifications.", "welcome.", "alerts.", "reply.", "e."]` (superset of the
  bulk detector's current list; `classify-emails.js` imports it instead of
  defining its own).
- `looksAutomated(senderEmail, hasListUnsubscribe)` returns true when any of:
  List-Unsubscribe present; local-part matches `AUTOMATED_LOCALPART` (existing);
  **new:** sender domain starts with one of `MARKETING_SUBDOMAINS`.
- Effects: such senders leave the needsYou count (Component 1 treats them as
  automated) and move from the drill-in's Conversations section to Bulk senders,
  where their delete/kill controls live. `detectBulkSignals` behavior is
  unchanged in kind (same signal, shared list).

## Component 4 — Config validator (new scripts/validate-config.js)

Pure function, no I/O:

```
validateConfig(companies, accountTypes)
  -> [{ level: "error"|"warning", path: "companies[healthcarema].prioritySenders[3]", message }]
```

Checks (errors = structurally unusable, the rule will be skipped; warnings =
suspicious but functional):
- **error** — account missing/empty `id`, `provider` not `outlook`/`gmail`,
  `accountType` referencing a key absent from `account-types.json`, `myEmail`
  not shaped like an email.
- **error** — sender rule (in `prioritySenders`, `neverDelete`, `alwaysDelete`,
  per-category `prioritySenders`) with unknown `type` (known: `email`, `domain`,
  `name`, `keyword`) or missing/empty/non-string `value`.
- **error** — `urgencyRules.flags` not an array, or containing empty/non-string
  entries.
- **warning** — duplicate account ids; the same normalized sender value present
  in both `alwaysDelete` and `neverDelete` on one account (conflict:
  neverDelete wins at runtime, but the config is contradictory);
  `bulkSignalThreshold` present but not a positive number.
- The validator never throws on malformed input — worst case it returns findings.

### Daemon integration (daemon/daemon.js + daemon/api.js)

- Run at startup and on each tick's config load. Findings:
  - logged once per change (log event `config-findings`, deduped by hash so a
    stable set of findings doesn't spam every 15 minutes),
  - stored on the model as `configFindings: [...]` and served in `GET /model`.
- Classifier hardening: rules that would produce an error finding are skipped by
  the classifier's matchers rather than crashing (matchesSender/matchesDownrank
  already tolerate most shapes; add the guards the validator identifies).

### Panel surface (daemon/web/render.js + app.js + styles.css)

- New `renderConfigWarnings(findings)` strip under the stale banner: collapsed
  one-liner `⚠ config: N issue(s)` — click toggles the expanded list showing
  `path — message` per finding. Rendered only when findings exist. Same visual
  family as `.stale`. No POST endpoints; purely informational.

## Testing

- `countConversations`: dense unit suite — grouping, singleton fallback,
  newest-non-automated selection, own-address last word, automated-only
  conversation, mixed actionable/non-actionable categories, case-insensitive
  myEmail, missing receivedAt.
- `matchesUrgencyFlags`: boundary semantics ("need" vs "needed", "hold" vs
  "shareholder"), phrase flags with irregular whitespace, regex-special
  characters in flags, case-insensitivity.
- `senderHasStanding` + gating: correspondent hit, prioritySender hit, own-domain
  hit, stranger with flagged keywords lands in fyi (account-level AND
  category-level paths), prioritySender direct routing unaffected by the gate.
- `looksAutomated`: domain-prefix hits (notification., welcome.), non-marketing
  domains unaffected, existing local-part/List-Unsubscribe behavior preserved;
  `detectBulkSignals` still fires marketing-subdomain via the shared list.
- `validateConfig`: each check's error and clean cases, malformed top-level
  shapes (null account, missing arrays) return findings without throwing.
- `normalizeHandled`: title copy for 0/1/N conversations, counts wired to
  `countConversations`.
- Render/contract: warning strip renders findings + toggle attribute pair
  emitted/selected; hidden when clean.
- e2e (fake connectors): seeded fixture includes a multi-message conversation
  where the user replied last → asserts the count excludes it.

## Safety rails

- No mail-touching code paths change; this cluster is counting, classification,
  and validation only. Soft-delete/no-send invariants untouched.
- Config curation edits `config/companies.json` live with user confirmation and
  is never committed (gitignored, per CLAUDE.md).
- Validator is warn-and-continue by design — a config typo degrades one rule,
  never the daemon.

## Out of scope

- Sent-items correlation (rejected in brainstorm — conversation-aware chosen).
- Urgency-flag editing UI in the panel (config file remains the interface).
- Per-category triage re-bucketing beyond what the shared matcher fix causes.
- Notification/digest changes based on the new counts.
