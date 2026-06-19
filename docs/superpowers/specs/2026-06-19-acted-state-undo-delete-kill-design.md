# Acted-State Indicator + Per-Row Undo + "Delete and Kill" — Design

**Date:** 2026-06-19
**Status:** Approved (design)
**Surface:** Ambient Proposal Panel (`daemon/`, `daemon/web/`)

## Problem

After a Delete or Add-to-Kill-List, the only feedback is a transient bottom notice — you can't see *which* item you acted on, and there's no way to undo a delete/kill from the panel (the existing Undo snackbar only covers Dismiss/Acknowledge). The user wants: the acted item visibly marked, a per-item **Undo**, and a combined **"Delete and Kill"** action.

## Goals

- After acting, the item **dims + strikes through** with a badge — "Deleted", "Kill-listed", or "Deleted + kill-listed" — and its normal buttons are replaced by an **Undo**.
- **Undo** reverses the exact action(s): restore the email from Trash and/or remove the sender from the kill-list.
- A **"Delete and Kill"** button (on detail rows and tiles) does both in one two-click confirm.
- Rails preserved; no auto-send.

## Decisions (from brainstorming)

- Acted style: **dim + strikethrough + badge, in place, with an Undo button**.
- "Delete and Kill" appears on **both detail message rows and tiles**.
- Undo is per-item (distinct from the dismiss/ack snackbar).

## Architecture

### Reverse operations (new)
1. **Restore from Trash** (undo delete) — rails-safe move, not a send/permanent op:
   - `scripts/restore-emails.js <accountId> <id...>` → Outlook `POST /me/messages/{id}/move { destinationId: "inbox" }`; prints `Done: N restored[, M failed].`
   - `scripts/restore-gmail-emails.js <accountId> <id...>` → Gmail `users.messages.untrash`; same output shape.
   - Endpoint `POST /messages/restore { account, emailIds }` → `restoreFn(account, ids)` → `{ restored, failed }`. Daemon `makeRestoreFn` mirrors `makeDeleteFn` (provider pick, chunk-by-20, parse `Done: N restored`).
2. **Remove from kill-list** (undo kill) — config-only:
   - `scripts/killlist-remove.js <accountId>` (sender JSON on stdin) with a pure `removeSenderFromKillList(cfg, accountId, sender)` → splices the email-exact rule from `company.alwaysDelete`; `atomicWrite` only when removed; prints `{ removed, reason }`.
   - Endpoint `POST /senders/killlist/remove { account, sender }` → `killlistRemoveFn` → `{ removed, reason }`.

Both new connectors are added to the rails-guard (`restore-*` move-only; `killlist-remove` config-only — no send/permanent-delete).

### "Delete and Kill"
No new endpoint — the panel composes the two existing calls (`/messages/delete` then `/senders/killlist`) behind one confirm, then marks the item "Deleted + kill-listed".

### Acted state (client-side)
- `ui.acted` is a Map keyed by an **acted-key** → `{ deleted, killed, account, emailIds:[...], sender }`.
  - Detail row acted-key = the member `emailId`.
  - Tile acted-key = `item.id` (its `emailIds` = all member emailIds; `sender` = the single sender).
- After a successful action the panel records the key (tile actions mark `item.id`; row actions mark the `emailId`). It persists across re-renders/SSE ticks within the session.
- `render.js` (pure) takes `opts.acted` (the Map's plain data) and, when an item/row's key is present, renders it **dimmed + struck** with the badge and a single **Undo** button (`data-undo-acted="<key>"`) in place of the normal action buttons.
- **Undo** (`data-undo-acted`): looks up `ui.acted[key]`, runs `POST /messages/restore` if `deleted`, `POST /senders/killlist/remove` if `killed` (both if "Delete and Kill"), removes the key, reloads. A deleted email naturally drops out on the next tick (it's gone from the mailbox folder the daemon reads); a kill-listed-only item stays, showing the badge until Undo or session end.

## Data Flow

```
Delete row    → POST /messages/delete → ui.acted[emailId]={deleted}      → row dims "Deleted" + Undo
Kill row      → POST /senders/killlist → ui.acted[emailId]={killed,sender}→ row dims "Kill-listed" + Undo
Delete+Kill   → both POSTs            → ui.acted[key]={deleted,killed}    → "Deleted + kill-listed" + Undo
Undo(key)     → restore (if deleted) + killlist/remove (if killed) → delete key → reload
```

## Error Handling / Edge Cases

- Restore/remove failure → surfaced in the notice (`Undo failed: …`); the acted key stays so the user can retry.
- A two-sender tile disables tile-level Kill and Delete-and-Kill (reuses Plan B's `senders.length !== 1` rule); per-row actions still available.
- Acting on an already-acted item is a no-op (buttons are hidden once acted).
- `ui.acted` is session memory only — a full page reload clears it (deleted items are already gone; kill-listed senders remain kill-listed in config, just un-badged).

## Rails (unchanged)

- Restore = mailbox **move** (`deleteditems → inbox`) / `untrash` — recoverable, never a send or permanent delete.
- Kill-list remove = config write only.
- Delete still soft-deletes; kill-list add still config-only + guarded. No auto-send. Rails-guard extended to the two new connectors.

## Testing

- **Pure units**: `removeSenderFromKillList` (removes email-exact match; no-op + reason when absent; unknown account); `extractGmailBody`-style none needed for restore (network).
- **Connector rails-guard**: `restore-emails.js`/`restore-gmail-emails.js` move/untrash only (no send/permanent-delete); `killlist-remove.js` no mail API.
- **API**: `POST /messages/restore` (calls restoreFn, 400 guards), `POST /senders/killlist/remove` (calls killlistRemoveFn, surfaces `removed:false`).
- **Render**: an acted item/row renders dimmed + badge + `data-undo-acted` and hides its normal buttons; a "Delete and Kill" button (`data-delkill`) appears on rows + tiles (disabled on multi-sender tiles); non-acted unchanged.
- **Contract**: app handles `data-delkill` and `data-undo-acted`.
- Full suite stays green.

## Build Sequence (one plan, ~3 tasks)

1. Reverse connectors + `removeSenderFromKillList` + endpoints + daemon wiring + rails-guard + api/unit tests.
2. Acted-state render + "Delete and Kill" button + app handlers (mark acted, per-row undo, combined action) + styles + render/contract tests.
3. Full suite + manual smoke.
