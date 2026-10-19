---
name: send-fieldcam-reminders
description: Drain the FieldCam Self-Host pending Slack reminder queue — preview who's eligible for an onboarding or inactivity nudge, queue them against the admin API, and deliver the actual Slack DMs. Use whenever the user asks to send FieldCam reminders, nudge participants who haven't recorded, chase inactive FieldCam self-host testers, or invokes /send-fieldcam-reminders. Also trigger on "who needs a nudge" / "what reminders are pending" even if they don't want to send yet — the preview step alone answers that.
---

# Send FieldCam reminders

This drives the FieldCam Self-Host app's reminder pipeline (`server/src/reminders.ts`), which nudges
participants who haven't onboarded or gone quiet on recording. It is a two-stage system: **queue**
(server-side, always safe — just marks who *should* get nudged) and **send** (an actual Slack DM to
a real person, which needs the user's go-ahead per this session's messaging rules).

## 0. Pick the target API base

Default to the local dev server: `http://localhost:8787`. If the user says they mean the live/Harbor
deployment, ask for that base URL instead — don't guess it.

Check the server is actually up before doing anything else:

```bash
curl -s http://localhost:8787/health
```

## 1. Log in as admin

Admin actions need a bearer token. Admins are a fixed allowlist: `alice@northline.example`,
`bob@northline.example`, `cara@northline.example` (see `server/src/config/adminEmails.ts`). The password is
`ADMIN_PASSWORD` from `server/.env.local`. Read it from there rather than assuming a value — it is
meant to be rotated, and a stale literal just produces a confusing 401.

```bash
curl -s -X POST http://localhost:8787/api/admin/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"you@northline.example\",\"password\":\"$ADMIN_PASSWORD\"}"
```

This returns `{ token, expiresAt, email }`. Use `token` as `Authorization: Bearer <token>` on every
call below. If login fails, ask the user for the correct admin email/password rather than guessing
at other credentials.

## 2. Preview who's eligible

```bash
curl -s http://localhost:8787/api/admin/reminders/preview \
  -H "Authorization: Bearer <token>"
```

This returns `{ freshness, blocked, blockReason, candidates }`. Each candidate has `email`, `name`,
`cameraId`, `kind` (`"onboarding"` or `"inactivity"`), `reason`, and the exact `text` that would be
sent.

**If `blocked` is true** (stale or missing activity import — the server blocks reminders when the
Splunk export is >24h old or never imported), stop here and tell the user: reminders can't queue
until an admin imports a fresh CSV batch. Don't try to work around this.

Show the user the candidate list before doing anything else — this is the "who would get nudged"
answer, and it's often all they actually asked for.

## 3. Queue the selected recipients

Only queue people the user actually wants nudged (default to "all eligible candidates" if they say
"send reminders" without qualification, but confirm the list first since this is about to become a
real message to real people).

```bash
curl -s -X POST http://localhost:8787/api/admin/reminders/queue \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"emails":["person1@northline.example","person2@northline.example"]}'
```

Response: `{ queued, ids, sent, failed, autoSend }`.

- **If `autoSend` is `true`**: the server already sent the Slack DMs itself (it has `SLACK_BOT_TOKEN`
  configured and `REMINDER_AUTO_SEND` isn't disabled). Nothing more to do — report `sent`/`failed`
  counts to the user and stop.
- **If `autoSend` is `false`** (the common case in local dev, where no bot token is configured): the
  reminders are queued but *not yet delivered*. Continue to step 4 — you'll be the one sending them,
  via Slack.

## 4. Deliver queued nudges via Slack (only when autoSend was false)

Fetch what's actually queued and still needs sending:

```bash
curl -s "http://localhost:8787/api/admin/reminders/pending?status=queued" \
  -H "Authorization: Bearer <token>"
```

Each nudge has `id`, `email`, `name`, `cameraId`, `kind`, `text`.

**Before sending anything, show the user the exact recipient list and message text and get explicit
confirmation.** Sending a Slack DM to someone is a real message on the user's behalf — don't send
without a clear go-ahead, even if they already said "send reminders" once (that approved queueing,
not necessarily the final send if you're about to show them who's actually on the list).

Once confirmed, for each nudge:

1. **Pass the recipient's email straight through as the `channel`** on `send_slack_message` — that
   parameter takes a channel ID, a channel name, or usernames/emails, so `alice@northline.example` works as
   written. Do not look up and pass a `U*`/`W*` user ID; the tool rejects those. Do not guess a
   handle from the email's local-part either — you do not need to.
2. Send the nudge's `text` **verbatim**. It is tuned copy that already names their camera and
   inactivity window, and onboarding copy (`server/src/onboardingMessage.ts`) is written with Slack
   emoji shortcodes like `:party_blob:` that render only if left alone. Do not reword it, do not
   make it friendlier, and do not convert shortcodes to Unicode emoji.
3. If `send_slack_message` fails, `send_slack_bot_message` is the fallback — but it may reject an
   email as the channel, so it is second choice, not first.
4. Track success or failure per nudge `id`. Never invent a successful send; if Slack MCP is
   unavailable, stop and say so rather than marking anything sent.

## 5. Record the send results

This is what actually updates each nudge's status and (for successful sends) the participant's
`last_slack_nudge_at`, so they don't get re-nudged before the 24h cooldown:

```bash
curl -s -X POST http://localhost:8787/api/admin/reminders/mark-sent \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"dryRun": false, "results": [{"id":"<nudge-id>","status":"sent"}, {"id":"<nudge-id-2>","status":"failed","error":"user not found in Slack"}]}'
```

Note: if the server has `REMINDER_LIVE_ALLOWLIST` set, it will silently downgrade any `"sent"` result
for an email not on that allowlist to `"failed"` — the response tells you which ones. An empty
allowlist means every queued recipient is allowed. Report the final counts to the user.

Passing `"dryRun": true` instead marks nothing and audits `reminders.send_dry_run`. That is a
rehearsal of the bookkeeping only — it does **not** make the Slack sends in step 4 safe, since those
already went out. Use it to check the call shape before you send, not after.

## Report back

Summarize: how many were eligible, how many were queued, how many DMs actually went out vs failed
(and why, if known), and whether anything is still blocked (stale import, missing Slack match, etc).
