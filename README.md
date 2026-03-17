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

## MCP Server (Claude Desktop)

OfficeOS also ships as an MCP server for use with Claude Desktop — no approval prompts, all tools pre-authorized.

### Setup

1. Copy `config/claude-desktop-config.example.json` and merge into your Claude Desktop config at:
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
   - **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
2. Update the path in `args` to match your OfficeOS install location
3. Restart Claude Desktop

### Available Tools

| Tool | Description |
|------|-------------|
| `fetch_emails` | Fetch inbox emails (Outlook) |
| `fetch_sent_emails` | Fetch sent emails for voice analysis |
| `fetch_thread` | Fetch full email thread |
| `classify_emails` | Classify emails into triage categories |
| `delete_emails` | Soft-delete Outlook emails |
| `delete_gmail_emails` | Soft-delete Gmail emails |
| `save_draft` | Create Outlook draft |
| `save_gmail_draft` | Create Gmail draft |
| `list_accounts` | List configured accounts |
| `read_config` | Read config files |

## Requirements

- Claude Code CLI or Claude Desktop (with MCP server)
- Microsoft 365 / Outlook access (via MCP or direct API)
- Node.js 18+ (for scripts and MCP server)
