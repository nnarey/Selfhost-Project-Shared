#!/usr/bin/env python3
"""Install a hand-exported Splunk CSV as the next leaderboard snapshot.

Writes data/snapshots/YYYY-MM-DD.csv plus a sibling .json, and the rolling
data/splunk-activity.csv plus data/splunk-export-meta.json. The date and
windowHours come from the event times in the file, so a one-day export stays
one day and a longer export keeps its full span.

Does not import into SQLite and does not replace data/snapshots/2026-10-02.csv.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parents[1]
PHOENIX = ZoneInfo("America/Phoenix")
PROTECTED_DAY = "2026-10-02"
TIME_HEADERS = {"event time", "event_time_utc", "_time", "timestamp"}


def parse_event_time(raw: str) -> datetime | None:
    text = raw.strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", text):
        n = float(text)
        if not math.isfinite(n):
            return None
        ms = n if n > 1e12 else n * 1000
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=PHOENIX)
    return parsed


def event_times(csv_text: str) -> tuple[list[datetime], int]:
    reader = csv.DictReader(io.StringIO(csv_text))
    if not reader.fieldnames:
        raise SystemExit("CSV has no header")
    field = next((name for name in reader.fieldnames if name.strip().lower() in TIME_HEADERS), None)
    if field is None:
        raise SystemExit(f"CSV has no Event Time column (headers: {', '.join(reader.fieldnames)})")
    times = []
    rows = 0
    for row in reader:
        if not any((value or "").strip() for value in row.values()):
            continue
        rows += 1
        when = parse_event_time(row.get(field) or "")
        if when is not None:
            times.append(when)
    if not times:
        raise SystemExit("CSV has no parseable event times")
    return times, rows


def install(csv_path: Path, root: Path) -> dict:
    csv_text = csv_path.read_text(encoding="utf-8")
    if not csv_text.strip():
        raise SystemExit(f"CSV is empty: {csv_path}")
    times, row_count = event_times(csv_text)
    earliest = min(times).astimezone(PHOENIX)
    latest = max(times).astimezone(PHOENIX)
    day = latest.strftime("%Y-%m-%d")
    if day == PROTECTED_DAY:
        raise SystemExit(
            f"Refusing to replace data/snapshots/{PROTECTED_DAY}.csv. "
            "That file is the all-time export. Save this CSV under a later day."
        )
    span_hours = (latest - earliest).total_seconds() / 3600
    window_hours = max(1.0, float(math.ceil(span_hours))) if span_hours > 0 else 1.0
    snapshot_dir = root / "data" / "snapshots"
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    snapshot_csv = snapshot_dir / f"{day}.csv"
    meta = {
        "ok": True,
        "earliestTime": earliest.isoformat(),
        "latestTime": latest.isoformat(),
        "earliestPhoenixDay": earliest.strftime("%Y-%m-%d"),
        "latestPhoenixDay": day,
        "rowCount": row_count,
        "sha256": hashlib.sha256(csv_text.encode("utf-8")).hexdigest(),
        "splFile": "manual",
        "mode": "manual",
        "windowHours": window_hours,
    }
    encoded = json.dumps(meta, indent=2) + "\n"
    (root / "data").mkdir(parents=True, exist_ok=True)
    (root / "data" / "splunk-activity.csv").write_text(csv_text, encoding="utf-8")
    (root / "data" / "splunk-export-meta.json").write_text(encoded, encoding="utf-8")
    snapshot_csv.write_text(csv_text, encoding="utf-8")
    (snapshot_dir / f"{day}.json").write_text(encoded, encoding="utf-8")
    return {
        "snapshot": str(snapshot_csv),
        "rolling": str(root / "data" / "splunk-activity.csv"),
        "latestPhoenixDay": day,
        "rowCount": row_count,
        "windowHours": window_hours,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path, help="Splunk CSV exported by hand")
    parser.add_argument(
        "--root",
        type=Path,
        default=REPO_ROOT,
        help="Repo root to write under (default: this repo)",
    )
    args = parser.parse_args()
    csv_path = args.csv.expanduser().resolve()
    if not csv_path.is_file():
        raise SystemExit(f"CSV not found: {csv_path}")
    print(json.dumps(install(csv_path, args.root.resolve())))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        sys.exit(0)
