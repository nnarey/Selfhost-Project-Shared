# Run the sample

1. Install Node 22.
2. From the repo root, run `./start.sh`.
3. Open `http://localhost:5173/#/leaderboard`.
4. Admin is `http://localhost:5173/#/admin`. Use `alice@northline.example` and the password in `server/.env.example` (`Password`, unless you changed it).

The server creates `server/data/fieldcam.sqlite` on first boot and imports `data/splunk-activity.csv` when that file exists. Generate it with:

```bash
cd server && npx tsx src/scripts/generateFixtures.ts
python3 ../scripts/etl_splunk_activity.py
```

Admins are listed in `server/src/config/adminEmails.ts`. Add an `@northline.example` address there if you want another one.

Slack, Splunk, Jira, and Fleet are mocked. See the README for where each adapter lives. Do not put real tokens in committed files. Use `server/.env.local`, which is gitignored.
