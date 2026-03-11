Capture action items from the provided input. $ARGUMENTS

1. Parse the input (email, meeting notes, or freeform text) for action items
2. For each item extract:
   - **Task**: clear, verb-led description
   - **Owner**: who's responsible (default: me if unclear)
   - **Priority**: P1 (today/blocking) | P2 (this week) | P3 (backlog)
   - **Due date**: if mentioned or implied
   - **Source**: where this came from
3. Append to `data/tasks.md` in this format:
   ```
   - [ ] [P1] Task description — Source: email from Jane, 2026-03-11
   ```
4. Confirm what was added

If no input is provided, ask me to paste the email or notes.
