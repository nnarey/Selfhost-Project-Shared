import { isNonWorkingDay, workingHoursBetween, isExplainedByTimeOff, relativeTime, phoenixDayKey }
  from "./workingHours.js";
let pass=0, fail=0;
const eq = (n: string, g: unknown, w: unknown) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`);
  if (ok) pass += 1;
  else fail += 1;
};

console.log("\n=== G. Phoenix day / weekend detection (UTC-7, no DST) ===");
// 2026-08-31 is a Monday. Sat = 08-29, Sun = 08-30.
eq("G1 Sat 12:00Z is non-working",      isNonWorkingDay(new Date("2026-08-29T12:00:00Z")), true);
eq("G2 Sun 12:00Z is non-working",      isNonWorkingDay(new Date("2026-08-30T12:00:00Z")), true);
eq("G3 Mon 18:00Z is working",          isNonWorkingDay(new Date("2026-08-31T18:00:00Z")), false);
eq("G4 Fri 18:00Z is working",          isNonWorkingDay(new Date("2026-08-28T18:00:00Z")), false);
// UTC-7 boundary: Sat 05:00Z is still Friday 22:00 in Phoenix -> working
eq("G5 Sat 05:00Z is Fri in Phoenix",   isNonWorkingDay(new Date("2026-08-29T05:00:00Z")), false);
eq("G6 phoenixDayKey shifts correctly", phoenixDayKey(new Date("2026-08-29T05:00:00Z")), "2026-08-28");
eq("G7 Labor Day 2026-09-07 is off",    isNonWorkingDay(new Date("2026-09-07T18:00:00Z")), true);

console.log("\n=== H. workingHoursBetween ===");
// Fri 2026-08-28 22:00Z (= Fri 15:00 Phoenix) -> Mon 2026-08-31 22:00Z. 72 calendar hours.
const friPM="2026-08-28T22:00:00Z", monPM=Date.parse("2026-08-31T22:00:00Z");
const wh=workingHoursBetween(friPM, monPM);
eq("H1 Fri->Mon 72 calendar hours", Math.round((monPM-Date.parse(friPM))/3600_000), 72);
eq("H2 ...is only 24 working hours", wh, 24);
eq("H3 same instant -> 0", workingHoursBetween(friPM, Date.parse(friPM)), 0);
eq("H4 end before start -> 0", workingHoursBetween(monPM as unknown as string ? friPM : friPM, Date.parse("2026-08-27T00:00:00Z")), 0);
eq("H5 unparseable start -> 0", workingHoursBetween("not-a-date", monPM), 0);
// A full week is 7 calendar days but only 5 working days
eq("H6 Mon->Mon = 120 working hours",
   workingHoursBetween("2026-08-24T12:00:00Z", Date.parse("2026-08-31T12:00:00Z")), 120);

console.log("\n=== I. isExplainedByTimeOff (the Monday-morning case) ===");
const mondayNow=Date.parse("2026-08-31T22:00:00Z");
eq("I1 boundary: exactly 24 working hours is NOT hidden (a full working day has passed)",
   isExplainedByTimeOff("2026-08-28T22:00:00Z", 72, mondayNow), false);
eq("I2 Fri 23:35 -> Mon (65h) IS explained",
   isExplainedByTimeOff("2026-08-28T23:35:00Z", 65, mondayNow), true);
eq("I3 a full week idle is NOT explained",
   isExplainedByTimeOff("2026-08-24T22:00:00Z", 168, mondayNow), false);
eq("I4 under threshold -> never flagged",
   isExplainedByTimeOff("2026-08-31T10:00:00Z", 12, mondayNow), false);
eq("I5 null anchor -> false", isExplainedByTimeOff(null, 99, mondayNow), false);
eq("I6 holiday extends the effect: Fri->Tue over Labor Day",
   isExplainedByTimeOff("2026-09-04T23:00:00Z", 88, Date.parse("2026-09-08T15:00:00Z")), true);

console.log("\n=== J. relativeTime ===");
const t0=1_000_000_000_000;
eq("J1 <5s", relativeTime(t0, t0+2_000), "just now");
eq("J2 seconds", relativeTime(t0, t0+30_000), "30s ago");
eq("J3 minutes", relativeTime(t0, t0+5*60_000), "5m ago");
eq("J4 hours", relativeTime(t0, t0+3*3600_000), "3h ago");
eq("J5 days", relativeTime(t0, t0+50*3600_000), "2d ago");
eq("J6 future clamps", relativeTime(t0+9999, t0), "just now");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
if (fail > 0) throw new Error(`${fail} working-hours assertions failed`);
