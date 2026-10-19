#!/usr/bin/env python3
"""Convert a raw Splunk PowerStateChanged export into the importer's CSV shape.

For when someone exports the raw events from the Splunk UI rather than running
web/splunk-search.spl through the ETL. This applies the same filters the SPL's power block
applies, so the result is what the daily pull would have produced:

  * Charging=false            — a docked camera reports charge current, not draw
  * OldState in buffering/recording/livestreaming — AvgPower describes the state just LEFT,
                                and IDLE/NOT_SET are not part of the modelled shift
  * AvgPower > 0              — fw is past the v0.2304 sign flip, so positive means discharging
  * SecondsInOldState >= 10   — excludes transition slivers
  * hashtree/upload < 20s     — the run book's noise filters

Usage:
  python3 scripts/convert_power_export.py <raw.csv> <out.csv> [--stats]
"""
import csv, sys, statistics
from collections import Counter

KEEP_STATES = {"STATE_BUFFERING", "STATE_RECORDING", "STATE_LIVESTREAMING"}
MIN_SECONDS = 10
NOISE_MS = 20000
OUT_HEADER = [
    "Event Time", "Camera ID", "Event Type", "Event", "Stable Event ID", "Recording ID",
    "Clip ID", "Duration (seconds)", "Purpose", "Status", "Avg Power (mW)",
    "Recording Resolution", "Upload Success", "Livestream Success", "Upload Transport",
]


def num(v, default=0.0):
    try:
        return float(str(v).strip().strip('"') or default)
    except (TypeError, ValueError):
        return default


def clean(v):
    return str(v or "").strip().strip('"')


def convert(src, dst, show_stats=False):
    with open(src, newline="", encoding="utf-8", errors="replace") as fh:
        rows = list(csv.DictReader(fh))

    kept, dropped = [], Counter()
    for r in rows:
        state = clean(r.get("OldState"))
        if clean(r.get("Charging")).lower() == "true":
            dropped["charging"] += 1
        elif state not in KEEP_STATES:
            dropped[f"state={state.replace('STATE_', '') or 'blank'}"] += 1
        elif num(r.get("AvgPower")) <= 0:
            dropped["AvgPower<=0"] += 1
        elif num(r.get("HashTreeCalculationMilliseconds")) >= NOISE_MS or num(r.get("UploadTimeMilliseconds")) >= NOISE_MS:
            dropped["noisy (hashtree/upload >=20s)"] += 1
        elif num(r.get("SecondsInOldState")) < MIN_SECONDS:
            dropped[f"under {MIN_SECONDS}s"] += 1
        else:
            kept.append(r)

    with open(dst, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(OUT_HEADER)
        for r in kept:
            t, host, state = clean(r.get("_time")), clean(r.get("host")), clean(r.get("OldState"))
            w.writerow([
                t, host, "power", "PowerStateChanged",
                f"{host}|power|{state}|{t}", "", "",
                int(num(r.get("SecondsInOldState"))), state, "success",
                int(num(r.get("AvgPower"))), clean(r.get("RecordingResolution")), "", "", "",
            ])

    print(f"{len(rows)} raw rows -> {len(kept)} usable")
    for reason, n in dropped.most_common():
        print(f"  dropped {n:>5}  {reason}")

    if show_stats and kept:
        times = sorted(clean(r["_time"]) for r in kept)
        print(f"\nspan: {times[0]}  ->  {times[-1]}")
        print(f"cameras: {len(set(clean(r['host']) for r in kept))}")
        for res in sorted(set(clean(r.get('RecordingResolution')) for r in kept)):
            sub = [r for r in kept if clean(r.get('RecordingResolution')) == res]
            print(f"\n  {res or '(blank)'}  n={len(sub)}")
            for st in sorted(KEEP_STATES):
                v = [num(r["AvgPower"]) for r in sub if clean(r["OldState"]) == st]
                if v:
                    print(f"    {st.replace('STATE_',''):<14} n={len(v):>4}  median={statistics.median(v):>7.0f} mW")
    return len(kept)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__)
        sys.exit(2)
    convert(args[0], args[1], show_stats="--stats" in sys.argv)
