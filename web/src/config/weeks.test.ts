import { weekLabel, isWeekInProgress } from "./weeks.js";
let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`);
  if (ok) pass += 1; else fail += 1;
};

console.log("\n=== weekLabel (stored as Phoenix midnight in UTC) ===");
eq("W1 names the Phoenix Monday, not the UTC day", weekLabel("2026-08-24T07:00:00.000Z"), "Aug 24");
eq("W2 season kickoff week", weekLabel("2026-08-31T07:00:00.000Z"), "Aug 31");
eq("W3 month boundary", weekLabel("2026-09-07T07:00:00.000Z"), "Sep 7");
eq("W4 unparseable input falls through unchanged", weekLabel("nonsense"), "nonsense");

console.log("\n=== isWeekInProgress ===");
const wk = "2026-08-31T07:00:00.000Z";
eq("W5 one hour in -> running", isWeekInProgress(wk, Date.parse("2026-08-31T08:00:00Z")), true);
eq("W6 the instant it opens -> running", isWeekInProgress(wk, Date.parse(wk)), true);
eq("W7 six days in -> still running", isWeekInProgress(wk, Date.parse("2026-09-06T07:00:00Z")), true);
eq("W8 exactly seven days -> finished", isWeekInProgress(wk, Date.parse("2026-09-07T07:00:00Z")), false);
eq("W9 a past week -> finished", isWeekInProgress("2026-08-24T07:00:00.000Z", Date.parse(wk)), false);
eq("W10 a future week -> not yet running", isWeekInProgress("2026-09-14T07:00:00.000Z", Date.parse(wk)), false);
eq("W11 bad input -> false", isWeekInProgress("nonsense", Date.now()), false);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
if (fail > 0) throw new Error(`${fail} week-helper assertions failed`);
