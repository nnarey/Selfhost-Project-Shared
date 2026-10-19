/* End-to-end: real-shaped Splunk CSV -> importer -> DB -> POV points. */
import { getDb, nowISO } from "../../db.js";
import { beginImport, uploadImportFiles, previewImport, commitImport } from "../../import/pipeline.js";
import { recomputeWeekScores } from "../../scoring/engine.js";
import { periodWeekStartUtcISO } from "../../week.js";

const db = getDb(); const now = nowISO();
const ws = periodWeekStartUtcISO(new Date());
const t = (hAgo: number) => new Date(Date.now() - hAgo * 3600_000).toISOString().replace("Z", "+0000").replace(".000+0000", ".000+0000");

db.prepare(`INSERT OR REPLACE INTO participants (email,name,signup_status,camera_id,enrolled_at,updated_at,created_at)
            VALUES ('z@northline.example','z','approved','FC-9999',?,?,?)`).run(now, now, now);
db.prepare(`INSERT OR REPLACE INTO cameras (camera_id,label,created_at) VALUES ('FC-9999','FC-9999',?)`).run(now);
db.prepare(`INSERT OR REPLACE INTO assignment_history
  (assignment_id,camera_id,email,assigned_at_utc,unassigned_at_utc,source,status,import_batch_id,created_at)
  VALUES ('az','FC-9999','z@northline.example',?,NULL,'fleet','open',NULL,?)`)
  .run(new Date(Date.now() - 200*3600_000).toISOString(), now);

// Exactly the header shape of "Splunk Search Data (14).csv"
// Native Splunk header names (host / RecordingId / StartReason / DurationSeconds) so the new
// alias + recording_source mapping is exercised for real. event_type and status are added because
// the importer requires them and the raw Splunk export does not carry them -- see notes.
const csv = [
  `"_time",host,Event,RecordingId,event_type,status,StartReason,Purpose,DurationSeconds`,
  `"${t(5)}",FC-9999,RecordingStopped,pov-1,recording,success,POV_ATTACH,PURPOSE_STANDARD,120`,
  `"${t(4)}",FC-9999,RecordingStopped,btn-1,recording,success,BUTTON,PURPOSE_STANDARD,120`,
].join("\n");

const batch = beginImport("test", { exportTimeUtc: new Date().toISOString(), exportTimezone: "UTC" });
uploadImportFiles("test", batch.batchId, { splunkCsv: csv });
const prev = previewImport("test", batch.batchId);
console.log(`  preview: accepted=${prev.acceptedActivity} rejected=${prev.rejectedActivity} quarantined=${prev.quarantinedActivity}`);
commitImport("test", batch.batchId);

const rows = db.prepare(`SELECT event_id, recording_source, duration_seconds FROM activity_events WHERE camera_id='FC-9999' ORDER BY event_id`).all() as any[];
let pass=0, fail=0;
const ok=(n:string,c:boolean,d="")=>{console.log(`  ${c?"PASS":"FAIL"}  ${n}${c?"":`  <- ${d}`}`); c?pass++:fail++;};

ok("K1 both rows imported", rows.length === 2, JSON.stringify(rows));
ok("K2 POV row persisted recording_source",
   rows.some(r => r.recording_source === "POV_ATTACH"), JSON.stringify(rows));
ok("K3 BUTTON row persisted its own source",
   rows.some(r => r.recording_source === "BUTTON"), JSON.stringify(rows));
ok("K4 DurationSeconds mapped (not null)", rows.length === 2 && rows.every(r => Number(r.duration_seconds) === 120), JSON.stringify(rows));
ok("K5 RecordingId became the event_id", rows.length === 2 && rows.every(r => /^(pov|btn)-1\|/.test(r.event_id)), JSON.stringify(rows.map(r=>r.event_id)));

recomputeWeekScores(ws);
const r = db.prepare(`SELECT metrics_json FROM weekly_scores WHERE email='z@northline.example' AND week_start=?`).get(ws) as any;
if (!r) {
  // Without this the next line throws a TypeError and K6-K8 never report at all.
  ok("K6-K8 score row exists", false, `no weekly_scores row for z@northline.example in week ${ws}`);
  console.log(`\nFAILURES: ${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
const by = Object.fromEntries((JSON.parse(r.metrics_json).breakdown ?? []).map((m:any)=>[m.metricKey,m]));
ok("K6 exactly 1 POV recording scored", by.pov_recording_count?.raw === 1, JSON.stringify(by.pov_recording_count));
ok("K7 POV bonus = 50 pts", by.pov_recording_count?.points === 50, JSON.stringify(by.pov_recording_count));
ok("K8 both recordings still counted normally", by.recording_count?.raw === 2, JSON.stringify(by.recording_count));

console.log(`\n${fail===0?"ALL PASS":"FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail===0?0:1);
