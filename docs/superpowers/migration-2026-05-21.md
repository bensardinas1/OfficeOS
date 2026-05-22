# Morning Brief — Manual Config Migration (2026-05-21)

The schema changes from Tasks 1 and 2 add `unless` clauses and `scamPatterns` support to `config/companies.json`. The file is gitignored, so this migration is a manual step the user performs once on their real config.

After applying these changes, run `/morning-brief --dry-run` to confirm classification behaves as expected.

## 1. Replace plain `eBay` entry in `personal.alwaysDelete`

Find this entry in the `personal` account:

```json
{ "type": "name", "value": "eBay", "label": "eBay promos" }
```

Replace with:

```json
{
  "type": "name",
  "value": "eBay",
  "label": "eBay marketing (transactional allowed)",
  "unless": {
    "subjectContains": ["delivered", "shipped", "out for delivery", "order", "security", "device", "message", "buyer", "seller", "feedback"]
  }
}
```

## 2. Replace plain `PayPal` entry in `personal.alwaysDelete`

Find:

```json
{ "type": "name", "value": "PayPal", "label": "PayPal marketing" }
```

Replace with:

```json
{
  "type": "name",
  "value": "PayPal",
  "label": "PayPal marketing (receipts allowed)",
  "unless": {
    "subjectContains": ["you've got money", "you received", "payment received", "payment confirmation", "receipt for your payment", "refund"]
  }
}
```

## 3. Append to `personal.neverDelete`

(These can also be auto-discovered by Task 5's `discoverMemoryBackfill` — skip step 3 if you'd rather approve via the brief.)

Add (preserving JSON comma syntax):

```json
{ "type": "domain", "value": "equinox.com", "label": "Equinox account info" },
{ "type": "email", "value": "avc@fiusigepalumni.ccsend.com", "label": "FIU SigEp Alumni newsletter" },
{ "type": "name", "value": "Castillo, Rodney", "label": "AANHPI / AAAB contact" }
```

## 4. Append to `healthcarema.neverDelete`

```json
{ "type": "email", "value": "assuredinvestmentsrealty@gmail.com", "label": "Juan Santamaria (\"John\") — friend" }
```

## 5. Add `scamPatterns` to `summitmiami`, `brickellpay`, and `healthcarema`

Inside each of the three account objects, after `neverDelete` and before `outputs`, insert:

```json
"scamPatterns": [
  {
    "label": "Annual Report filing scam (rotating third-party domains)",
    "subjectAll": ["annual report"],
    "senderAllowlist": ["sunbiz.org"],
    "action": "delete"
  }
],
```

(This pattern can also be auto-proposed by Task 5's `discoverScamPatterns` after 3+ deletions across 2+ domains in 30 days — skip step 5 if you'd rather wait for the system to suggest it.)

## 6. Add `actionable: true` to actionable categories in `account-types.json`

The orchestrator now reads `actionable` from category definitions. Add the flag to your actionable categories:

In `account-types.json`:
- Under `business.triageCategories`: add `"actionable": true` to the `action` category.
- Under `personal.triageCategories`: add `"actionable": true` to the `respond` category.

If you don't apply this migration, the script falls back to the legacy hardcoded IDs `action` and `respond` — your existing setup will still work, but new categories you add won't be recognized as actionable until they have the flag.

## 7. Optional: add `memoryKeywords` to each account in `companies.json`

For multi-account memory routing during backfill discovery. Each account can declare keyword phrases that, if found in a memory file body, route the resulting proposal to that account. Example:

```json
"memoryKeywords": ["healthcare m&a", "hcma"]
```

If omitted or no keyword matches, proposals route to the first personal-type account. This is a quality-of-life setting; you can also fix the target by hand when reviewing proposals.

## Validation

After applying changes, verify the JSON parses:

```bash
node -e "import('node:fs').then(m=>{const t=m.readFileSync('config/companies.json','utf-8');JSON.parse(t);console.log('OK')})"
```

Then run a dry-run:

```bash
/morning-brief --dry-run
```

Review `data/morning-queue.dry-run.md` and confirm:
- eBay/PayPal transactional emails are NOT in deletion candidates
- Annual Report scam emails from non-sunbiz domains ARE in deletion candidates
- Equinox, FIU SigEp, Castillo, Juan Santamaria emails are NOT in deletion candidates
