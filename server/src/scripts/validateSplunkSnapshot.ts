/**
 * Pre-deploy check: import data/splunk-activity.csv the same way Harbor does, then print
 * the /api/stats payload the Stats page renders. Does not call Splunk or Harbor.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run validate:snapshot
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { fileURLToPath } from "node:url";
import { getDb, nowISO } from "../db.js";
import { ensureDefaultMappingProfiles } from "../import/mapping.js";
import { importCommittedSplunkSnapshot } from "../import/snapshot.js";
import {
  getDeviceFailures,
  getOverallStats,
  getReliabilityMetrics,
  getUploadTransports,
  getWeeklyStats,
} from "../scoring/engine.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const csvPath = process.env.SPLUNK_SNAPSHOT_PATH
  ? path.resolve(process.env.SPLUNK_SNAPSHOT_PATH)
  : path.join(repoRoot, "data/splunk-activity.csv");

ensureDefaultMappingProfiles();
getDb();

const csv = fs.readFileSync(csvPath, "utf8");
const parsed = parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true }) as Record<
  string,
  string
>[];
const csvRows = parsed.length;
const cameras = new Set(
  parsed.map((r) => (r["Camera ID"] || r.camera_id || "").trim()).filter(Boolean),
);

function printStats(label: string) {
  const overall = getOverallStats();
  const reliability = getReliabilityMetrics();
  const failures = getDeviceFailures();
  const transports = getUploadTransports();
  const weeks = getWeeklyStats();
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify({ overall, reliability, uploadTransports: transports, deviceFailures: failures.length, weeklyWeeks: weeks.length }, null, 2));
  return overall;
}

console.log(`CSV ${csvPath} rows=${csvRows} cameras=${cameras.size}`);

function errorBreakdown(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT message, count(*) AS c FROM import_errors GROUP BY message ORDER BY c DESC`)
    .all() as Array<{ message: string; c: number }>;
  return Object.fromEntries(rows.map((r) => [r.message, r.c]));
}

const noAssign = importCommittedSplunkSnapshot(csvPath);
console.log("Harbor-like import (no assignments)", noAssign);
console.log("import errors", errorBreakdown());
const empty = printStats("Stats with no assignment_history (what Harbor shows if Fleet CSV was never uploaded)");

const now = nowISO();
const db = getDb();
const assignedAt = "2026-08-01T00:00:00.000Z";
for (const cameraId of cameras) {
  const email = `holder+${cameraId.toLowerCase()}@northline.example`;
  db.prepare(
    `INSERT OR REPLACE INTO participants (email,name,signup_status,camera_id,enrolled_at,updated_at,created_at)
     VALUES (?,?, 'approved', ?, ?, ?, ?)`,
  ).run(email, cameraId, cameraId, assignedAt, now, now);
  db.prepare(`INSERT OR IGNORE INTO cameras (camera_id,label,created_at) VALUES (?, ?, ?)`).run(
    cameraId,
    cameraId,
    now,
  );
  db.prepare(
    `INSERT OR REPLACE INTO assignment_history
     (assignment_id,camera_id,email,assigned_at_utc,unassigned_at_utc,source,status,import_batch_id,created_at)
     VALUES (?, ?, ?, ?, NULL, 'fleet', 'open', NULL, ?)`,
  ).run(`validate-${cameraId}`, cameraId, email, assignedAt, now);
}

const withAssign = importCommittedSplunkSnapshot(csvPath);
console.log("Import after synthetic open assignments", withAssign);
const filled = printStats("Stats the UI would show once cameras have holders");

if (empty.totalRecordings !== 0) {
  console.error("Expected zero Stats recordings without assignments");
  process.exit(1);
}
if (filled.totalRecordings < 1) {
  console.error("FAIL: CSV did not produce Stats recordings even with assignments (mapping or two-week window)");
  process.exit(1);
}
if ((withAssign.acceptedActivity ?? 0) < 1) {
  console.error("FAIL: acceptedActivity is 0 with assignments");
  process.exit(1);
}
console.log(
  `\nOK: Stats totalRecordings=${filled.totalRecordings} uploads=${filled.totalUploads} cameras=${filled.distinctCameras} (CSV ${csvRows} rows, ${cameras.size} cameras)`,
);
console.log(
  "Harbor Stats tiles read GET /api/stats. Confirm those numbers after deploy: Admin → Import quarantine should be 0 if Fleet assignments cover these cameras.",
);
