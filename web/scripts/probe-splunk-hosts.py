#!/usr/bin/env python3
"""Probe candidate Splunk REST bases with the local token. Prints status only."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

web = Path(__file__).resolve().parents[1]
token = ""
for line in (web / ".env.local").read_text().splitlines():
    if line.startswith("SPLUNK_TOKEN="):
        token = line.split("=", 1)[1].strip().strip("'\"")

search = "| makeresults count=1 | eval host=\"probe\" | table host"
body = urllib.parse.urlencode(
    {"search": search, "output_mode": "json", "exec_mode": "oneshot"}
).encode()

bases = [
    "https://splunk.example",
    "https://splunk.example",
    "https://splunk.example:8089",
]
paths = [
    "/services/search/jobs/export",
    "/en-US/splunkd/__raw/services/search/jobs/export",
]

for base in bases:
    for path in paths:
        for style in ("Bearer", "Splunk"):
            url = base.rstrip("/") + path
            req = urllib.request.Request(url, data=body, method="POST")
            req.add_header("Authorization", f"{style} {token}")
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
            try:
                ctx = None
                import ssl

                ctx = ssl._create_unverified_context()
                with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                    raw = resp.read()[:180]
                    looks_html = b"<html" in raw.lower() or b"submitForm" in raw
                    print(
                        f"OK {style} {url} status={resp.status} html={looks_html} body={raw[:120]!r}"
                    )
            except urllib.error.HTTPError as e:
                loc = e.headers.get("Location", "") if e.headers else ""
                err = e.read()[:120]
                print(f"FAIL {style} {url} code={e.code} loc={loc} body={err!r}")
            except Exception as e:
                print(f"ERR {style} {url} {type(e).__name__}: {e}")
