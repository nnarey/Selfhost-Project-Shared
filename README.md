# FieldCam Self-Host

A sample camera competition. People check out a FieldCam, use it, and show up on a weekly leaderboard. Reports and reminders are part of the same app.

The company in this sample is **Northline**. Cameras are **FieldCam**. Emails use `@northline.example`. Nothing here is a live customer or employee roster.

## Run it locally

```bash
./start.sh
```

API on `http://localhost:8787`. UI on `http://localhost:5173`.

Leaderboard `http://localhost:5173/#/leaderboard`. Admin `http://localhost:5173/#/admin`.

Needs Node 22 on your PATH. A fresh clone shows the same sample data as the original: `start.sh` creates `server/.env.local` from `server/.env.example` on first run (the API needs it to listen on 8787), and the server imports `data/` on boot. Edit `server/.env.local` if you want to change the admin password. The sample password is `Password`. Demo admins are `alice@northline.example`, `bob@northline.example`, and `cara@northline.example`.

## What you can click through

- **Leaderboard** ranks the current week from imported activity.
- **Devices** shows which cameras are checked out.
- **Sign up** adds a participant. Admins approve them.
- **Admin** imports a Splunk-style activity CSV and a Fleet assignment CSV, credits reports, and queues Slack reminders.

Scoring, in short: a successful recording, upload, livestream, and an approved report all add points. Idle cameras can lose points. The exact weights live in `server/src/scoring/defaults.ts`.

## Mock integrations

These keep the same shape as a real deployment and ship with no credentials.

| Piece | In this folder |
| --- | --- |
| Splunk | `web/splunk-search.spl` searches `index=fieldcam_demo`. `scripts/etl_splunk_activity.py` copies `server/fixtures/activity_events.csv` to `data/splunk-activity.csv`. It does not call the network. `SPLUNK_BASE_URL` defaults to `https://splunk.example`. |
| Fleet | Device ownership. `FLEET_MODE=mock` in `server/.env.example` reads assignments from the local database. Live mode would call `FLEET_BASE_URL`. |
| Slack | Reminders post to `#fieldcam-selfhost` when `SLACK_BOT_TOKEN` is set. The sample leaves the token empty, so queueing does not send. |
| Jira | Triage defaults to `issues.northline.example`, project `FC`, epic `FC-100`. Tokens are blank. |
| Harbor | The hosted container in the `Dockerfile`. `HARBOR_TRUST_IDENTITY` trusts an SSO email header. Locally it stays off. |
| GitHub Actions | `.github/workflows/daily-splunk-etl.yaml` runs on `ubuntu-latest` and writes the fixture. `.github/workflows/daily-jira-triage.yaml` exports triage when Jira secrets exist. |

Regenerate the fixture CSVs from `server/`:

```bash
npx tsx src/scripts/generateFixtures.ts
python3 ../scripts/etl_splunk_activity.py
```

The permanent holders are Alice Chen, Bob Rivera, Cara Nguyen, Devon Park, Elena Brooks, Frank Okonkwo, Grace Kim, and Hank Morales. Checkout participants are Jordan Hale, Lila Ortega, Marco Diaz, Kenji Sato, Nina Patel, Iris Chen, Omar Farouk, and Priya Shah. Camera ids look like `FC-1001`. Names and assignment history are in `data/roster.json`, and the activity those assignments score is in `data/splunk-activity.csv`. A fresh start imports both, so the leaderboard is already filled.

## Layout

- `web/` — React UI
- `server/` — API and SQLite
- `server/fixtures/` — synthetic activity and assignments
- `data/` — the Splunk snapshot the server imports on boot
- `.claude/skills/` — agent notes for reminders, report intake, and gathering reports
