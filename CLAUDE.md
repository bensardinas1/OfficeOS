# OfficeOS — Claude Code Project Instructions

## Project Purpose
This is a collection of Claude Code skills for managing office operations across multiple companies. Skills are implemented as custom slash commands in `.claude/commands/`.

## Key Conventions

### Skill Development
- Each skill lives in `.claude/commands/<category>/<skill-name>.md`
- Skills use the `$ARGUMENTS` variable to accept user input
- Skills should be concise, actionable, and context-aware
- Always include company context when relevant (see `config/companies.json`)

### Company Context
- Multiple companies are managed — always clarify which company when ambiguous
- Each company may have different communication styles, urgency levels, and key contacts
- Load company config from `config/companies.json` at the start of email/comms tasks

### Email Management
- Outlook is the primary email client
- Use MCP tools (gmail/outlook) when available; otherwise instruct the user
- Triage by: urgent action required → reply needed → FYI → archive
- Draft emails matching the sender's tone and company voice

### Task Tracking
- Tasks are stored in `data/tasks.md` (gitignored, local only)
- Priority levels: P1 (today/blocking), P2 (this week), P3 (backlog)
- Always tie tasks back to source (email thread, meeting, decision)

### Reporting
- Weekly reports cover: accomplishments, open items, blockers, next week
- Daily briefs cover: top priorities, emails needing response, calendar

## File Paths
- Company config: `config/companies.json`
- Task log: `data/tasks.md`
- Skill commands: `.claude/commands/`
- Documentation: `docs/`

## Do Not
- Commit `config/companies.json` (contains sensitive account info)
- Commit anything in `data/` (local working files)
- Hard-code company names or email addresses in skill files
