#!/usr/bin/env python3
"""Write the FieldCam activity snapshot from the synthetic fixture.

This is the mock adapter for the daily Splunk job. It does not call a network.
A live deployment would POST web/splunk-search.spl to SPLUNK_BASE_URL
(default https://splunk.example) with SPLUNK_TOKEN and replace this copy step.
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = REPO_ROOT / "server" / "fixtures" / "activity_events.csv"
OUT_CSV = REPO_ROOT / "data" / "splunk-activity.csv"
OUT_META = REPO_ROOT / "data" / "splunk-export-meta.json"
SNAPSHOT_DIR = REPO_ROOT / "data" / "snapshots"


def main() -> None:
    if not FIXTURE.exists():
        raise SystemExit(
            f"Missing {FIXTURE}. From server/: npx tsx src/scripts/generateFixtures.ts"
        )
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(FIXTURE, OUT_CSV)
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    shutil.copyfile(FIXTURE, SNAPSHOT_DIR / f"{day}.csv")
    OUT_META.write_text(
        json.dumps(
            {
                "source": "fixture",
                "baseUrl": "https://splunk.example",
                "spl": "web/splunk-search.spl",
                "rowsFile": "data/splunk-activity.csv",
                "exportedAt": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
        + "\n"
    )
    print(f"Wrote mock Splunk snapshot to {OUT_CSV}")


if __name__ == "__main__":
    main()
