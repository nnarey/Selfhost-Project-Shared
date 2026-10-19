#!/usr/bin/env python3
"""Dev helper: probe which Splunk export path accepts the token. Do not commit secrets."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

web = Path(__file__).resolve().parents[1]
env: dict[str, str] = {}
for line in (web / ".env.local").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k.strip()] = v.strip().strip("'\"")

token = env.get("SPLUNK_TOKEN", "")
base = env.get(
    "SPLUNK_BASE_URL", "https://splunk.example"
).rstrip("/")

# Tiny search — just validates auth/path
search = "| makeresults count=1 | eval host=\"probe\" | table host"
body = urllib.parse.urlencode(
    {"search": search, "output_mode": "json", "exec_mode": "oneshot"}
).encode()

paths = [
    "/en-US/services/search/jobs/export",
    "/en-US/splunkd/__raw/services/search/jobs/export",
    "/services/search/jobs/export",
]

for path in paths:
    for style in ("Bearer", "Splunk"):
        req = urllib.request.Request(base + path, data=body, method="POST")
        req.add_header("Authorization", f"{style} {token}")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()[:240]
                print(f"OK {style} {path} status={resp.status} body={raw!r}")
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location", "") if e.headers else ""
            err = e.read()[:200].decode("utf-8", "replace")
            print(f"FAIL {style} {path} code={e.code} loc={loc} body={err!r}")
        except Exception as e:
            print(f"ERR {style} {path} {type(e).__name__}: {e}")

# JWT claims (no signature verification) — host hints only
try:
    import base64

    payload_b64 = token.split(".")[1]
    pad = "=" * ((4 - len(payload_b64) % 4) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload_b64 + pad))
    print(
        "JWT:",
        {k: claims.get(k) for k in ("iss", "sub", "aud", "idp")},
    )
except Exception as e:
    print("JWT decode failed:", e)
