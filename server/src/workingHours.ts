/**
 * Working-time arithmetic for the reminder clock.
 *
 * Twin of `web/src/config/workingHours.ts`. There is no shared package and the server tsconfig is
 * rooted at `src`, so the two are kept deliberately identical in behaviour — change both, and the
 * holiday lists together.
 *
 * Phoenix does not observe DST, so the local offset is a constant -7 and the day arithmetic below
 * needs no timezone library.
 */

const PHOENIX_OFFSET_MS = -7 * 3600_000;
const MS_HOUR = 3600_000;
const MS_DAY = 24 * MS_HOUR;

/** Non-working Phoenix calendar dates (YYYY-MM-DD). Keep in step with the web copy. */
export const OBSERVED_HOLIDAYS: string[] = [
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-11-27", // Day after Thanksgiving
  "2026-12-24", // Christmas Eve
  "2026-12-25", // Christmas Day
  "2026-12-31", // New Year's Eve
  "2027-01-01", // New Year's Day
];

export function phoenixDayKey(utcMs: number): string {
  return new Date(utcMs + PHOENIX_OFFSET_MS).toISOString().slice(0, 10);
}

export function isNonWorkingDay(utcMs: number, holidays = OBSERVED_HOLIDAYS): boolean {
  const dow = new Date(utcMs + PHOENIX_OFFSET_MS).getUTCDay();
  if (dow === 0 || dow === 6) return true;
  return holidays.includes(phoenixDayKey(utcMs));
}

/**
 * Hours between two instants that land on Phoenix working days.
 *
 * The day lookup is hoisted out of the hourly walk — it only needs re-evaluating when the hour
 * crosses into a new day. Gaps are capped at 90 days so a bad timestamp cannot spin the loop.
 */
export function workingHoursBetween(startMs: number, endMs: number, holidays = OBSERVED_HOLIDAYS): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  const capped = Math.min(endMs, startMs + 90 * MS_DAY);
  let working = 0;
  let currentDay = Number.NaN;
  let dayIsWorking = false;
  for (let t = startMs; t < capped; t += MS_HOUR) {
    const dayIndex = Math.floor((t + PHOENIX_OFFSET_MS) / MS_DAY);
    if (dayIndex !== currentDay) {
      currentDay = dayIndex;
      dayIsWorking = !isNonWorkingDay(t, holidays);
    }
    if (dayIsWorking) working += 1;
  }
  return working;
}

/**
 * Working time in the unit the rule is written in.
 *
 * Reminders are measured in working days, so say working days. Quoting "76 hours (about 3 days)"
 * for a Friday-to-Monday gap is what made these read as unfair — two of those days were the
 * weekend, and nobody was expected to be recording.
 */
export function humanizeWorkingTime(workingHours: number): string {
  const h = Math.max(0, Math.floor(workingHours));
  if (h < 24) return `${h} working hour${h === 1 ? "" : "s"}`;
  const days = Math.floor(h / 24);
  return `${days} working day${days === 1 ? "" : "s"}`;
}

/** A gap at or beyond this many calendar days is described in real elapsed time, not working time. */
export const LONG_GAP_CALENDAR_DAYS = 7;

/**
 * How to describe an idle gap.
 *
 * Working time is the right unit near the threshold, where the whole point is that a weekend is
 * not neglect. It is the wrong unit for a long absence: "5 working days" undersells a camera that
 * has sat untouched for over a week, and the person reading it knows perfectly well how long it
 * has been. Past a week, switch to real elapsed time.
 *
 * Weeks are floored and hedged rather than rounded, so the message never claims more time than has
 * actually passed: eight days is "over 1 week", never "2 weeks".
 */
export function humanizeIdleGap(calendarHours: number, workingHours: number): string {
  const calendarDays = Math.floor(Math.max(0, calendarHours) / 24);
  if (calendarDays < LONG_GAP_CALENDAR_DAYS) return humanizeWorkingTime(workingHours);
  const weeks = Math.floor(calendarDays / 7);
  const remainder = calendarDays % 7;
  const unit = `${weeks} week${weeks === 1 ? "" : "s"}`;
  return remainder === 0 ? unit : `over ${unit}`;
}
