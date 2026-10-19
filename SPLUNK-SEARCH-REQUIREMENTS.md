# Sample Splunk search

`web/splunk-search.spl` is a short search against `index=fieldcam_demo`. It shows the columns the importer scores:

- `recording`
- `upload`
- `livestream`
- `pov_state`
- `locationtime`
- `mobile`

`scripts/etl_splunk_activity.py` does not run that search. It copies the synthetic fixture into `data/splunk-activity.csv` and records `https://splunk.example` in `data/splunk-export-meta.json`.

A live job would send the same SPL to `SPLUNK_BASE_URL` with `SPLUNK_TOKEN`. Those values stay empty in this folder.
