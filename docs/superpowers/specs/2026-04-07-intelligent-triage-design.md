# Intelligent Triage — Design Spec

**Date:** 2026-04-07
**Status:** Approved
**Approach:** A (Smart Middle) designed to evolve toward B (Claude Classifies Everything)

## Problem

The current triage system is a deterministic rule engine. The `triage.js` script does all classification via static JSON rules (`neverDelete`, `alwaysDelete`, `prioritySenders`, `urgencyRules`). Claude's role is reduced to displaying output, parsing deletion selections, and running bash commands.

This creates three failures:
1. **No learning.** When the user says "Ari Rollnick is a friend," it becomes a JSON array entry — not understanding.
2. **No judgment.** Emails the script has no rule for get dumped into FYI or deletion candidates with no reasoning.
3. **No path to autonomy.** The system can never reply, draft, or act on email because it doesn't understand the user's world.

The system evolved this way because the original Claude-classifies-everything approach was burning thousands of tokens per triage session. The pendulum swung to pure automation. Neither extreme is right.

## Vision

OfficeOS learns to be a digital version of the user. Email triage is the safe sandbox — low stakes, rich signal. The system observes first (triage), then acts (reply/interact). Every skill in OfficeOS draws from the same well of accumulated understanding.

## Design Principles

- **One brain, eventually.** Claude should be the source of classification judgment. The script handles mechanical work (fetch, header analysis, formatting).
- **Token budget is real.** Intelligence must be added without repeating the original cost failure. Claude reasons about 20-40% of emails today, growing toward 100% as memories accumulate.
- **Memory over config.** Rich contextual memories that Claude reasons about naturally, not JSON arrays that a script pattern-matches against.
- **Presentation is rigid, judgment is fuzzy.** Classification can have variance. Workflow rules (full deletion list, batch execution, no per-email approval, token efficiency) are inviolable.
- **Explicit over inferred.** User statements are captured immediately. Inferred patterns are proposed, not assumed.

## Architecture

### 1. Attention Profile

A compact markdown document (~50-100 lines) loaded every triage session. Lives at `config/attention-profile.md`.

**Contains:**
- User's role across each company and relationship to the work
- Key people with context (not flat lists — why they matter)
- Organizations and involvement level
- Judgment principles expressed as prose ("GitHub PR bot notifications are noise unless I'm personally tagged")
- Hard workflow rules

**Does not contain:**
- Credentials, OAuth tokens, API config (stays in `companies.json`)
- Detailed memories about specific people (stays in memory files)
- Mechanical detection rules like bulk signal thresholds (stays in script)

**Format:** Markdown prose, not JSON. Claude reasons about prose better than arrays. "George Gabela handles LOIs for Healthcare M&A acquisitions — his emails are always action items" is more useful than `{ "type": "name", "value": "George Gabela", "label": "Partner" }`.

**Maintenance:** Claude updates it when the user shares durable truths about their world. Not after every session. The user can review and edit it directly.

### 2. Memory Layer

The existing memory system (`memory/`) expands to store learned context about the user's world. Individual memory files are loaded selectively — not in bulk.

**Three types of triage-relevant memories:**

**Relationship memories** — People Claude learns about through interactions.
- Example: "Ari Rollnick — old friend of Ben's, reaches out through Healthcare M&A email. Keep his emails even when they look cold-outreach-ish."
- Created when the user says something ("Ari is a friend").

**Pattern memories** — Judgment calls learned from deletion selections, captured only when confidence is high (3+ sessions showing the same pattern).
- Example: "GitHub PR bot notifications (coderabbitai, github-code-quality, chatgpt-codex-connector): Ben consistently deletes these but keeps human comments from his dev team."
- Always proposed to the user before saving. Never written silently.

**Context memories** — Situational knowledge that affects triage temporarily.
- Example: "SEUSKF Shinpan seminar May 2-3 in Virginia — Iaido emails about this event are high priority right now."
- Can expire when the situation passes.

**What this replaces over time:**
- `neverDelete` arrays → relationship memories + attention profile
- `alwaysDelete` arrays → pattern memories
- `prioritySenders` → attention profile + relationship memories
- `categoryOverrides` → attention profile principles

The JSON config doesn't disappear overnight. The script still uses it for its mechanical first pass. As Claude handles more classification, those arrays become less relevant.

### 3. Classification Pipeline

**Current:**
```
Fetch → Script classifies ALL → Script formats → Claude displays
```

**New:**
```
Fetch → Script handles obvious ends → Claude classifies the middle → Script formats → Claude displays
```

**Step by step:**

1. **Claude calls the script** to fetch and pre-filter: `node scripts/triage.js --raw {accountIds} {hours} {maxGmail}`. The `--raw` flag tells the script to return JSON data instead of formatted markdown.

2. **Script fetches emails** — unchanged internals. Graph API for Outlook, Gmail API for Gmail. Returns normalized email objects with metadata and bulk signals.

3. **Script runs mechanical filters** — fast, deterministic, zero tokens:
   - Bulk signal detection (List-Unsubscribe, Precedence, BCC, marketing subdomains)
   - Known spam patterns (verification codes, OTP, "% off" subjects)
   - Tags each email: `{ confidence: "high-delete" | "high-keep" | "uncertain", reason: "..." }`

4. **Script returns structured JSON to Claude** — three arrays: `highDelete`, `highKeep`, `uncertain`. Each email includes: `{ id, sender, subject, bulkSignals, isRead, hasAttachments, accountId }`. No email bodies.

5. **Claude loads attention profile and classifies the uncertain bucket.** For ambiguous emails, Claude reads the MEMORY.md index and loads specific memory files whose descriptions match the sender, organization, or domain in question. Claude assigns each uncertain email: category, deletionCandidate (true/false).

6. **Claude formats and presents the final output** — merging the script's high-confidence decisions with its own classifications. Claude applies the presentation rules (action items, FYI, deletion candidates with full numbered list) and saves `data/pending-deletions.json`.

**Orchestration:** Claude is the orchestrator. The script is a data tool Claude calls, not the other way around. This matches the Claude Code skill model — skills are instructions for Claude, not wrappers around scripts.

**Token budget:** ~40 uncertain emails across 4 accounts = attention profile (~100 lines) + email metadata (~120 lines) + selective memories (~50 lines) ≈ 2,000-3,000 tokens input for classification.

**Fallback:** If Claude is unavailable or context is constrained, the script's mechanical filters are a complete fallback. Uncertain emails get dumped into FYI. System degrades gracefully.

**Evolution toward B:** The script's confidence thresholds are tunable. Today the script handles ~60-70% confidently. As memories grow, thresholds tighten — script handles less, Claude handles more. Eventually the script only provides metadata and hands everything to Claude.

### 4. Feedback Capture

**Explicit statements** — captured immediately as memories.
- "Ari is a friend" → relationship memory, written now.
- "GitHub bot emails are trash" → pattern memory, written now.
- No confirmation needed for explicit statements.

**Deletion selections** — logged to `data/triage-log.md` (gitignored, local only).
- Appended after each triage session: date, accounts, what was kept from deletion list, what was deleted, any explicit statements.
- Cheap — a few lines per session, no analysis.

**Pattern recognition** — periodic, not every session.
- Triggered by user ("What have you learned?") or by natural threshold (every ~10 sessions, Claude asks once if you want analysis).
- When triggered, Claude reads the log, identifies stable patterns, proposes memories before saving.
- User confirms or rejects each proposed memory.

**Triage log format:**
```markdown
## 2026-04-07
Accounts: healthcarema, brickellpay, summitmiami, personal
Kept from deletion list: #5 (Ari Rollnick), #6 (voicemail Rollnick), #38 (Hurricane Club)
Explicit: "Ari Rollnick is a friend" → memory written
Deleted: 34 emails across 3 accounts
```

### 5. Deletion Workflow

**Unchanged.** Claude presents the full numbered deletion candidate list. User replies with numbers or ranges. Claude executes batch deletions per account. Reports results. This is a hard workflow rule — no compression, no summarization, no per-email approval.

## What Changes vs. What Stays

| Component | Today | After |
|-----------|-------|-------|
| Email fetching | `triage.js` via APIs | Unchanged |
| Bulk signal detection | `triage.js` header analysis | Unchanged (mechanical) |
| Classification intelligence | Static JSON rules in config | Claude reasoning from attention profile + memories |
| Deletion candidate selection | Script pattern matching | Claude judgment for uncertain emails; script for obvious ends |
| Presentation/formatting | Script markdown output | Unchanged |
| Deletion execution | Script via delete-emails.js | Unchanged |
| User knowledge | `neverDelete`/`alwaysDelete` arrays | Attention profile + relationship/pattern memories |
| Learning | None | Explicit capture + periodic pattern analysis |
| Workflow rules | Enforced by orchestrator skill | Unchanged — still enforced |

## Config Migration

The JSON config (`companies.json`, `account-types.json`) stays functional throughout. It serves as:
- The script's mechanical filter rules (bulk thresholds, downrank terms)
- API credentials and account metadata
- Fallback classification when Claude isn't in the loop

Over time, classification-related arrays (`neverDelete`, `alwaysDelete`, `prioritySenders`, `categoryOverrides`) become vestigial as memories and the attention profile take over. They don't need to be removed — they just stop being the source of truth for judgment calls.

## Out of Scope

- Email body analysis (too expensive for triage)
- Automatic email replies or drafting (future skill, builds on this foundation)
- Real-time learning during triage (pattern analysis is periodic, not per-session)
- Changes to the fetch layer or API integrations
- Removal of existing config structure
