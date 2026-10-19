# Activity snapshots

`splunk-activity.csv` is the file the server imports on boot. In this sample it is a copy of `server/fixtures/activity_events.csv`, written by `scripts/etl_splunk_activity.py`.

`roster.json` is the fictional Northline roster, including camera assignment history. The server loads that history before the activity snapshot, which is what lets a fresh database score the demo. Do not commit a live database under `server/data/`.
