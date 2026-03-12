# Account Types

OfficeOS supports multiple account types to handle both business and personal email management. Each account in `config/companies.json` references a type, and the type's behavioral defaults are defined in `config/account-types.json`.

## How It Works

1. Each account entry has an `accountType` field (`"business"` or `"personal"`)
2. The type definition in `account-types.json` provides default: triage categories, tone, downrank patterns, noise filters, daily brief behavior, and task capture policy
3. Account-level values in `companies.json` override type defaults (account wins for scalar fields)

## Triage Categories

### Business (4 categories)
| Category | Description |
|----------|-------------|
| ACTION REQUIRED | Needs a response or decision |
| FYI / READ | Informational, no action needed |
| NEWS / MARKET | Industry or market updates |
| IGNORE (hidden) | Matches downrank patterns — not displayed |

### Personal (13 categories)
| Category | Description |
|----------|-------------|
| RESPOND | Needs a reply — someone is waiting |
| BILLS / FINANCE | Bills due, statements, bank alerts, tax docs |
| APPOINTMENTS | Medical, dental, auto, personal services |
| HOME / FAMILY | School notices, HOA, household services, family coordination |
| TRAVEL | Bookings, confirmations, itineraries — not promos |
| SHOPPING / ORDERS | Order confirmations, shipping, returns — not deal alerts |
| SUBSCRIPTIONS / RENEWALS | Renewal notices, payment failures — not upsells |
| FITNESS / WELLNESS | Gym, classes, health apps, wellness programs |
| HOBBIES | Clubs, groups, events, gear — personal interests |
| VOLUNTEER | Nonprofit roles, community service, board duties |
| PERSONAL / SOCIAL | Friends, invitations, personal correspondence |
| NEWSLETTERS | Opted-in reads worth scanning — not spam |
| IGNORE (hidden) | Marketing noise — not displayed |

## Flat vs. Rich Categories

**Flat categories** have only an id, label, and description. Most default categories are flat — classification is handled by the account's general `prioritySenders` and `urgencyRules`.

**Rich categories** add their own `prioritySenders`, `urgencyRules`, `downrank`, and optionally `noiseFilters`. Use rich categories for commitments that are complex enough to have their own organizations, contacts, and deadlines (e.g., a competitive sport, a fraternity, a nonprofit board role).

Rich categories are defined in the account's `categoryOverrides` array in `companies.json`.

## Merge Order

1. Load type defaults from `account-types.json`
2. Load account entry from `companies.json`
3. Scalar fields (tone, taskCapture, etc.): account value wins if present
4. `categoryOverrides`: matching `id` → full replace; new `id` → append
5. `downrank`: account array concatenates with type `downrankDefaults`
6. `noiseFilters`: account-level signals concatenate with type-level signals

## Extending Categories

Edit `config/account-types.json` to modify type-level defaults, or add `categoryOverrides` to a specific account in `companies.json`.

To create a new rich category, add an entry to `categoryOverrides` with:
- `id` — unique key (lowercase, hyphenated)
- `label` — display name (ALL CAPS by convention)
- `description` — what belongs here
- `prioritySenders` — (optional) senders that flag emails for this category
- `urgencyRules.flags` — (optional) keywords that make items urgent
- `downrank` — (optional) noise patterns specific to this category

See `config/account-types.example.json` and `config/companies.example.json` for complete examples.
