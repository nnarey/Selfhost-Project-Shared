/* Windowed stats + better/worse trends. Throwaway DATABASE_PATH. */
import { getDb, nowISO } from "../../db.js";
import {
  getStatsDashboard,
  noTrend,
  parseStatsWindow,
  rateTrend,
  volumeTrend,
} from "../../scoring/engine.js";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  <- ${detail}`}`);
  cond ? pass++ : fail++;
};
const eq = (name: string, got: unknown, want: unknown) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `  ${same ? "PASS" : "FAIL"}  ${name}${same ? "" : `\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`}`,
  );
  same ? pass++ : fail++;
};

console.log("\n=== volumeTrend / rateTrend ===");
eq("more recordings is better", volumeTrend(12, 8).tone, "better");
eq("fewer recordings is worse", volumeTrend(3, 10).tone, "worse");
eq("same volume is flat", volumeTrend(4, 4).direction, "flat");
eq("both-zero is unknown", volumeTrend(0, 0).direction, "unknown");
eq("12 vs empty prior is up", volumeTrend(12, 0).direction, "up");

eq("higher rate is better", rateTrend(99.2, 97.0).tone, "better");
eq("lower rate is worse", rateTrend(90, 99).tone, "worse");
eq("0.4pp is flat", rateTrend(99.2, 99.0).direction, "flat");
eq("missing last rate is unknown", rateTrend(null, 99).direction, "unknown");
eq("missing prior rate is unknown", rateTrend(99, null).direction, "unknown");

eq("all-time has no comparison", noTrend(42).direction, "unknown");
eq("all-time comparison is not scored", noTrend(42).tone, "neutral");

console.log("\n=== parseStatsWindow ===");
eq("24h round-trips", parseStatsWindow("24h"), "24h");
eq("7d round-trips", parseStatsWindow("7d"), "7d");
eq("14d round-trips", parseStatsWindow("14d"), "14d");
eq("all round-trips", parseStatsWindow("all"), "all");
eq("unknown key falls back to 24h", parseStatsWindow("30d"), "24h");
eq("absent key falls back to 24h", parseStatsWindow(undefined), "24h");

const db = getDb();
const now = new Date("2026-09-09T18:00:00.000Z");
const created = nowISO();
const lastT = new Date(now.getTime() - 1 * 3600_000).toISOString();
const priorT = new Date(now.getTime() - 30 * 3600_000).toISOString();
const oldT = new Date(now.getTime() - 80 * 3600_000).toISOString();

db.prepare(
  `INSERT OR REPLACE INTO participants (email,name,signup_status,camera_id,enrolled_at,updated_at,created_at)
   VALUES ('stat@northline.example','stat','approved','CAM-S',?,?,?)`,
).run(created, created, created);
db.prepare(`INSERT OR REPLACE INTO cameras (camera_id,label,created_at) VALUES ('CAM-S','CAM-S',?)`).run(
  created,
);
db.prepare(
  `INSERT OR REPLACE INTO assignment_history
   (assignment_id,camera_id,email,assigned_at_utc,unassigned_at_utc,source,status,import_batch_id,created_at)
   VALUES ('a-s','CAM-S','stat@northline.example',?,NULL,'fleet','open',NULL,?)`,
).run(oldT, created);

const ins = db.prepare(
  `INSERT OR REPLACE INTO activity_events
   (event_id,event_time_utc,camera_id,event_type,duration_seconds,purpose,status,email,week_start,created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
);

ins.run(
  "rec-last",
  lastT,
  "CAM-S",
  "recording",
  120,
  "PURPOSE_STANDARD",
  "success",
  "stat@northline.example",
  "2026-09-07",
  created,
);
ins.run(
  "rec-prior",
  priorT,
  "CAM-S",
  "recording",
  90,
  "PURPOSE_STANDARD",
  "success",
  "stat@northline.example",
  "2026-09-07",
  created,
);
ins.run(
  "rec-old",
  oldT,
  "CAM-S",
  "recording",
  60,
  "PURPOSE_STANDARD",
  "success",
  "stat@northline.example",
  "2026-08-31",
  created,
);
ins.run("up-last", lastT, "CAM-S", "upload", 10, null, "success", "stat@northline.example", "2026-09-07", created);
ins.run("up-fail-last", lastT, "CAM-S", "upload", 10, null, "failed", "stat@northline.example", "2026-09-07", created);
ins.run("up-prior", priorT, "CAM-S", "upload", 10, null, "success", "stat@northline.example", "2026-09-07", created);
ins.run("bat-last", lastT, "CAM-S", "battery", 14400, null, "success", "stat@northline.example", "2026-09-07", created);
ins.run("bat-prior-fail", priorT, "CAM-S", "battery", 14400, null, "failed", "stat@northline.example", "2026-09-07", created);

db.prepare(
  `INSERT OR REPLACE INTO reports
   (report_id,email,reported_at_utc,status,week_start,created_at)
   VALUES ('r1','stat@northline.example',?,'approved','2026-09-07',?)`,
).run(lastT, created);

console.log("\n=== getStatsDashboard: 24h window ===");
const dash = getStatsDashboard(now, "24h");
eq("last 24h recordings", dash.current.totalRecordings, 1);
eq("prior 24h recordings", dash.previous?.totalRecordings, 1);
eq("all-time recordings", dash.totalRecordings, 3);
eq("last 24h not empty", dash.current.empty, false);
eq("recording volume flat vs prior", dash.volumeTrends.totalRecordings.direction, "flat");
eq("last 24h uploads (success only)", dash.current.totalUploads, 1);
eq("last 24h reports", dash.current.totalReports, 1);
eq("window echoes the key it resolved", dash.window.key, "24h");
eq("window hours", dash.window.hours, 24);

const bat = dash.current.reliability.find((m) => m.key === "battery");
ok("battery last 24h measured", (bat?.total ?? 0) === 1 && bat?.rate === 100, JSON.stringify(bat));
eq("battery rate trend better vs prior fail", bat?.trend?.tone, "better");

const uploadRel = dash.current.reliability.find((m) => m.key === "upload");
ok(
  "upload last 24h is 50%",
  uploadRel?.rate === 50 && uploadRel.total === 2,
  JSON.stringify(uploadRel),
);

const failRow = dash.deviceFailures.find((r) => r.cameraId === "CAM-S");
eq("upload failures last 24h on camera", failRow?.uploadFailuresLast24h, 1);
eq("camera uploads scoped to the 24h window", failRow?.uploadTotal, 2);

console.log("\n=== getStatsDashboard: 7d window ===");
// Three recordings sit at 1h, 30h and 80h back, so seven days catches all three and the
// 24h window catches one. Nothing precedes the oldest, so the prior 7d span is empty.
const week = getStatsDashboard(now, "7d");
eq("7d recordings", week.current.totalRecordings, 3);
eq("7d window label", week.window.label, "Last 7 days");
eq("7d prose form reads mid-sentence", week.window.phrase, "the last 7 days");
eq("7d uploads (success only)", week.current.totalUploads, 2);
eq("prior 7d is empty", week.previous?.empty, true);
eq("more recordings than the empty prior week", week.volumeTrends.totalRecordings.direction, "up");
eq("camera uploads scoped to the 7d window", week.deviceFailures.find((r) => r.cameraId === "CAM-S")?.uploadTotal, 3);
eq(
  "camera 'failed in 24h' keeps its own anchor at a wider window",
  week.deviceFailures.find((r) => r.cameraId === "CAM-S")?.uploadFailuresLast24h,
  1,
);

console.log("\n=== getStatsDashboard: 14d window ===");
const fortnight = getStatsDashboard(now, "14d");
eq("14d recordings", fortnight.current.totalRecordings, 3);
eq("14d window hours", fortnight.window.hours, 336);

console.log("\n=== getStatsDashboard: all time ===");
const allTime = getStatsDashboard(now, "all");
eq("all-time window matches the all-time totals", allTime.current.totalRecordings, allTime.totalRecordings);
eq("all-time has no prior window", allTime.previous, null);
eq("all-time hours is null", allTime.window.hours, null);
eq("all-time prose form reads mid-sentence", allTime.window.phrase, "the whole program");
eq("all-time trends are unknown", allTime.volumeTrends.totalRecordings.direction, "unknown");
eq("all-time trends are not scored", allTime.volumeTrends.totalRecordings.tone, "neutral");
eq("all-time since is the earliest event", allTime.window.sinceUtc, oldT);
eq(
  "all-time reliability carries no comparison",
  allTime.current.reliability.find((m) => m.key === "upload")?.trend?.direction,
  "unknown",
);
eq(
  "all-time camera table counts every upload",
  allTime.deviceFailures.find((r) => r.cameraId === "CAM-S")?.uploadTotal,
  3,
);

console.log("\n=== empty last 24h ===");
const quiet = getStatsDashboard(new Date("2026-01-01T00:00:00.000Z"), "24h");
ok("future-past now sees no last-24h activity", quiet.current.empty, JSON.stringify(quiet.current));
eq("quiet volume trend unknown", quiet.volumeTrends.totalRecordings.direction, "unknown");

db.prepare(
  `INSERT OR REPLACE INTO import_batches
   (batch_id, status, export_time_utc, created_at, committed_at)
   VALUES ('snap-1', 'committed', ?, ?, ?)`,
).run(now.toISOString(), created, created);

const later = getStatsDashboard(new Date("2026-09-11T18:00:00.000Z"));
eq(
  "last 24h is still relative to snapshot when wall clock is two days later",
  later.current.totalRecordings,
  1,
);
eq("prior 24h still relative to snapshot", later.previous?.totalRecordings, 1);
eq("window until is snapshot export time", later.window.asOfUtc, now.toISOString());

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
if (fail > 0) throw new Error(`${fail} assertions failed`);
