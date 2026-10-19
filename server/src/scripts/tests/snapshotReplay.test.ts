/*
 * A day the server never booted through must not be lost.
 *
 * data/splunk-activity.csv is a rolling 24h slice the GitHub Action overwrites each morning, and
 * the server only imports at boot. The ETL now also writes data/snapshots/YYYY-MM-DD.csv, and
 * importMissedSnapshots replays anything the database has not seen.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, nowISO } from "../../db.js";
import { ensureDefaultMappingProfiles } from "../../import/mapping.js";
import { importCommittedSplunkSnapshot, importMissedSnapshots } from "../../import/snapshot.js";

ensureDefaultMappingProfiles();
const db = getDb();
const now = nowISO();
let pass = 0, fail = 0;
const ok = (n: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${n}${cond ? "" : `  <- ${detail}`}`);
  cond ? pass++ : fail++;
};

db.prepare(`INSERT OR REPLACE INTO participants (email,name,signup_status,camera_id,enrolled_at,updated_at,created_at)
            VALUES ('rp@northline.example','rp','approved','FC-7001',?,?,?)`).run(now, now, now);
db.prepare(`INSERT OR REPLACE INTO cameras (camera_id,label,created_at) VALUES ('FC-7001','FC-7001',?)`).run(now);
db.prepare(`INSERT OR REPLACE INTO assignment_history
  (assignment_id,camera_id,email,assigned_at_utc,unassigned_at_utc,source,status,import_batch_id,created_at)
  VALUES ('rp-a','FC-7001','rp@northline.example',?,NULL,'fleet','open',NULL,?)`)
  .run(new Date(Date.now() - 30 * 24 * 3600_000).toISOString(), now);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fieldcam-replay-"));
const snapDir = path.join(root, "snapshots");
fs.mkdirSync(snapDir);

const HEADER = `"Event Time","Camera ID","Event Type","Event","Stable Event ID","Recording ID","Clip ID","Duration (seconds)","Purpose","Status","Avg Power (mW)","Upload Success","Livestream Success","Upload Transport"`;
// Pinned once. Deriving each day string from its own Date.now() meant a midnight boundary between
// two writeDay calls could move a filename out from under the assertion that expects it.
const CLOCK = Date.now();
/** One recording, dated `daysAgo`, with a sibling meta so the lookback anchors to that day. */
function writeDay(daysAgo: number, id: string) {
  const exportAt = new Date(CLOCK - daysAgo * 24 * 3600_000);
  const day = exportAt.toISOString().slice(0, 10);
  const eventAt = new Date(exportAt.getTime() - 2 * 3600_000).toISOString();
  fs.writeFileSync(
    path.join(snapDir, `${day}.csv`),
    [HEADER, `"${eventAt}",FC-7001,recording,RecordingStopped,${id},${id},,120,PURPOSE_STANDARD,success,,,,`].join("\n"),
  );
  fs.writeFileSync(path.join(snapDir, `${day}.json`), JSON.stringify({ latestTime: exportAt.toISOString() }));
  return { day, id };
}

const d5 = writeDay(5, "replay-5");
const d3 = writeDay(3, "replay-3");

const countIds = () =>
  (db.prepare(`SELECT COUNT(*) c FROM activity_events WHERE event_id LIKE 'replay-%'`).get() as { c: number }).c;

ok("A0 nothing imported yet", countIds() === 0);

// Anchor the rolling path inside the temp root so snapshots/ resolves next to it.
const first = importMissedSnapshots(snapDir);
ok("A1 both archived days replayed", first.imported === 2, JSON.stringify(first));
ok("A2 replayed oldest first", JSON.stringify(first.days) === JSON.stringify([d5.day, d3.day].sort()), JSON.stringify(first.days));
ok("A3 both events landed", countIds() === 2, String(countIds()));

// Boot runs this every time; a second pass must be a no-op rather than a re-import.
const second = importMissedSnapshots(snapDir);
ok("A4 second pass imports nothing", second.imported === 0, JSON.stringify(second));
ok("A5 no duplicate rows", countIds() === 2, String(countIds()));

// Quarantine leftover must not replay archives on every boot.
db.prepare(
  `INSERT INTO quarantined_activity
    (event_id, event_time_utc, camera_id, event_type, duration_seconds, purpose, status, batch_id, reason, created_at)
   VALUES ('orphan-boot', ?, 'FC-9999', 'recording', 10, NULL, NULL, NULL, 'no holder', ?)`,
).run(now, now);
const whileQuarantined = importMissedSnapshots(snapDir);
ok(
  "A9 leftover quarantine does not re-import archives",
  whileQuarantined.imported === 0,
  JSON.stringify(whileQuarantined),
);
ok("A10 still no duplicate rows", countIds() === 2, String(countIds()));

// A corrupt archived day must not block the rest.
fs.writeFileSync(path.join(snapDir, "2099-01-01.csv"), "not,a,valid\nexport,at,all");
const third = importMissedSnapshots(snapDir);
ok("A6 a bad file does not throw", third.scanned >= 3, JSON.stringify(third));
ok("A7 good rows still intact", countIds() === 2, String(countIds()));

// Missing directory is the normal state before the first archived day exists.
const none = importMissedSnapshots(path.join(root, "nope"));
ok("A8 missing archive dir is a no-op", none.scanned === 0 && none.imported === 0);

void importCommittedSplunkSnapshot;
/*
 * A wide backfill must import. The lookback defaults to 36h, so a 14-day export would have every
 * row past the first day and a half rejected - the reason backfilling used to be impossible even
 * with the data in hand. An export that declares its span in the meta gets a matching window.
 */
console.log("\n=== wide backfill ===");
function writeWide(days: number, windowHours: number | undefined, id: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fieldcam-wide-"));
  const exportAt = new Date(CLOCK);
  const eventAt = new Date(exportAt.getTime() - days * 24 * 3600_000).toISOString();
  const meta: Record<string, unknown> = { latestTime: exportAt.toISOString() };
  if (windowHours !== undefined) meta.windowHours = windowHours;
  fs.writeFileSync(path.join(dir, "splunk-export-meta.json"), JSON.stringify(meta));
  const p = path.join(dir, "splunk-activity.csv");
  fs.writeFileSync(p, [HEADER, `"${eventAt}",FC-7001,recording,RecordingStopped,${id},${id},,120,PURPOSE_STANDARD,success,,,,`].join("\n"));
  return p;
}

const noDecl = importCommittedSplunkSnapshot(writeWide(10, undefined, "wide-nodecl"));
ok("B1 a 10-day-old row is rejected when no span is declared",
   !noDecl.skipped && (noDecl.acceptedActivity ?? 0) === 0, JSON.stringify(noDecl));

const decl = importCommittedSplunkSnapshot(writeWide(10, 14 * 24, "wide-decl"));
ok("B2 ...and accepted when the export declares a 14-day span",
   !decl.skipped && (decl.acceptedActivity ?? 0) === 1, JSON.stringify(decl));

const tooOld = importCommittedSplunkSnapshot(writeWide(20, 14 * 24, "wide-toofar"));
ok("B3 a declared span does not become unlimited",
   !tooOld.skipped && (tooOld.acceptedActivity ?? 0) === 0, JSON.stringify(tooOld));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
