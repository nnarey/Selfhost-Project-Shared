---
name: gather-selfhost-reports
description: Run the laptop reports gather CLI (Slack #fieldcam-selfhost and the mechanical issue tracker) to write a full CSV dump, then after confirmation credit new rows via Admin CSV intake. Jira bugs are scored by the server when they move from NEEDS TRIAGE to Triaged, not by this CSV. Use whenever the user asks to gather or dump self-host reports to CSV, upload the reports CSV, sync latest Slack or sheet findings for intake, or invokes /gather-selfhost-reports.
---

# Gather self-host reports

Daily operator path: the laptop writes a **full** dump of current Slack + sheet findings.
The app (localhost or Harbor) inserts only links it does not already have. You do not export Harbor.

Jira bugs are not in this dump. The server scores them when status moves from `NEEDS TRIAGE` to
`Triaged`. Do not add Jira browse URLs to the CSV.

This is not `/import-selfhost-reports`. That skill credits via MCP + one API call per row. This
skill runs `reports:gather` and intake on the CSV.

Gather is safe. Intake scores immediately — **do not POST intake until the user confirms** the
file and the instance.

Slack and sheet tokens stay in laptop `server/.env.local`. Jira triage scoring on Harbor comes from
`data/jira-triage.json`, committed by the daily GitHub Action (`JIRA_EMAIL` and `JIRA_API_TOKEN`
are Actions secrets). A laptop server can still poll when those two are in `server/.env.local`.

## 1. Gather the dump

From the repo root (`FC-Selfhost/`):

```bash
npm --prefix server run reports:gather
```

Default output: `server/data/fieldcam-reports-YYYY-MM-DD.csv` (today’s UTC date). Optional:

```bash
npm --prefix server run reports:gather -- --out /tmp/fieldcam-reports.csv
```

The CLI prints `{ out, rows, slack, sheet, skippedSources }`.

If a source is skipped, say which env var is missing. Tokens live in `server/.env.local` only:

- Slack: `SLACK_BOT_TOKEN` (needs history on `#fieldcam-selfhost` / `C000FIELD00` plus user email read)
- Sheet: `GOOGLE_API_KEY` (tracker `MECHANICAL_SHEET_ID`, default already set)

Do not invent tokens. If both sources are skipped, stop — the CSV is headers
only and uploading it does nothing useful.

## 2. Show the file, then wait

Print path, row count per source, and a short table: email, date, excerpt, link.

Traps the CLI will not fix:

- No `slackMessageUrl` → intake skips that row (`skippedNoUrl`).
- Off-roster email → skipped (`skippedUnknownEmail`).
- Date-only sheet days become `YYYY-MM-DDT12:00:00.000Z` on intake (same as the Admin date picker).

Do not edit the CSV unless the user asks.

## 3. Confirm instance and intake

Ask: **localhost** (`http://localhost:8787`) or **Harbor**
(`https://fieldcam-selfhosting.harbor.northline.example`). Wrong DB is invisible on the board they are watching.

**Harbor:** do not call Harbor intake yourself (SSO; no laptop admin session). Tell them to open
Admin → Reports → Upload reports CSV and pick the file just written. Stop after that.

**Localhost:** only after they say go.

1. Confirm the server is up: `curl -s http://localhost:8787/health`
2. Admin login. Allowlist `alice@northline.example`, `bob@northline.example`, `cara@northline.example`. Password is
   `ADMIN_PASSWORD` in `server/.env.local` — read it, do not assume a value.

```bash
curl -s -X POST http://localhost:8787/api/admin/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"you@northline.example\",\"password\":\"$ADMIN_PASSWORD\"}"
```

3. POST the **whole file** (`dryRun: false`). Creating rows scores immediately.

```bash
python3 -c 'import json,pathlib,sys; p=sys.argv[1]; print(json.dumps({"dryRun":False,"csv":pathlib.Path(p).read_text()}))' \
  server/data/fieldcam-reports-YYYY-MM-DD.csv \
| curl -s -X POST http://localhost:8787/api/admin/reports/intake \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d @-
```

Re-runs are safe: existing `slack_message_url` values come back as `skippedDuplicate`.

## 4. Report back

Say inserted, failed, skippedDuplicate, skippedUnknownEmail, skippedNoUrl, and the CSV path. A
non-zero `failed` means those rows threw on write and were not credited — the rest of the batch
still landed, and each failed row carries an `error`. Name them; do not just report the total. If they
confirmed localhost only, say Harbor still needs the same file uploaded on Admin → Reports.