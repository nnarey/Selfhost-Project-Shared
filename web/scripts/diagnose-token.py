#!/usr/bin/env python3
import base64
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

web = Path(__file__).resolve().parents[1]
env: dict[str, str] = {}
for line in (web / ".env.local").read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip("'\"")

token = env.get("SPLUNK_TOKEN", "")
try:
    p = token.split(".")[1]
    pad = "=" * ((4 - len(p) % 4) % 4)
    claims = json.loads(base64.urlsafe_b64decode(p + pad))
    keep = {k: claims.get(k) for k in ("iss", "sub", "aud", "idp", "iat", "exp", "nbr")}
    print("CLAIMS", json.dumps(keep, indent=2))
except Exception as e:
    print("CLAIMS_ERR", e)

body = urllib.parse.urlencode(
    {
        "search": '| makeresults count=1 | eval host="probe" | table host',
        "output_mode": "json",
        "exec_mode": "oneshot",
    }
).encode()
ctx = ssl._create_unverified_context()
base = "https://splunk.example"

paths = [
    "/en-US/splunkd/__raw/services/search/jobs/export",
    "/en-US/splunkd/__raw/servicesNS/nobody/search/search/jobs/export",
    "/en-US/splunkd/__raw/servicesNS/nobody/fieldcam-search/search/jobs/export",
    "/en-US/splunkd/__raw/services/authentication/current-context",
]

for path in paths:
    for name in ("Bearer", "Splunk"):
        url = base + path
        req = urllib.request.Request(
            url,
            data=body if "jobs/export" in path else None,
            method="POST" if "jobs/export" in path else "GET",
        )
        req.add_header("Authorization", f"{name} {token}")
        if "jobs/export" in path:
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
                b = r.read(220)
                html = b"<html" in b.lower()
                print(f"OK {name} {path} {r.status} html={html} {b[:90]!r}")
        except urllib.error.HTTPError as e:
            err = e.read(220)
            print(f"FAIL {name} {path} {e.code} {err[:160]!r}")
        except Exception as e:
            print(f"ERR {name} {path} {type(e).__name__}: {e}")
