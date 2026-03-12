# OfficeOS — Claude Code Project Instructions

## Project Purpose
This is a collection of Claude Code skills for managing office operations across multiple companies. Skills are implemented as custom slash commands in `.claude/commands/`.

## Architecture

OfficeOS is built on three layers. Every skill, connector, and orchestrator must fit exactly one layer — never mix responsibilities across layers.

### Layer 1 — Connectors (`scripts/`)
Scripts that interface with external systems (email, calendar, CRM, etc.).
- Accept a company ID as their first argument
- Read all credentials and endpoints from `config/companies.json`
- Return structured data (JSON) to stdout
- Have zero knowledge of business logic, urgency rules, or output formatting

### Layer 2 — Skills (`.claude/commands/<category>/`)
Generic prompt templates that perform a single operation for one company at a time.
- Accept `$ARGUMENTS` — typically a company ID or task context
- Load **all** company-specific config (contacts, tone, urgency rules, senders) from `config/companies.json` at runtime
- **Never hardcode** company names, email addresses, account IDs, contacts, or rules
- Delegate data fetching to connectors in `scripts/`

### Layer 3 — Orchestrators (`.claude/commands/orchestrators/`)
Meta-skills that coordinate across multiple companies or multiple skills.
- Load all companies from `config/companies.json`
- Call connectors or invoke skill logic for each relevant company
- Aggregate and prioritize results across companies
- Produce unified, cross-company output

### The Golden Rule
`config/companies.json` is the **single source of truth** for all account configuration. If you find yourself writing a company name, email address, contact name, or business rule inside a skill or orchestrator file, stop — it belongs in the config.

## Key Conventions

### Skill Development
- Each skill lives in `.claude/commands/<category>/<skill-name>.md`
- Skills use the `$ARGUMENTS` variable to accept user input
- Skills should be concise, actionable, and generic — no company-specific content
- All company context is loaded dynamically from `config/companies.json`
- All display/output behavior is controlled by `config/prefs.json` — load it at the start of every skill and apply its `display` settings to all output formatting

### Company Context
- Multiple companies are managed — always clarify which company when ambiguous
- Each company may have different communication styles, urgency levels, and key contacts
- Load company config from `config/companies.json` at the start of every task

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
- Display preferences: `config/prefs.json`
- Task log: `data/tasks.md`
- Skill commands: `.claude/commands/`
- Documentation: `docs/`

## Do Not
- Commit `config/companies.json` (contains sensitive account info)
- Commit anything in `data/` (local working files)
- Hard-code company names or email addresses in skill files
