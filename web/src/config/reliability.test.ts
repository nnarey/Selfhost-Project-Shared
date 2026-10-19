import { statusFor } from "./reliability.js";
import { isNonWorkingDay, workingHoursBetween, phoenixDayKey } from "./workingHours.js";
let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`);
  if (ok) pass += 1; else fail += 1;
};

console.log("\n=== statusFor: all five branches ===");
eq("S1 no data at all", statusFor(null, 99, null), "unknown");
eq("S2 at or above target", statusFor(99.5, 99, 99.9), "good");
eq("S3 exactly on target", statusFor(99, 99, 99.4), "good");
// The branch that matters: 1 failure in 361 is 99.7% against a 99.99% target, but the interval
// reaches 100 — the sample cannot separate the two, so it must not be reported as a miss.
eq("S4 target inside the interval -> inconclusive", statusFor(99.7, 99.99, 100), "inconclusive");
eq("S5 just below, interval excludes target", statusFor(98.5, 99, 98.9), "warning");
eq("S6 far below", statusFor(90.2, 99, 92.9), "critical");
eq("S7 the warning/critical boundary is one point", statusFor(98.0, 99, 98.4), "warning");
eq("S8 ...and just past it", statusFor(97.9, 99, 98.4), "critical");
eq("S9 a missing interval cannot excuse a miss", statusFor(90, 99, null), "critical");

console.log("\n=== working-hours guards and holidays ===");
eq("W1 Labor Day 2026 is non-working", isNonWorkingDay(new Date("2026-09-07T18:00:00Z")), true);
eq("W2 the day after it is working", isNonWorkingDay(new Date("2026-09-08T18:00:00Z")), false);
eq("W3 a holiday contributes no working hours",
   workingHoursBetween("2026-09-07T07:00:00Z", Date.parse("2026-09-08T07:00:00Z")), 0);
eq("W4 unparseable start -> 0", workingHoursBetween("not-a-date", Date.now()), 0);
eq("W5 equal start and end -> 0",
   workingHoursBetween("2026-09-08T12:00:00Z", Date.parse("2026-09-08T12:00:00Z")), 0);
eq("W6 end before start -> 0",
   workingHoursBetween("2026-09-08T12:00:00Z", Date.parse("2026-09-07T12:00:00Z")), 0);
eq("W7 NaN end -> 0", workingHoursBetween("2026-09-08T12:00:00Z", Number.NaN), 0);
eq("W8 day key still shifts to Phoenix", phoenixDayKey(new Date("2026-09-08T05:00:00Z")), "2026-09-07");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
if (fail > 0) throw new Error(`${fail} assertions failed`);
