---
name: import-selfhost-reports
description: Gather FieldCam self-host findings from Slack #fieldcam-selfhost and the Mechanical Issue Tracker Google Sheet, match them to participants, and credit them as approved reports. Do not credit Jira tickets — the server scores a roster reporter only when a bug moves from NEEDS TRIAGE to Triaged. Use whenever the user asks to pull or import self-host reports, sync findings from Slack or the mechanical issue tracker into the app, or invokes /import-selfhost-reports.
---

# Import self-host reports

Participants report FieldCam findings two ways this skill credits: posts in Slack `#fieldcam-selfhost` and rows
in the **FieldCam Selfhost - Mechanical Issue Tracker** sheet. This skill collects candidates from both,
shows them in one list, and — only after the user confirms — credits them via the admin API.

Jira bugs are not part of this list. Harbor scores a roster reporter 200 points from
`data/jira-triage.json` when a child of epic `FC-100` moves from `NEEDS TRIAGE` to `Triaged`,
in the Phoenix week of that change. A bug sent to `Won't Fix` instead does not score. A later move
from `Triaged` to `Won't Fix` keeps the points. Do not create a report whose link is a Jira browse URL.

There is no pending queue and no approval step: a report is created already approved and scores
immediately. That means creating one is a real scoring change, so the confirmation step is not
optional.

## 1. Pull both sources

Do these lookups in the same turn — they are independent.

**Slack** (channel `#fieldcam-selfhost`, ID `C000FIELD00`):

```
get_conversation_history(channel: "C000FIELD00", limit: 200, compact: true)
```

Page with `cursor` while `has_more` is true. `compact: true` keeps the output small; re-fetch a
specific message without it if you need untruncated text.

Use the channel **ID**, not the name. Use the demo channel id from `server/.env.example`. Do not guess a similarly named channel. If the ID does not resolve, stop and say so rather
than falling back to a name that looks close.

**Google Sheet** — the mechanical issue tracker. Set `MECHANICAL_SHEET_ID` in `server/.env.local` to a demo sheet. Single tab `Sheet1`. Rows 1–4 are a title block and
the header is **row 5**, so data starts at row 6:

```
google_sheets_read_range(
  spreadsheet_id: "",
  range: "Sheet1!B5:J200"
)
```

Columns are `Issue ID | Date Noticed | SN# | Details | Photos/Videos | Noted By | Status | Priority |
Resolution` (column A is an empty spacer — start at B). The grid is padded to ~1000 rows, so stop at
the first row with a blank Issue ID rather than trusting the row count. Trailing empty cells are
omitted from each row array, so index by position and treat missing entries as blank.

Every row is a finding. **Status is not a filter** — a resolved issue was still reported, so credit
`Open` and `Closed` alike unless the user says otherwise.

## 2. Keep only genuine participant findings

The roster is the filter that matters. **Only count a Slack post or sheet row whose person is on
the participants roster.**

```bash
sqlite3 -header -column "server/data/fieldcam.sqlite" \
  "SELECT email, name FROM participants WHERE lower(signup_status) != 'rejected';"
```

**Sheet rows** identify the person only by the display name in **Noted By**, which is the value to
credit. Match it on **surname** — every roster surname is currently unique — then sanity-check the
first name, accepting the obvious short forms. Two traps make the tempting shortcuts wrong:

- Exact full-name matching fails. The sheet says `Alice Chen`; the roster row says `Alice Chen`.
  `server/src/config/permanentHolders.ts` carries the longer legal-style names and is worth checking
  as a second source when the roster name does not line up.
- First-initial + surname is **not** the email rule. `Elena Brooks` is `elena@northline.example`, not `kli@`.
  Derive the email from the matched roster row; never construct one.

If a surname is not on the roster, or two people could plausibly match, mark the row unmatched and
let the user decide. The API rejects off-roster emails anyway, so a guess just fails later.

For Slack, a report is a first-person account of something the person found or tested. Exclude
channel joins, Slackbot canvas notifications, logistics (shipping, invites, credential resets),
jokes, short acks, and posts *soliciting* reports. Slack handles follow
`<first-initial><lastname>@northline.example` and match the message's `user_name`; cross-check the display
name. **If an author does not clearly map to a roster email, mark it unmatched rather than
guessing** — an unmatched row is rejected by the API anyway.

When a message is genuinely ambiguous, list it flagged as uncertain and let the user decide.

## 3. Build the link for each candidate

The link doubles as the dedupe key, so every candidate needs one.

- **Slack**: `https://northline.slack.com/archives/C000FIELD00/p<ts>` where `<ts>` is the
  message's `ts` with the decimal point removed (`1700000000.123456` → `p1700000000123456`).
- **Sheet**: `https://docs.google.com/spreadsheets/d//edit?issue=<Issue ID>#gid=0`

  Key on the **Issue ID**, not the row number. Rows shift when someone inserts or sorts, and a
  row-anchored link would silently re-credit the same finding after that.

## 4. Show the combined list and get confirmation

One table, both sources together, most recent first. Per candidate: source, person (mapped
email), date, summary/excerpt, link, and whether it is already imported.

For a sheet row, the report text is the **Details** cell. Prefix it with the `SN#` when that column
names a specific camera rather than `All` — it is the only place the affected device is recorded.

Check what is already credited so re-runs do not look like new work:

```bash
sqlite3 "server/data/fieldcam.sqlite" \
  "SELECT slack_message_url FROM reports;"
```

Ask the user to confirm the list, or strike entries, before writing anything.

## 5. Create the confirmed reports

Log in as admin (allowlist `alice@northline.example`, `bob@northline.example`, `cara@northline.example`; password is
the `ADMIN_PASSWORD` env var in `server/.env.local` — read it from there rather than assuming a
value, it is meant to be rotated):

```bash
curl -s -X POST http://localhost:8787/api/admin/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"you@northline.example\",\"password\":\"$ADMIN_PASSWORD\"}"
```

### Getting `reportedAtUtc` right

The server buckets a report by the **Phoenix** Monday of `reportedAtUtc`, so the timestamp decides
which week gets the points.

Slack already gives a full instant — pass it through. The sheet gives a bare
`Date Noticed` (`YYYY-MM-DD`), and the naive conversion is wrong: `2026-08-25T00:00:00.000Z` is
5pm on the 24th in Phoenix. Most days that still lands in the right week, but a **Monday** date
silently lands a week early:

| `Date Noticed` | sent as `...T00:00:00.000Z` | sent as `...T07:00:00.000Z` |
| --- | --- | --- |
| `2026-08-25` (Tue) | week of `2026-08-24` ✅ | week of `2026-08-24` ✅ |
| `2026-08-31` (Mon) | week of `2026-08-24` ❌ | week of `2026-08-31` ✅ |

Phoenix is UTC−7 year-round, so append **`T07:00:00.000Z`** — Phoenix midnight on that date.

This matters most at the season boundary. `SEASON_START` (default `2026-08-31`) wipes the board once,
automatically, when the season opens — so anything credited to an earlier week is preseason and will
be erased. Before importing back-dated findings, check whether they land before that date and tell
the user, so they can decide between crediting now and waiting for the season to open.

Then one call per confirmed candidate:

```bash
curl -s -X POST http://localhost:8787/api/admin/reports/create \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"email":"<participant email>","text":"<summary of the finding>","slackMessageUrl":"<link>","reportedAtUtc":"<ISO timestamp>"}'
```

The endpoint rejects anyone off the roster and any link already attached to another report, so
re-running is safe — duplicates come back as errors rather than double-crediting.

**Which instance:** `localhost:8787` is the local dev database. Harbor
(`https://fieldcam-selfhosting.harbor.northline.example`) is a separate database and needs its own admin
password — ask the user which one they mean rather than assuming, since crediting the wrong one is
invisible on the board they are actually looking at.

## 6. Report back

Say how many were created per source, which were skipped as already-imported, and which stayed
unmatched and why. Reports score on the holder's highest-scoring camera and recompute immediately,
so mention that standings have already moved.
