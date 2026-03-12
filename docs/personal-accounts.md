# Personal Accounts

OfficeOS treats personal accounts as first-class citizens — not simplified versions of business accounts. Executives with active personal lives (competitive sports, fraternity/nonprofit board roles, family coordination) deserve the same triage quality for personal email as for business.

## Why Personal Accounts Matter

Personal inbox management is a significant time sink for busy executives. OfficeOS personal triage:
- Categorizes life admin (bills, appointments, subscriptions) separately from noise
- Surfaces hobby and volunteer commitments with the same urgency awareness as business
- Filters promotional content aggressively — keeps order confirmations, rejects deal alerts
- Appears in the daily brief as a separate "Personal Quick Hits" section

## Setting Up a Personal Account

1. Add an entry to `config/companies.json` with:
   - `"accountType": "personal"` — loads personal triage categories
   - `"provider": "gmail"` — fetches via MCP Gmail tools

2. Add `categoryOverrides` for any hobbies, volunteer roles, or commitments that need their own triage rules (see Rich Categories below)

3. Test with: `/email-triage personal`

## Rich Categories

Generic categories like "HOBBIES" are useful defaults. But if your hobby has its own national organization, tournaments, deadlines, and contacts, it deserves a **rich category** with its own rules.

### Example: Competitive Sport

```json
{
  "id": "iaido",
  "label": "IAIDO",
  "description": "Iaido study, teaching, and competition — local and national",
  "prioritySenders": [
    { "type": "domain", "value": "auskf.org", "label": "National federation" },
    { "type": "name", "value": "Sensei Tanaka", "label": "Instructor" }
  ],
  "urgencyRules": {
    "flags": ["tournament", "registration", "deadline", "seminar", "grading", "exam"]
  },
  "downrank": ["merchandise", "fundraiser spam"]
}
```

### Example: Fraternity/Nonprofit Board

```json
{
  "id": "spe",
  "label": "SIGMA PHI EPSILON",
  "description": "Fraternity — local chapter and national involvement",
  "prioritySenders": [
    { "type": "domain", "value": "sigep.org", "label": "SPE National" },
    { "type": "name", "value": "Chapter President", "label": "Local chapter" }
  ],
  "urgencyRules": {
    "flags": ["chapter meeting", "board", "election", "deadline", "conclave", "convention"]
  },
  "downrank": ["alumni merchandise", "donation solicitation"]
}
```

## Noise Filtering

Personal inboxes get far more promotional noise than business inboxes. The personal account type includes `noiseFilters` that apply a second classification pass:

**Philosophy:** Transactional/actionable emails in, marketing/promotional noise out.

| Keep (transactional) | Reject (promotional) |
|---------------------|---------------------|
| confirmation, receipt, shipped | promotion, deal, offer |
| delivered, reminder, appointment | recommended, trending |
| invoice, due, renewal | you might like, earn |
| booking, itinerary, gate change | reward points, upgrade |

If an email matches both keep and reject signals, **keep wins**.

## Daily Brief

Personal accounts appear at the end of the daily brief in a separate "Personal Quick Hits" section:

1. **Needs Reply** — emails where someone is waiting
2. **Today's Life Admin** — bills due, appointments, renewals
3. **Hobbies & Commitments** — urgent items from rich categories
4. **Everything Else** — count of remaining items ("12 shopping/orders, 4 newsletters — nothing urgent")

Personal accounts do not generate tasks automatically. Use `/task-capture` explicitly if you want to track a personal item.
