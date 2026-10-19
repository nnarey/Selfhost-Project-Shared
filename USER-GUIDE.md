# FieldCam self-host

Open the app at `http://localhost:5173` after `./start.sh`. Demo accounts use `@northline.example`.

## Participants

1. Open **Sign up** and submit your name and email.
2. Wait until an admin approves you.
3. Open **Devices**, check out a camera, and use it.
4. Open **Leaderboard** after the next import to see the week.
5. Post a finding in `#fieldcam-selfhost` if you want it credited.
6. Return the camera from **Devices** when you are done.

## Admins

Sign in at `/#/admin` with an allowlisted email and the admin password from `server/.env.local`.

1. Approve signups.
2. Import `server/fixtures/activity_events.csv` as the activity file and `server/fixtures/assignments.csv` as the Fleet assignment file.
3. Confirm the preview, then check the leaderboard.
4. Queue reminders. With no `SLACK_BOT_TOKEN`, they stay queued.
5. Credit a report. It scores as soon as you confirm it.

Fleet ownership stays in mock mode unless `FLEET_MODE=live` and Fleet credentials are set.
