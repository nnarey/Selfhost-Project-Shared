# Synthetic paired fixtures

Generated for Phoenix week starting `2026-10-12T07:00:00.000Z`.

- `activity_events.csv` — Splunk-like event-level activity
- `assignments.csv` — Fleet assignment history plus unassigned camera_id rows for available stock

Regenerate with:

```bash
cd server && npx tsx src/scripts/generateFixtures.ts
```

These use the canonical column names. Native Splunk/Fleet headers will map through Admin mapping profiles once real samples arrive.
