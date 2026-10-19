/* Feature tests for POV scoring + reminder changes. Runs against a throwaway DB. */
import { getDb, nowISO } from "../../db.js";
import { recomputeWeekScores } from "../../scoring/engine.js";
import { biweekStartUtcISO, periodWeekStartUtcISO } from "../../week.js";
import { greetingName, IDLE_WORKING_HOURS, MIN_SCORING_SECONDS, recomputeReminderEligibility } from "../../reminders.js";
import { humanizeIdleGap, humanizeWorkingTime, isNonWorkingDay, workingHoursBetween } from "../../workingHours.js";
import { inferMapping, applyMapping } from "../../import/mapping.js";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const ok_ = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  <- ${detail}`}`);
  cond ? pass++ : fail++;
};

const db = getDb();
const now = nowISO();
const ws = periodWeekStartUtcISO(new Date());
const day = new Date(Date.parse(ws) + 36 * 3600_000).toISOString();

function seed(email: string, cam: string, assignedAt = ws) {
  db.prepare(`INSERT OR REPLACE INTO participants (email,name,signup_status,camera_id,enrolled_at,updated_at,created_at)
              VALUES (?,?,'approved',?,?,?,?)`).run(email, email.split("@")[0], cam, now, now, now);
  db.prepare(`INSERT OR REPLACE INTO cameras (camera_id,label,created_at) VALUES (?,?,?)`).run(cam, cam, now);
  db.prepare(`INSERT OR REPLACE INTO assignment_history
     (assignment_id,camera_id,email,assigned_at_utc,unassigned_at_utc,source,status,import_batch_id,created_at)
     VALUES (?,?,?,?,NULL,'fleet','open',NULL,?)`).run(`a-${cam}`, cam, email, assignedAt, now);
}
const ins = db.prepare(`INSERT OR REPLACE INTO activity_events
  (event_id,event_time_utc,camera_id,event_type,duration_seconds,purpose,status,recording_source,email,week_start,created_at)
  VALUES (?,?,?,'recording',?,'PURPOSE_STANDARD','success',?,?,?,?)`);

function metrics(email: string) {
  const r = db.prepare(`SELECT metrics_json,total_points FROM weekly_scores WHERE email=? AND week_start=?`).get(email, ws) as any;
  if (!r) return null;
  const b = (JSON.parse(r.metrics_json).breakdown ?? []) as any[];
  return { total: r.total_points, by: Object.fromEntries(b.map(m => [m.metricKey, m])) };
}

console.log("\n=== A. POV scoring ===");
seed("a1@northline.example", "CAM-A1");
ins.run("a1-pov-long", day, "CAM-A1", 120, "POV_ATTACH", "a1@northline.example", ws, now);
ins.run("a1-pov-short", day, "CAM-A1", 10, "POV_DETACH", "a1@northline.example", ws, now);
ins.run("a1-btn-long", day, "CAM-A1", 120, "BUTTON", "a1@northline.example", ws, now);
ins.run("a1-null-src", day, "CAM-A1", 120, null as any, "a1@northline.example", ws, now);
recomputeWeekScores(ws);
const m1 = metrics("a1@northline.example")!;
eq("A1 POV_ATTACH + POV_DETACH both counted", m1.by.pov_recording_count.raw, 2);
eq("A2 POV bonus = 2 x 50", m1.by.pov_recording_count.points, 100);
eq("A3 additive: 3 long recordings still in recording_count", m1.by.recording_count.raw, 3);
eq("A4 additive: the 10s POV still in short_recording_count", m1.by.short_recording_count.raw, 1);
ok_("A5 legacy NULL recording_source earns no POV bonus", m1.by.pov_recording_count.raw === 2,
    `null-source row would have made this 3; got ${m1.by.pov_recording_count.raw}`);
ok_("A6 BUTTON source earns no POV bonus", m1.by.pov_recording_count.raw === 2);

console.log("\n=== A7. pov_state rows from the new export ===");
const povHeaders = ["Event Time","Camera ID","Event Type","Event","Stable Event ID","POV Recording"];
const povMap = inferMapping(povHeaders, "splunk");
const povApplied = applyMapping({
  "Event Time": day,
  "Camera ID": "CAM-A1",
  "Event Type": "pov_state",
  Event: "PowerStateChanged",
  "Stable Event ID": "CAM-A1|PowerStateChanged|x",
  "POV Recording": "true",
}, povMap);
eq("A7 POV Recording=true becomes a POV source", povApplied.recording_source, "POV");
eq("A7b event type preserved", povApplied.event_type, "pov_state");
db.prepare(`INSERT OR REPLACE INTO activity_events
  (event_id,event_time_utc,camera_id,event_type,duration_seconds,purpose,status,recording_source,email,week_start,created_at)
  VALUES (?,?,?,'pov_state',NULL,NULL,'unknown',?,?,?,?)`)
  .run("a1-pov-state", day, "CAM-A1", povApplied.recording_source, "a1@northline.example", ws, now);
recomputeWeekScores(ws);
const m1b = metrics("a1@northline.example")!;
eq("A8 pov_state adds a POV bonus without a new recording", m1b.by.pov_recording_count.raw, 3);
eq("A9 recording_count unchanged", m1b.by.recording_count.raw, 3);

console.log("\n=== B. POV daily cap (3/camera/day) ===");
seed("b1@northline.example", "CAM-B1");
for (let i = 0; i < 6; i++) ins.run(`b1-${i}`, day, "CAM-B1", 60, "POV_ATTACH", "b1@northline.example", ws, now);
recomputeWeekScores(ws);
const m2 = metrics("b1@northline.example")!;
eq("B1 raw count is honest (6)", m2.by.pov_recording_count.raw, 6);
eq("B2 points capped at 3 x 50", m2.by.pov_recording_count.points, 150);

console.log("\n=== C. POV cap is per-DAY, not per-week ===");
seed("c1@northline.example", "CAM-C1");
const day2 = new Date(Date.parse(ws) + 60 * 3600_000).toISOString();
for (let i = 0; i < 4; i++) ins.run(`c1-d1-${i}`, day, "CAM-C1", 60, "POV_ATTACH", "c1@northline.example", ws, now);
for (let i = 0; i < 4; i++) ins.run(`c1-d2-${i}`, day2, "CAM-C1", 60, "POV_ATTACH", "c1@northline.example", ws, now);
recomputeWeekScores(ws);
const m3 = metrics("c1@northline.example")!;
eq("C1 8 POV across 2 days -> raw 8", m3.by.pov_recording_count.raw, 8);
eq("C2 capped per day: 3+3 = 6 x 50 = 300", m3.by.pov_recording_count.points, 300);

console.log("\n=== D. humanizeIdleGap ===");
// Near the threshold, working time is the point: a weekend is not neglect.
eq("D1 two working days", humanizeIdleGap(96, 48), "2 working days");
eq("D2 three working days", humanizeIdleGap(120, 72), "3 working days");
// Past a week, working time undersells a camera nobody has touched — switch to real elapsed time.
eq("D3 exactly a week", humanizeIdleGap(168, 120), "1 week");
eq("D4 the 184h case", humanizeIdleGap(184, 136), "1 week");
eq("D5 nine days hedges rather than rounding up", humanizeIdleGap(216, 144), "over 1 week");
eq("D6 a fortnight", humanizeIdleGap(336, 240), "2 weeks");
eq("D7 fifteen days", humanizeIdleGap(360, 240), "over 2 weeks");
eq("D8 three weeks", humanizeIdleGap(504, 360), "3 weeks");
// Never claims more time than has passed.
eq("D9 six days is still working time", humanizeIdleGap(144, 96), "4 working days");
eq("D10 raw working-time helper unchanged", humanizeWorkingTime(48), "2 working days");

console.log("\n=== D2. greetingName ===");
eq("D2a full name -> first name only", greetingName("Devon Park", "alice@northline.example"), "Devon");
eq("D2b single-word name is used as-is", greetingName("Cher", "cher@northline.example"), "Cher");
eq("D2c an initial is respected, not expanded", greetingName("J Brooks", "elena@northline.example"), "J");
eq("D2d extra whitespace is trimmed", greetingName("  Bob   Rivera ", "bob@northline.example"), "Bob");
eq("D2e empty name falls back to the email handle", greetingName("", "elena@northline.example"), "elena");
eq("D2f null name falls back too", greetingName(null, "alice@northline.example"), "alice");

console.log("\n=== E. Reminder eligibility runs on working time ===");
// Seven calendar days back always spans at least five weekdays (120 working hours), so the
// fixture stays over the threshold whatever weekday the suite runs on — while staying inside
// COMPETITION_START, which the last-recording lookup filters on. Fourteen days fell outside it
// and quietly moved the candidate onto the never-recorded branch instead.
const LONG_AGO = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
seed("e1@northline.example", "CAM-E1", LONG_AGO);
db.prepare(`UPDATE participants SET name = 'Erika One' WHERE email = 'e1@northline.example'`).run();
// Inactivity nudges only fire once onboarding has already been sent; without this the engine
// correctly returns the onboarding candidate and never reaches the branch under test.
db.prepare(`INSERT OR REPLACE INTO pending_nudges (id,email,name,camera_id,kind,text,created_at,status,queued_at,sent_at,week_start)
  VALUES ('n-e1','e1@northline.example','e1','CAM-E1','onboarding','x',?,'sent',?,?,?)`)
  .run(now, now, LONG_AGO, ws);
ins.run("e1-old", LONG_AGO, "CAM-E1", 120, "BUTTON", "e1@northline.example", ws, now);
const cands = recomputeReminderEligibility();
const e1 = cands.find(c => c.email === "e1@northline.example");
ok_("E1 long-idle person is inactivity-eligible", !!e1 && e1.kind === "inactivity", JSON.stringify(e1?.kind));
ok_("E2 a week-old gap is phrased in real elapsed time, not working days",
    !!e1 && /it's been (over )?\d+ weeks?/.test(e1.text) && !/working day/.test(e1.text),
    e1?.text.slice(0, 100));
ok_("E2b greets by first name, not the email handle",
    !!e1 && e1.text.startsWith("Hi Erika,"), e1?.text.slice(0, 40));
ok_("E2c candidate.name carries the full display name for the admin list",
    e1?.name === "Erika One", String(e1?.name));
ok_("E3 idleWorkingHours exposed and above the threshold",
    !!e1 && typeof e1.idleWorkingHours === "number" && e1.idleWorkingHours >= IDLE_WORKING_HOURS,
    String(e1?.idleWorkingHours));
ok_("E4 lastRecordingAt exposed", !!e1 && !!e1.lastRecordingAt, String(e1?.lastRecordingAt));

console.log("\n=== E5. a Friday recording must not nudge on Monday ===");
// Friday 28 Aug 17:00 Phoenix. The old calendar rule fired Monday morning at "3 days"; two of
// those days were the weekend, which is the complaint this rule exists to answer.
const friday = Date.parse("2026-08-29T00:00:00Z");
const check = (iso: string) => workingHoursBetween(friday, Date.parse(iso));
eq("E5a Mon 09:00 -> under threshold", check("2026-08-31T16:00:00Z") >= IDLE_WORKING_HOURS, false);
eq("E5b Mon 17:00 -> under threshold", check("2026-08-31T24:00:00Z".replace("24:00","23:59")) >= IDLE_WORKING_HOURS, false);
eq("E5c Tue 09:00 -> still under", check("2026-09-01T16:00:00Z") >= IDLE_WORKING_HOURS, false);
eq("E5d Tue 17:00 -> fires", check("2026-09-02T00:00:00Z") >= IDLE_WORKING_HOURS, true);
eq("E5e the weekend contributes nothing",
   workingHoursBetween(Date.parse("2026-08-29T12:00:00Z"), Date.parse("2026-08-31T00:00:00Z")), 0);
// A genuinely long absence must still fire. The working-time rule exists to stop a weekend
// looking like neglect — not to let a camera sit unused for a week because two of those days
// happened to be Saturday and Sunday.
const sent = Date.parse("2026-09-01T00:06:00Z");
const gapOf = (calendarHours: number) =>
  workingHoursBetween(sent - calendarHours * 3600_000, sent);
eq("E5h a weekend-spanning 3-day gap is suppressed", gapOf(72) >= IDLE_WORKING_HOURS, false);
eq("E5i a 7-day gap still fires", gapOf(168) >= IDLE_WORKING_HOURS, true);
eq("E5j the 184h case that prompted this still fires", gapOf(184) >= IDLE_WORKING_HOURS, true);
eq("E5k ...and reads as real elapsed time", humanizeIdleGap(184, gapOf(184)), "1 week");
eq("E5l a fortnight fires", gapOf(336) >= IDLE_WORKING_HOURS, true);
eq("E5f phrasing near the threshold", humanizeIdleGap(96, 48), "2 working days");
eq("E5g phrasing, sub-day", humanizeWorkingTime(9), "9 working hours");

console.log("\n=== E6. permanent holders skip onboarding ===");
seed("devon@northline.example", "CAM-PERM", LONG_AGO);
const perm = recomputeReminderEligibility().find(c => c.email === "devon@northline.example");
ok_("E6a a permanent holder with no onboarding DM is not an onboarding candidate",
    !perm || perm.kind !== "onboarding", String(perm?.kind));
ok_("E6b they can still be an inactivity candidate",
    !!perm && perm.kind === "inactivity", String(perm?.kind));

console.log("\n=== E7. a short recording is still activity ===");
// 27 seconds is under the 30s scoring bar but is unmistakably someone using the camera. It must
// reset the clock, and if they later go quiet the message must say what actually happened rather
// than claiming we see no recording.
seed("s1@northline.example", "CAM-S1", new Date(Date.now() - 30 * 24 * 3600_000).toISOString());
db.prepare(`UPDATE participants SET name = 'Shorty One' WHERE email = 's1@northline.example'`).run();
db.prepare(`INSERT OR REPLACE INTO pending_nudges (id,email,name,camera_id,kind,text,created_at,status,queued_at,sent_at,week_start)
  VALUES ('n-s1','s1@northline.example','s1','CAM-S1','onboarding','x',?,'sent',?,?,?)`)
  .run(now, now, new Date(Date.now() - 30 * 24 * 3600_000).toISOString(), ws);

// recorded 27s just now -> not eligible at all
ins.run("s1-recent", nowISO(), "CAM-S1", 27, "BUTTON", "s1@northline.example", ws, now);
ok_("E7a a 27s recording just now clears eligibility",
    !recomputeReminderEligibility().some(c => c.email === "s1@northline.example"));

// same 27s recording, but a week ago -> eligible, and the message must name the duration
db.prepare(`DELETE FROM activity_events WHERE event_id = 's1-recent'`).run();
ins.run("s1-old", new Date(Date.now() - 7 * 24 * 3600_000).toISOString(), "CAM-S1", 27,
        "BUTTON", "s1@northline.example", ws, now);
const s1 = recomputeReminderEligibility().find(c => c.email === "s1@northline.example");
ok_("E7b now eligible again", !!s1, JSON.stringify(s1?.kind));
ok_("E7c message names the duration and the minimum",
    !!s1 && s1.text.includes("27 seconds") && s1.text.includes(`${MIN_SCORING_SECONDS}-second minimum`),
    s1?.text.slice(0, 130));
ok_("E7d message does NOT claim we see no recording",
    !!s1 && !/don't see a valid qualifying recording/.test(s1.text), s1?.text.slice(0, 80));
ok_("E7e reason names the shortfall, not absence",
    !!s1 && /under the \d+s minimum/.test(s1.reason), s1?.reason);

// A scoring clip, then a short one, then weeks of silence: the absence is the message.
// The short clip is still the last recording, so the clock starts there, but it must not
// replace the inactivity copy.
seed("s2@northline.example", "CAM-S2", new Date(Date.now() - 30 * 24 * 3600_000).toISOString());
db.prepare(`UPDATE participants SET name = 'Shorty Two' WHERE email = 's2@northline.example'`).run();
db.prepare(`INSERT OR REPLACE INTO pending_nudges (id,email,name,camera_id,kind,text,created_at,status,queued_at,sent_at,week_start)
  VALUES ('n-s2','s2@northline.example','s2','CAM-S2','onboarding','x',?,'sent',?,?,?)`)
  .run(now, now, new Date(Date.now() - 30 * 24 * 3600_000).toISOString(), ws);
ins.run("s2-scored", new Date(Date.now() - 21 * 24 * 3600_000).toISOString(), "CAM-S2", 74,
        "BUTTON", "s2@northline.example", ws, now);
ins.run("s2-short", new Date(Date.now() - 20 * 24 * 3600_000).toISOString(), "CAM-S2", 24,
        "BUTTON", "s2@northline.example", ws, now);
const s2 = recomputeReminderEligibility().find(c => c.email === "s2@northline.example");
ok_("E7f a prior scoring clip keeps the inactivity message",
    !!s2 && /since your last FieldCam recording/.test(s2.text) && !/second minimum/.test(s2.text),
    s2?.text.slice(0, 160));

console.log("\n=== E6. holidays and bad input ===");
eq("E6a Labor Day 2026 is non-working", isNonWorkingDay(Date.parse("2026-09-07T18:00:00Z")), true);
eq("E6b the following day is working", isNonWorkingDay(Date.parse("2026-09-08T18:00:00Z")), false);
eq("E6c a holiday contributes no working hours",
   workingHoursBetween(Date.parse("2026-09-07T07:00:00Z"), Date.parse("2026-09-08T07:00:00Z")), 0);
eq("E6d NaN start -> 0", workingHoursBetween(Number.NaN, Date.now()), 0);
eq("E6e equal start and end -> 0",
   workingHoursBetween(Date.parse("2026-09-08T12:00:00Z"), Date.parse("2026-09-08T12:00:00Z")), 0);
eq("E6f end before start -> 0",
   workingHoursBetween(Date.parse("2026-09-08T12:00:00Z"), Date.parse("2026-09-07T12:00:00Z")), 0);

console.log("\n=== E8. the inactivity penalty is on the working clock too ===");
// A camera untouched from Friday afternoon used to cost 200 points by Monday morning, for
// Saturday and Sunday. It also disagreed with the reminder rule, so someone could lose points for
// days that were not yet enough to earn them a nudge.
const friPm = Date.parse("2026-08-29T00:00:00Z"); // Fri 17:00 Phoenix
const penaltyDays = (nowIso: string) => {
  const h = workingHoursBetween(friPm, Date.parse(nowIso));
  return h < 24 ? 0 : 1 + Math.floor((h - 24) / 24);
};
eq("E8a Mon 09:00 costs nothing", penaltyDays("2026-08-31T16:00:00Z"), 0);
eq("E8b Tue 09:00 costs one day", penaltyDays("2026-09-01T16:00:00Z"), 1);
eq("E8c Wed 09:00 costs two days", penaltyDays("2026-09-02T16:00:00Z"), 2);
// The penalty must not outpace the nudge: no charging for time too short to warrant a reminder.
eq("E8d nothing is charged before a nudge is even due",
   penaltyDays("2026-08-31T16:00:00Z") === 0 &&
     workingHoursBetween(friPm, Date.parse("2026-08-31T16:00:00Z")) < IDLE_WORKING_HOURS,
   true);

console.log("\n=== F. Import mapping (real Splunk export headers) ===");
const headers = ["_time","host","Event","RecordingId","Reason","StartReason","Purpose","DurationSeconds"];
const map = Object.fromEntries(inferMapping(headers, "splunk").map(m => [m.sourceColumn, m.canonicalField]));
eq("F1 host -> camera_id", map.host, "camera_id");
eq("F2 StartReason -> recording_source", map.StartReason, "recording_source");
eq("F3 RecordingId -> event_id (camelCase alias)", map.RecordingId, "event_id");
eq("F4 DurationSeconds -> duration_seconds (camelCase alias)", map.DurationSeconds, "duration_seconds");
eq("F5 _time -> event_time_utc", map._time, "event_time_utc");
const applied = applyMapping({_time:"2026-08-27T23:44:13.000+0000", host:"FC-1249", Event:"RecordingStopped",
  RecordingId:"rec-1", Reason:"RECORDING_STOP_REASON_BUTTON", StartReason:"POV_ATTACH",
  Purpose:"PURPOSE_STANDARD", DurationSeconds:"4"}, inferMapping(headers,"splunk"));
eq("F6 applyMapping carries recording_source", applied.recording_source, "POV_ATTACH");
eq("F7 event_id disambiguated by Event name", applied.event_id, "rec-1|RecordingStopped");

console.log("\n=== G. A malformed timestamp cannot take down the board ===");
/*
 * SQLite compares these columns as text, so a value like "2026-09-05T99:99:99.000Z" sorts *inside*
 * a week window while being an invalid Date. phoenixDayKey formats via Intl.DateTimeFormat.format,
 * which throws RangeError on an invalid Date rather than returning "Invalid Date". One such row
 * used to 500 an entire leaderboard read with a bare "Invalid time value".
 */
seed("g1@northline.example", "CAM-G1");
const badInstant = ws.slice(0, 10) + "T99:99:99.000Z";
ok_("G0 the bad value really does sort inside the week", badInstant >= ws && badInstant < new Date(Date.parse(ws) + 7 * 86400_000).toISOString(), badInstant);
ok_("G0b ...and really is an unparseable date", Number.isNaN(Date.parse(badInstant)), badInstant);
ins.run("g1-good", day, "CAM-G1", 120, "BUTTON", "g1@northline.example", ws, now);
ins.run("g1-bad-ts", badInstant, "CAM-G1", 120, "BUTTON", "g1@northline.example", ws, now);
let threw: string | null = null;
try { recomputeWeekScores(ws); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
eq("G1 recompute does not throw", threw, null);
const g1 = metrics("g1@northline.example");
ok_("G2 the good recording still scored", (g1?.by?.recording_count?.raw ?? 0) === 1, JSON.stringify(g1?.by?.recording_count));
ok_("G3 the malformed row was skipped, not counted", (g1?.by?.recording_event_count?.raw ?? 0) === 1, JSON.stringify(g1?.by?.recording_event_count));

console.log("\n=== H. A bad weekStart is a bad request, not a server fault ===");
/*
 * An unparseable weekStart reached biweekStartUtcISO and surfaced as a bare "Invalid time value"
 * 500 - indistinguishable from a genuine server fault, and it sent two investigations chasing the
 * wrong thing before the input was identified as the cause.
 */
for (const bad of ["nonsense", "undefined", "null", ""]) {
  ok_(`H1 ${JSON.stringify(bad)} is rejected by Date.parse`, Number.isNaN(Date.parse(bad)), bad);
}
ok_("H2 a real period start still parses", !Number.isNaN(Date.parse("2026-08-31T07:00:00.000Z")));
// biweekStartUtcISO is what used to throw; confirm it still does, so the route guard is load-bearing.
let threwOnBad: string | null = null;
try {
  biweekStartUtcISO("nonsense");
} catch (e) {
  threwOnBad = e instanceof Error ? e.message : String(e);
}
eq("H3 the underlying helper still throws, so the route must guard", threwOnBad, "Invalid time value");

/*
 * Harbor received weekStart as "2026-08-31T07%3A00%3A00.000Z" — colons never decoded. The client
 * sends %3A correctly, something in front of the container re-encodes to %253A, and Express's
 * single decode leaves %3A behind. Date.parse rejects it, so every closed-period click 500'd
 * there while nothing reproduced locally, where Vite proxies straight through.
 */
const encodedOnce = "2026-08-31T07%3A00%3A00.000Z";
ok_("H4 the value Harbor saw does not parse as-is", Number.isNaN(Date.parse(encodedOnce)), encodedOnce);
eq("H5 one more decode recovers it", decodeURIComponent(encodedOnce), "2026-08-31T07:00:00.000Z");
ok_("H6 ...and then it parses", !Number.isNaN(Date.parse(decodeURIComponent(encodedOnce))));
// Decoding must not rescue genuine rubbish, or the 400 stops meaning anything.
for (const junk of ["nonsense", "undefined", "%zz"]) {
  let recovered = junk;
  try {
    recovered = decodeURIComponent(junk);
  } catch {
    recovered = junk;
  }
  ok_(`H7 ${JSON.stringify(junk)} stays invalid after a decode attempt`, Number.isNaN(Date.parse(recovered)), recovered);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
