# Gmail Integration

OfficeOS supports Gmail accounts via MCP (Model Context Protocol) tools available in the Claude Code environment.

## Setup

1. Add a Gmail account entry to `config/companies.json` with `"provider": "gmail"`
2. Ensure the Gmail MCP server is connected in your Claude Code environment
3. Authorize Gmail access when prompted by MCP

No API keys, OAuth setup, or scripts are needed when using MCP.

## How It Works

### Provider Routing

Each account has a `provider` field that determines how emails are fetched:

| Provider | Method | Setup Required |
|----------|--------|---------------|
| `outlook` | `node scripts/fetch-emails.js` (Graph API) | Azure app registration, `.env` credentials |
| `gmail` | MCP `gmail_search_messages` | MCP Gmail server connected |

Skills check `account.provider` and route accordingly. Classification and output logic are identical regardless of provider.

### MCP Gmail Tools Used

- `gmail_search_messages` — fetch recent emails (used by triage and daily brief)
- `gmail_read_message` — read full email content
- `gmail_read_thread` — read email thread for context
- `gmail_create_draft` — draft replies (used by email-draft skill)
- `gmail_get_profile` — verify account access

### Email Normalization

The existing Outlook connector (`fetch-emails.js`) returns flat fields (`from`, `fromName`). Gmail MCP returns its own structure. Skills normalize both to a common shape before classification:

```json
{
  "from": { "name": "Sender Name", "email": "sender@example.com" },
  "subject": "Email subject",
  "received": "2026-03-12T10:00:00Z",
  "preview": "First 300 characters..."
}
```

Normalization happens in the skill layer, not in connectors.

### When MCP Is Unavailable

If MCP Gmail tools are not available, skills skip the Gmail account and display a warning:
> "Gmail account 'Personal' skipped — MCP unavailable"

Business Outlook accounts continue to work normally.

## Future: Script Fallback

A `scripts/fetch-gmail.js` connector is designed but not yet built. When implemented, it will:
- Mirror the `fetch-emails.js` interface: `node scripts/fetch-gmail.js {companyId} {hours} inbox`
- Use Gmail API with OAuth2
- Require `.env` credentials: `{COMPANYID}_GMAIL_CLIENT_ID`, `{COMPANYID}_GMAIL_CLIENT_SECRET`, `{COMPANYID}_GMAIL_REFRESH_TOKEN`
- Return the common email structure directly

## Adding a Gmail Account

1. Add to `config/companies.json`:
```json
{
  "id": "personal",
  "name": "Personal",
  "accountType": "personal",
  "provider": "gmail",
  "myEmail": "you@gmail.com",
  ...
}
```

2. Test with: `/email-triage personal`
