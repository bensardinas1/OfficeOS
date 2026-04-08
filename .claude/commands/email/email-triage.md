Triage the email inbox for a single company. $ARGUMENTS

$ARGUMENTS is a company ID from `config/companies.json` (e.g. `healthcarema`, `personal`).
Optionally append hours and max results: `personal 48 200`.
If no account ID is provided, ask the user which account to triage.

Follow the same process as the full triage orchestrator (`orchestrators/triage.md`), but for a single account:

1. Run: `node scripts/triage.js --raw {accountId} {hours} {maxGmail}`
2. Load `config/attention-profile.md` and classify the uncertain emails
3. Format and present results (same format as full triage, but single account)
4. Save `data/pending-deletions.json` and handle deletion workflow
5. Capture feedback (explicit statements → memories, append to triage log)

See `orchestrators/triage.md` for full Phase 1-5 details.
