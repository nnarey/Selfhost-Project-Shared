/* End-to-end: a PowerStateChanged row survives import and produces a shift estimate. */
import { getDb, nowISO } from "../../db.js";
import { ensureDefaultMappingProfiles } from "../../import/mapping.js";
import { beginImport, uploadImportFiles, previewImport, commitImport } from "../../import/pipeline.js";
import {
  getRuntimeEstimate,
  getStatsDashboard,
  shiftHoursFromPower,
  FIELDCAM_BATTERY_MAH,
  FIELDCAM_NOMINAL_VOLTS,
  FIELDCAM_RECORDING_HOURS,
} from "../../scoring/engine.js";

ensureDefaultMappingProfiles();
const db = getDb();
const now = nowISO();
let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const ok_ = (n: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${n}${cond ? "" : `  <- ${detail}`}`);
  cond ? pass++ : fail++;
};

db.prepare(`INSERT OR REPLACE INTO participants (email,name,signup_status,camera_id,enrolled_at,updated_at,created_at)
            VALUES ('pw@northline.example','pw','approved','FC-9001',?,?,?)`).run(now, now, now);
db.prepare(`INSERT OR REPLACE INTO cameras (camera_id,label,created_at) VALUES ('FC-9001','FC-9001',?)`).run(now);
db.prepare(`INSERT OR REPLACE INTO assignment_history
  (assignment_id,camera_id,email,assigned_at_utc,unassigned_at_utc,source,status,import_batch_id,created_at)
  VALUES ('pw-a','FC-9001','pw@northline.example',?,NULL,'fleet','open',NULL,?)`)
  .run(new Date(Date.now() - 72 * 3600_000).toISOString(), now);

const t = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const header = `"Event Time","Camera ID","Event Type","Event","Stable Event ID","Recording ID","Clip ID","Duration (seconds)","Purpose","Status","Avg Power (mW)","Recording Resolution","Upload Success","Livestream Success","Upload Transport"`;
// Three buffering samples (median 800) and three recording (median 1500).
const rows: string[] = [
  [10, "STATE_BUFFERING", 700], [11, "STATE_BUFFERING", 800], [12, "STATE_BUFFERING", 900],
  [13, "STATE_RECORDING", 1400], [14, "STATE_RECORDING", 1500], [15, "STATE_RECORDING", 1600],
].map(([m, state, mw], i) =>
  `"${t(m as number)}",FC-9001,power,PowerStateChanged,pw-${i},,,900,${state},success,${mw},VIDEO_QUALITY_LOW_HD,,,`);

// One 1080p sample: power draw is config-dependent, so it must be excluded from the medians
// and reported rather than blended in.
rows.push(`"${t(16)}",FC-9001,power,PowerStateChanged,pw-off,,,900,STATE_BUFFERING,success,9999,VIDEO_QUALITY_HIGH_HD,,,`);

const batch = beginImport("test", { exportTimeUtc: new Date().toISOString(), exportTimezone: "America/Phoenix" });
uploadImportFiles("test", batch.batchId, { splunkCsv: [header, ...rows].join("\n") });
const preview = previewImport("test", batch.batchId);
eq("P1 all seven power rows accepted", preview.acceptedActivity, 7);
commitImport("test", batch.batchId);

const rt = getRuntimeEstimate();
const byKey = Object.fromEntries(rt.states.map((s) => [s.key, s]));
eq("P2 buffering median", byKey.buffering.medianMw, 800);
eq("P3 recording median", byKey.recording.medianMw, 1500);
eq("P4 livestreaming stays empty", byKey.livestreaming.samples, 0);
eq("P5 estimate is computable", rt.computable, true);

const expected =
  Math.round((FIELDCAM_RECORDING_HOURS + (FIELDCAM_BATTERY_MAH * FIELDCAM_NOMINAL_VOLTS - FIELDCAM_RECORDING_HOURS * 1500) / 800) * 10) / 10;
eq("P6 shift hours match the run book formula", rt.shiftHours, expected);
console.log(`       (= ${FIELDCAM_RECORDING_HOURS}h + (${FIELDCAM_BATTERY_MAH}x${FIELDCAM_NOMINAL_VOLTS} - ${FIELDCAM_RECORDING_HOURS}x1500)/800 = ${expected}h)`);
eq("P7 the 1080p sample was excluded, not blended", [rt.offProfileSamples, rt.offProfileConfigs], [1, ["VIDEO_QUALITY_HIGH_HD"]]);
eq("P8 buffering median unmoved by the 9999mW off-profile row", byKey.buffering.medianMw, 800);
eq("P9 range brackets the point estimate",
   rt.shiftHoursLow !== null && rt.shiftHoursHigh !== null &&
   rt.shiftHoursLow <= rt.shiftHours! && rt.shiftHours! <= rt.shiftHoursHigh, true);

console.log("\n=== edge cases ===");
/*
 * Rows imported before recording_resolution existed carry NULL. Those must count as on-profile,
 * or adding the column would have retroactively discarded every power sample already captured.
 */
{
  const b2 = beginImport("test", { exportTimeUtc: new Date().toISOString(), exportTimezone: "America/Phoenix" });
  uploadImportFiles("test", b2.batchId, {
    splunkCsv: [header, `"${t(20)}",FC-9001,power,PowerStateChanged,pw-nullres,,,900,STATE_BUFFERING,success,800,,,,`].join("\n"),
  });
  previewImport("test", b2.batchId);
  commitImport("test", b2.batchId);
  const withNull = getRuntimeEstimate();
  eq("E1 a NULL-resolution row is counted, not excluded",
     withNull.states.find((x) => x.key === "buffering")!.samples, 4);
  eq("E2 ...and is not reported as off-profile", withNull.offProfileSamples, 1);
}

/*
 * A firmware regression could push recording draw past what the battery holds. The formula must
 * not return a negative or absurd shift length in that case.
 */
// 4600mAh x 3.8V = 17,480 mWh; 4h of recording at 5000 mW needs 20,000 mWh, more than exists.
eq("E3 recording alone exceeding capacity floors at the recording hours",
   shiftHoursFromPower(5000, 800), FIELDCAM_RECORDING_HOURS);
ok_("E4 a normal case sits well above that floor",
    (shiftHoursFromPower(1500, 800) ?? 0) > FIELDCAM_RECORDING_HOURS, String(shiftHoursFromPower(1500, 800)));
eq("E5 zero buffering power is not divided by", shiftHoursFromPower(1500, 0), null);

/*
 * The Runtime section must obey the page's time filter like every other stat, and an empty window
 * must be distinguishable from "no power data has ever arrived" - on a 15-camera fleet a 24h
 * window is often legitimately empty, and that should not read as a broken feature.
 */
console.log("\n=== window scoping ===");
const dash24 = getStatsDashboard(new Date(), "24h");
const dashAll = getStatsDashboard(new Date(), "all");
eq("P10 all-time window sees the samples", dashAll.runtime.computable, true);
eq("P11 24h window still sees them (they were written minutes ago)", dash24.runtime.computable, true);

// Age every sample past the 24h boundary and re-read.
getDb().prepare(
  `UPDATE activity_events SET event_time_utc = ? WHERE event_id LIKE 'pw-%'`,
).run(new Date(Date.now() - 6 * 24 * 3600_000).toISOString());

const aged24 = getStatsDashboard(new Date(), "24h");
const agedAll = getStatsDashboard(new Date(), "all");
eq("P12 24h window now excludes them", aged24.runtime.computable, false);
eq("P13 ...and reports zero in-window samples", aged24.runtime.states.map((x) => x.samples), [0, 0, 0]);
eq("P14 ...but still knows samples exist all-time", aged24.runtime.allTimeSamples > 0, true);
eq("P15 all-time window is unaffected", agedAll.runtime.computable, true);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
