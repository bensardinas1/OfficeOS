---
description: DEPRECATED — use /morning-brief instead
---

# Triage (deprecated)

This skill has been replaced by `/morning-brief`, which does triage, drafting, task capture, and pattern discovery in one autonomous pass.

To run a 24-hour triage equivalent:

```
/morning-brief --window 24h
```

To catch up on a longer window:

```
/morning-brief --since 2026-05-07
```

For a no-op preview (no deletes, no drafts saved, no state changes):

```
/morning-brief --dry-run
```

See `docs/superpowers/specs/2026-05-21-morning-brief-design.md` for the design rationale.
