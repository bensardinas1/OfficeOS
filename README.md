# OfficeOS

A Claude Code skill suite for managing office operations across multiple companies — email, tasks, priorities, reporting, and strategic work.

## Overview

OfficeOS provides AI-powered skills (slash commands) for:

- **Email Management** — Read, triage, draft, and organize Outlook email across multiple company accounts
- **Task & Priority Tracking** — Capture, prioritize, and track action items from emails and meetings
- **Reporting** — Generate status reports, summaries, and briefings
- **Tactical & Strategic Work** — Meeting prep, decision support, and follow-up management

## Structure

```
OfficeOS/
├── .claude/
│   └── commands/          # Custom Claude Code slash commands (skills)
│       ├── email/         # Email management skills
│       ├── tasks/         # Task tracking skills
│       ├── reports/       # Reporting skills
│       └── office/        # General office skills
├── config/
│   └── companies.example.json   # Template for company/account config
├── data/                  # Local working data (gitignored)
├── docs/                  # Documentation and playbooks
└── scripts/               # Helper scripts
```

## Getting Started

1. Clone this repo into your working directory
2. Copy `config/companies.example.json` → `config/companies.json` and fill in your company accounts
3. Open in Claude Code: `claude .`
4. Use `/` to browse available skills

## Skills Reference

| Skill | Description |
|-------|-------------|
| `/email-triage` | Summarize and prioritize inbox |
| `/email-draft` | Draft a reply or new email |
| `/task-capture` | Extract action items from email or notes |
| `/task-review` | Review open tasks and priorities |
| `/daily-brief` | Morning briefing: email + tasks + priorities |
| `/weekly-report` | Weekly status summary |
| `/meeting-prep` | Prepare for an upcoming meeting |

## Configuration

See `config/companies.example.json` for the account configuration format. Each entry defines a company context including display name, email domain, and communication style preferences.

## Requirements

- Claude Code CLI
- Microsoft 365 / Outlook access (via MCP or direct API)
- Node.js (for any helper scripts)
