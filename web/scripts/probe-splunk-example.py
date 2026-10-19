#!/usr/bin/env python3
import ssl
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

web = Path(__file__).resolve().parents[1]
token = ""
env_file = web / ".env.local"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        if line.startswith("SPLUNK_TOKEN="):
            token = line.split("=", 1)[1].strip().strip("'\"")

body = urllib.parse.urlencode(
    {
        "search": "| makeresults count=1 | eval host=\"probe\" | table host",
        "output_mode": "json",
        "exec_mode": "oneshot",
    }
).encode()
ctx = ssl._create_unverified_context()

tests = [
    ("https://splunk.example/services/search/jobs/export", "Bearer"),
    ("https://splunk.example/services/search/jobs/export", "Splunk"),
    ("https://splunk.example/services/search/jobs/export", "Bearer"),
    (
        "https://splunk.example/en-US/splunkd/__raw/services/search/jobs/export",
        "Bearer",
    ),
    (
        "https://splunk.example/en-US/splunkd/__raw/services/search/jobs/export",
        "Splunk",
    ),
]

for url, style in tests:
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Authorization", f"{style} {token}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=8, context=ctx) as r:
            b = r.read(160)
            html = b"<html" in b.lower() or b"submitForm" in b
            print(f"OK {style} {url} status={r.status} html={html} body={b[:100]!r}")
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location", "") if e.headers else ""
        err = e.read(120)
        print(f"FAIL {style} {url} code={e.code} loc={loc} body={err!r}")
    except Exception as e:
        print(f"ERR {style} {url} {type(e).__name__}: {e}")
