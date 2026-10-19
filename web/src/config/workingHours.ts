/**
 * Working-hours helpers for the reminder queue.
 *
 * Monday morning floods the inactivity list: a Friday-afternoon recording is >24h stale by Monday
 * for everyone, even people who did nothing wrong. These helpers measure the same gap in *working*
 * hours so an admin can tell "went quiet" apart from "it was the weekend".
 *
 * Phoenix does not observe DST, so the local offset is a constant -7 and the day arithmetic below
 * needs no timezone library.
 */

const PHOENIX_OFFSET_HOURS = -7;
const MS_HOUR = 3600_000;

/**
 * Dates treated as non-working, in Phoenix calendar terms (YYYY-MM-DD).
 * Edit this list as the program runs — it is read on every render, nothing caches it.
 */
export const OBSERVED_HOLIDAYS: string[] = [
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-11-27", // Day after Thanksgiving
  "2026-12-24", // Christmas Eve
  "2026-12-25", // Christmas Day
  "2026-12-31", // New Year's Eve
  "2027-01-01", // New Year's Day
];

/** Phoenix-local calendar day key (YYYY-MM-DD) for a UTC instant. */
export function phoenixDayKey(utc: Date): string {
  return new Date(utc.getTime() + PHOENIX_OFFSET_HOURS * MS_HOUR).toISOString().slice(0, 10);
}

/** Phoenix-local day of week, 0 = Sunday. */
function phoenixDayOfWeek(utc: Date): number {
  return new Date(utc.getTime() + PHOENIX_OFFSET_HOURS * MS_HOUR).getUTCDay();
}

export function isNonWorkingDay(utc: Date, holidays: string[] = OBSERVED_HOLIDAYS): boolean {
  const dow = phoenixDayOfWeek(utc);
  if (dow === 0 || dow === 6) return true;
  return holidays.includes(phoenixDayKey(utc));
}

/**
 * Hours between two instants that fall on Phoenix working days, walking hour by hour.
 *
 * Hour granularity is deliberate: the threshold it gets compared against is a whole number of
 * hours, so finer resolution would cost more without changing any decision. Gaps are capped at
 * 90 days so a bad timestamp cannot spin the loop.
 */
export function workingHoursBetween(
  startISO: string,
  endMs: number,
  holidays: string[] = OBSERVED_HOLIDAYS,
): number {
  const start = Date.parse(startISO);
  if (!Number.isFinite(start) || endMs <= start) return 0;
  const capped = Math.min(endMs, start + 90 * 24 * MS_HOUR);

  // Still an hourly walk, but the day lookup is hoisted: a naive version allocated a Date and an
  // ISO string on every one of up to 2160 steps, which showed up as render jank once the roster
  // reached ~75. Phoenix has no DST, so the local day index is plain arithmetic and only needs
  // re-evaluating when the hour actually crosses into a new day.
  const MS_DAY = 24 * MS_HOUR;
  const shift = PHOENIX_OFFSET_HOURS * MS_HOUR;
  let working = 0;
  let currentDay = Number.NaN;
  let currentDayIsWorking = false;
  for (let t = start; t < capped; t += MS_HOUR) {
    const dayIndex = Math.floor((t + shift) / MS_DAY);
    if (dayIndex !== currentDay) {
      currentDay = dayIndex;
      currentDayIsWorking = !isNonWorkingDay(new Date(t), holidays);
    }
    if (currentDayIsWorking) working += 1;
  }
  return working;
}

/**
 * True when the gap only clears the threshold because of weekend/holiday time — the person looks
 * inactive on the calendar but not on working days. This is the Monday-morning case.
 */
export function isExplainedByTimeOff(
  anchorISO: string | null,
  idleHours: number,
  nowMs: number,
  thresholdHours = 24,
  holidays: string[] = OBSERVED_HOLIDAYS,
): boolean {
  if (!anchorISO) return false;
  if (idleHours < thresholdHours) return false;
  return workingHoursBetween(anchorISO, nowMs, holidays) < thresholdHours;
}

/** Short relative label for "last refreshed". */
export function relativeTime(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
