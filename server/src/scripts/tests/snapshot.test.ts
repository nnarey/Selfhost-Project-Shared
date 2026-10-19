/* Snapshot import skips empty/header-only CSV and does not call Splunk. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, nowISO } from "../../db.js";
import { importCommittedSplunkSnapshot } from "../../import/snapshot.js";
import { ensureDefaultMappingProfiles } from "../../import/mapping.js";
import { isInImportLookback } from "../../week.js";
import { getReliabilityMetrics } from "../../scoring/engine.js";

ensureDefaultMappingProfiles();
getDb();

const now = nowISO();
dbSeed();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  <- ${detail}`}`);
  cond ? pass++ : fail++;
};

function dbSeed() {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO participants (email,name,signup_status,camera_id,enrolled_at,updated_at,created_at)
     VALUES ('snap@northline.example','snap','approved','FC-0001',?,?,?)`,
  ).run(now, now, now);
  db.prepare(`INSERT OR REPLACE INTO cameras (camera_id,label,created_at) VALUES ('FC-0001','FC-0001',?)`).run(
    now,
  );
  db.prepare(
    `INSERT OR REPLACE INTO assignment_history
     (assignment_id,camera_id,email,assigned_at_utc,unassigned_at_utc,source,status,import_batch_id,created_at)
     VALUES ('snap-a','FC-0001','snap@northline.example',?,NULL,'fleet','open',NULL,?)`,
  ).run(new Date(Date.now() - 48 * 3600_000).toISOString(), now);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fieldcam-snap-"));
const emptyPath = path.join(dir, "splunk-activity.csv");
fs.writeFileSync(
  emptyPath,
  `"Event Time","Camera ID","Event Type","Event","Stable Event ID","Recording ID","Clip ID","Duration (seconds)","Purpose","Status","Upload Success","Livestream Success","Upload Transport"\n`,
);

const missing = importCommittedSplunkSnapshot(path.join(dir, "nope.csv"));
ok("missing file skipped", missing.skipped && missing.reason === "missing");

const empty = importCommittedSplunkSnapshot(emptyPath);
ok("header-only CSV skipped", empty.skipped && empty.reason === "empty");

const t = new Date().toISOString();
const csv = [
  `"Event Time","Camera ID","Event Type","Event","Stable Event ID","Recording ID","Clip ID","Duration (seconds)","Purpose","Status","Upload Success","Livestream Success","Upload Transport"`,
  `"${t}",FC-0001,recording,RecordingStopped,rec-1,rec-1,,120,PURPOSE_STANDARD,success,,,`,
].join("\n");
const fullPath = path.join(dir, "full.csv");
fs.writeFileSync(fullPath, csv);
const imported = importCommittedSplunkSnapshot(fullPath);
ok("fixture CSV imported", !imported.skipped && (imported.acceptedActivity ?? 0) >= 1, JSON.stringify(imported));

const again = importCommittedSplunkSnapshot(fullPath);
ok("same hash skipped", again.skipped && again.reason === "unchanged");

const asOf = new Date("2026-09-08T21:00:00.000Z");
ok(
  "event 12h ago is inside 36h import lookback",
  isInImportLookback("2026-09-08T09:00:00.000Z", asOf),
);
ok(
  "event 48h ago is outside 36h import lookback",
  !isInImportLookback("2026-09-06T20:00:00.000Z", asOf),
);

/*
 * Replaying an old snapshot.
 *
 * The daily GHA overwrites data/splunk-activity.csv, so a day the server never booted through
 * survives only in git history. Judging its rows against wall-clock now rejected every one as
 * "outside last 36h"; the window is anchored to the batch's export_time_utc instead, so a
 * snapshot means the same thing whenever it is replayed.
 */
const oldExport = new Date(Date.now() - 6 * 24 * 3600_000);
// The seeded assignment only reaches back 48h, so without this the replayed event has no holder
// and lands in quarantine — which would prove nothing about the lookback.
getDb()
  .prepare(`UPDATE assignment_history SET assigned_at_utc = ? WHERE assignment_id = 'snap-a'`)
  .run(new Date(Date.now() - 10 * 24 * 3600_000).toISOString());
const oldEvent = new Date(oldExport.getTime() - 2 * 3600_000).toISOString();
const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "fieldcam-snap-old-"));
fs.writeFileSync(
  path.join(oldDir, "splunk-export-meta.json"),
  JSON.stringify({ latestTime: oldExport.toISOString() }),
);
const oldPath = path.join(oldDir, "splunk-activity.csv");
fs.writeFileSync(
  oldPath,
  [
    `"Event Time","Camera ID","Event Type","Event","Stable Event ID","Recording ID","Clip ID","Duration (seconds)","Purpose","Status","Upload Success","Livestream Success","Upload Transport"`,
    `"${oldEvent}",FC-0001,recording,RecordingStopped,rec-replay,rec-replay,,150,PURPOSE_STANDARD,success,,,`,
  ].join("\n"),
);
ok(
  "the replayed event is far outside a now-anchored window",
  !isInImportLookback(oldEvent, new Date()),
  oldEvent,
);
const replayed = importCommittedSplunkSnapshot(oldPath);
ok(
  "six-day-old snapshot still imports, judged against its own export time",
  !replayed.skipped && (replayed.acceptedActivity ?? 0) === 1,
  JSON.stringify(replayed),
);

const orphanCsv = [
  `"Event Time","Camera ID","Event Type","Event","Stable Event ID","Recording ID","Clip ID","Duration (seconds)","Purpose","Status","Upload Success","Livestream Success","Upload Transport"`,
  `"${t}",FC-0002,recording,RecordingStopped,rec-orphan,rec-orphan,,90,PURPOSE_STANDARD,success,,,`,
].join("\n");
const orphanPath = path.join(dir, "orphan.csv");
fs.writeFileSync(orphanPath, orphanCsv);
const quarantined = importCommittedSplunkSnapshot(orphanPath);
ok(
  "unassigned camera quarantined",
  !quarantined.skipped &&
    (quarantined.acceptedActivity ?? 0) === 0 &&
    (quarantined.quarantinedActivity ?? 0) >= 1,
  JSON.stringify(quarantined),
);
const skippedWhileQuarantined = importCommittedSplunkSnapshot(orphanPath);
ok(
  "same hash re-runs while quarantine remains",
  !skippedWhileQuarantined.skipped,
  JSON.stringify(skippedWhileQuarantined),
);

const relCsv = [
  `"Event Time","Camera ID","Event Type","Event","Stable Event ID","Recording ID","Clip ID","Duration (seconds)","Purpose","Status","Upload Success","Livestream Success","Upload Transport"`,
  `"${t}",FC-0001,locationTime,LocationRecordingPerformance,loc-1,rec-loc,,90,,success,,,`,
  `"${t}",FC-0001,availability,AvailabilityDay,avail-day-1,,,3600,,success,,,`,
  `"${t}",FC-0001,battery,ShiftSummary,shift-1,,,,,success,,,`,
].join("\n");
const relPath = path.join(dir, "reliability.csv");
fs.writeFileSync(relPath, relCsv);
const relImported = importCommittedSplunkSnapshot(relPath);
ok(
  "reliability event types accepted",
  !relImported.skipped && (relImported.acceptedActivity ?? 0) >= 3,
  JSON.stringify(relImported),
);
const rel = Object.fromEntries(getReliabilityMetrics().map((m) => [m.key, m]));
ok("locationTime measured", (rel.locationTime?.total ?? 0) >= 1);
ok("availability measured", (rel.availability?.total ?? 0) >= 1);
ok("battery measured", (rel.battery?.total ?? 0) >= 1);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
