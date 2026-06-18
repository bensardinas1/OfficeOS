# Tile Context + Inbox Grouping + Drill-Down Detail — Design

**Date:** 2026-06-18
**Status:** Approved (design)
**Surface:** Ambient Proposal Panel (`daemon/web/`)

## Problem

The panel renders every item as a flat, interleaved list of tiles. Two gaps:

1. **No context on a tile.** A tile shows title + a one-line `meta` (`rootCause · members`). It does not say *which inbox* the item came from or *who the sender is*, so the user can't orient without opening the underlying email elsewhere.
2. **No way to see detail.** The full per-message detail (subjects, senders, dates, link-outs) already exists in `item.group.members` and `item.source`, but nothing renders it beyond the single `meta` line.

## Goals

- Group tiles by **inbox** (account) with section headers, so "which inbox" is answered structurally.
- Give each tile lightweight context: **sender · latest date · message count** (plus the existing jobType).
- Add a **slide-in side panel** drill-down showing per-item detail on demand.
- Keep the panel zero-dependency vanilla JS/CSS, consistent with the existing implementation.
- Preserve all rails and existing behavior (approve/open/acknowledge/dismiss, SSE live updates, acknowledgements).

## Non-Goals

- No new fetch/connector work — all data needed is already fetched (`from`, `fromName`, `receivedAt` are on the email objects).
- No change to classification, grouping, proposals, executors, notifier, or the REST/SSE API surface.
- No persistence of UI state (collapse, open panel) across reloads.

## Decisions (resolved during brainstorming)

- **Drill-down style:** slide-in side panel (from the right, over a dim backdrop).
- **Tile context fields:** account (via section header, not a per-tile badge) + primary sender + latest date + message count.
- **List layout:** grouped by inbox, sections ordered most-at-risk first, empty sections omitted, headers collapsible (expanded by default).
- **`handled` summary tiles:** shown *inside* each inbox's section (they remain status `ok` and do not inflate the section's need-you count).

## Architecture

Five layers change; each keeps its current responsibility.

### 1. Data layer — pass sender/date through to members

Recognizers already see `email.from`, `email.fromName`, `email.receivedAt`; the normalizers drop them when building `group.members`. Add the missing fields:

- `daemon/normalizers/gateway.js` — add `from`, `fromName` to each member (already has `subject`, `emailId`, `receivedAt`).
- `daemon/normalizers/audit.js` — add `from`, `fromName` to each member (already has `subject`, `emailId`, `receivedAt`).
- `daemon/normalizers/exposed.js` — add `from`, `fromName` to each member (already has `subject`, `emailId`, `receivedAt`).
- `daemon/normalizers/owed-risk.js` — add `receivedAt` and `fromName` to each member (already has `vendor`, `from`, `subject`, `emailId`). `fromName` keeps the member shape uniform across all jobs so the detail panel renders friendly sender names (not just for the `vendor`-derived tile sender).

**Member shape after this change:** `{ subject, emailId, receivedAt, from, fromName }` (owed_risk additionally keeps `vendor`).

**Invariants preserved:**
- `fingerprint(item)` hashes `id + status + title + rootCause` only — it does **not** read members — so adding member fields does **not** invalidate existing acknowledgements.
- Item shape changes, so the scheduler's shape diff re-stamps `lastChanged` once on the first tick after deploy. Harmless.

### 2. Scheduler — surface account label + type

`scheduler.js` writes `accountsState[account.id] = { status, lastTickAt }`. The panel needs a human label and the account type for the section header. Add them in both the ok branch and the stale branch:

```js
accountsState[account.id] = {
  status: "ok",
  lastTickAt: clock.now,
  label: account.label || account.name || account.id,
  accountType: account.accountType,
};
```

(Use whichever display field the `companies.json` account record actually carries; confirm the field name when writing the plan and fall back to `account.id`.)

### 3. View-model — keep groups, derive tile-display fields

`view-model.js` already builds `groups` (one per account) but currently flattens them for the workbench. Changes:

- `toPanelView(model)`:
  - Attach `item.display = { primarySender, latestDate, messageCount, accountLabel, accountType }` to every item, derived purely from `group.members` and `model.accounts[item.account]`:
    - `messageCount` = `members.length`
    - `latestDate` = max `receivedAt` across members (ISO string or null)
    - `primarySender` = most frequent `fromName || from` among members; tie-break = first; for `owed_risk` use `vendor || fromName || from`; null if none.
    - `accountLabel` / `accountType` = from `model.accounts[item.account]` (label falls back to the account id). **Carrying these on `item.display` is what lets `renderDetailPanel(item, nowMs)` show the inbox label without being handed the group** — `render.js` is pure and the item is the only thing it receives.
  - Surface `label` and `accountType` on each group from `model.accounts[account]` (for the section header).
  - Add `atRiskCount` per group (count of `status === "at_risk"` items) for the section header and for ordering.
  - Order `groups` by `atRiskCount` descending (tie-break: account id, stable).
- New helper `findItem(view, id)` → the item object (with `display`, which carries `accountLabel`/`accountType`) or null, for the detail panel. No need to also return the group — the label travels on `item.display`.
- `filterItems` (or a new `filterGroups`) applies the query *within* groups and drops groups left empty after filtering.

All of `view-model.js` stays node-API-free (imported by tests and browser alike).

### 4. Render — sections, simpler tile, detail panel

`render.js` (pure HTML-string builders):

- `relativeTime(iso, nowMs)` — new pure helper; param-injected clock so tests are deterministic. Buckets: `just now`, `Nm ago`, `Nh ago`, `Nd ago`, else short date.
- `renderItemCard(item, nowMs)`:
  - Header row: jobType chip · `relativeTime(item.display.latestDate, nowMs)`.
  - Title (unchanged).
  - Subline: `primarySender · N message(s)`.
  - Actions row: existing Approve / Open / Acknowledge / dismiss **plus** a `Details` button (`data-detail="<item.id>"`).
  - **No account badge** (the section header owns the inbox identity).
- `renderAccountSection(group, collapsed, nowMs)` — new. Takes an explicit `collapsed` boolean (render.js is pure and cannot read `app.js` UI state). Collapsible header (`data-collapse="<account>"`) showing `label` · `accountType` · `N need you` (the `atRiskCount`) with a chevron reflecting `collapsed`; when `collapsed` the body (item cards) is omitted. `handled` summary tiles render here alongside the rest. `app.js` passes `ui.collapsed.has(group.account)`.
- `renderDetailPanel(item, nowMs)` — new. The slide-in content:
  - Metadata grid: inbox (`item.display.accountLabel`), root cause, status, and job-specific fields when present (`merchant`/`gwId` for gateway, `severity` for exposed).
  - Per-message list from `group.members`: `subject` · `fromName || from` · formatted `receivedAt`.
  - Link-out(s) from `item.source` where `kind === "url"` (guarded by `safeUrl`).
  - A close button (`data-detail-close`).
- `esc` / `safeUrl` unchanged and applied to all interpolated sender/subject/url strings.

### 5. Behavior + style

`app.js` (thin DOM glue):
- UI state adds `ui.collapsed` (a `Set` of collapsed account ids) and `ui.detailItemId` (string or null).
- `draw()` renders header → filter input → bulk controls → sections (`renderAccountSection` per group) → detail panel + backdrop when `ui.detailItemId` is set.
- Click delegation adds:
  - `data-detail` → set `ui.detailItemId`, `draw()`.
  - `data-detail-close` / backdrop click → clear `ui.detailItemId`, `draw()`.
  - `data-collapse` → toggle the account id in `ui.collapsed`, `draw()`.
- `Escape` keydown closes an open panel.
- On SSE reload: re-`load()` as today; in `draw()`, if `ui.detailItemId` is set but `findItem` returns null (item resolved/acked away), clear it (panel closes automatically).
- `nowMs` for `relativeTime` is `Date.now()` passed from `app.js` into render functions.

`styles.css`:
- Section header (clickable, with a chevron affordance reflecting collapsed state).
- Off-canvas detail panel: fixed to the right, `transform: translateX(100%)` → `0` when open, with a dim backdrop. (Real browser page — `position: fixed` is fine here, unlike the mockup sandbox.)
- Tile subline + jobType chip styling. Status accent (at_risk) retained.

## Data Flow

```
fetch-emails.js (from/fromName/receivedAt already present)
  → classify → normalizers (now copy from/fromName/receivedAt into members)
  → scheduler (stamps account label/type) → store world-model.json
  → GET /model → view-model.toPanelView (groups + item.display + atRiskCount)
  → render (sections → cards → detail panel) → app.js (collapse + detail state)
```

## Error Handling / Edge Cases

- **Missing sender/date:** members may lack `from`/`receivedAt` (e.g. older cached items pre-deploy, or `handled` summaries). Derivations return null and render falls back gracefully (omit the subline field; `relativeTime(null)` → empty).
- **Empty section after filter:** omitted, no empty header.
- **All clear:** if no groups have items, show the existing "All clear." empty state.
- **Open panel for a vanished item:** auto-close on the next draw.
- **Account with no label field:** falls back to `account.id`.

## Testing

- **view-model.test.js:** primarySender frequency + tie-break + owed_risk vendor path; latestDate max; messageCount; group label/type/atRiskCount; group ordering most-at-risk-first; `findItem` hit/miss; `filterItems`/`filterGroups` drops empty sections.
- **render.test.js:** card renders jobType chip + sender + count + relative date + Details button and **no** account badge; `renderAccountSection` header shows label/type/need-you count and contains its cards; `renderDetailPanel` lists members and url link-outs and a close button; `relativeTime` buckets; `esc` applied to sender/subject.
- **normalizer tests:** gateway/audit/exposed members include `from`/`fromName`; owed_risk members include `receivedAt`.
- Full suite must stay green (currently 479/479).

## Files Touched

- `daemon/normalizers/gateway.js`, `audit.js`, `exposed.js`, `owed-risk.js`
- `daemon/scheduler.js`
- `daemon/web/view-model.js`, `render.js`, `app.js`, `styles.css`
- Test siblings: `daemon/web/view-model.test.js`, `daemon/web/render.test.js`, and the relevant normalizer `.test.js` files.

## Rails (unchanged, must remain enforced)

- Never auto-send — drafts only.
- Soft-delete only.
- Link-out to the system of record; never fabricate resource identifiers.
