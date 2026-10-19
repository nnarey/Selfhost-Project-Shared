import { ENV } from "./env.js";

/** Format a Date in America/Phoenix as YYYY-MM-DD. */
export function phoenixDateString(d: Date, timeZone = ENV.weekTimezone): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Phoenix weekday: Monday=1 … Sunday=7 (ISO-like). */
function phoenixWeekday(d: Date, timeZone = ENV.weekTimezone): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(d);
  const map: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  return map[wd] ?? 1;
}

/** UTC instant of 00:00 America/Phoenix on a YYYY-MM-DD calendar date. */
export function phoenixMidnightUtcISO(dateYmd: string, timeZone = ENV.weekTimezone): string {
  let guess = new Date(`${dateYmd}T12:00:00.000Z`);
  for (let i = 0; i < 48; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(guess);
    const get = (type: string) => parts.find((p) => p.type === type)?.value || "00";
    const localDate = `${get("year")}-${get("month")}-${get("day")}`;
    const localHour = Number(get("hour"));
    const localMin = Number(get("minute"));
    const localSec = Number(get("second"));
    if (localDate === dateYmd && localHour === 0 && localMin === 0 && localSec === 0) {
      return guess.toISOString();
    }
    const dayDelta =
      (new Date(`${dateYmd}T00:00:00Z`).getTime() - new Date(`${localDate}T00:00:00Z`).getTime()) /
      (24 * 60 * 60 * 1000);
    const msAdjust =
      dayDelta * 24 * 60 * 60 * 1000 - (localHour * 3600 + localMin * 60 + localSec) * 1000;
    guess = new Date(guess.getTime() + msAdjust);
  }
  return guess.toISOString();
}

/**
 * Open competition start: Phoenix midnight on COMPETITION_START (default 2026-08-31).
 *
 * This anchors the 14-day period grid, and it deliberately matches SEASON_START. When the two
 * disagreed the grid ran a week ahead of the competition — period chips read "Aug 24 – Sep 6" and
 * "Sep 7 – Sep 20" for a competition that actually ran Aug 31 – Sep 13. Keep them equal.
 */
export function competitionStartUtcISO(timeZone = ENV.weekTimezone): string {
  const raw = (ENV.competitionStartDate || "2026-08-31").trim();
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "2026-08-31";
  return phoenixMidnightUtcISO(ymd, timeZone);
}

/**
 * Monday 00:00 America/Phoenix for the week containing `instant`, as UTC ISO.
 * Uses iterative search so DST boundaries stay correct without a heavy TZ lib.
 */
export function weekStartUtcISO(instant: Date | string, timeZone = ENV.weekTimezone): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  let cursor = new Date(d.getTime());
  for (let i = 0; i < 8; i++) {
    if (phoenixWeekday(cursor, timeZone) === 1) break;
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }
  return phoenixMidnightUtcISO(phoenixDateString(cursor, timeZone), timeZone);
}

export function weekEndUtcISO(weekStartISO: string): string {
  return new Date(new Date(weekStartISO).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

const PERIOD_MS = 14 * 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Start of the 14-day competition containing `instant` (from COMPETITION_START, not Monday). */
export function biweekStartUtcISO(instant: Date | string, timeZone = ENV.weekTimezone): string {
  const epochMs = new Date(competitionStartUtcISO(timeZone)).getTime();
  const t = (typeof instant === "string" ? new Date(instant) : instant).getTime();
  if (t <= epochMs) return new Date(epochMs).toISOString();
  const n = Math.floor((t - epochMs) / PERIOD_MS);
  return new Date(epochMs + n * PERIOD_MS).toISOString();
}

export function biweekEndUtcISO(biweekStartISO: string): string {
  return new Date(new Date(biweekStartISO).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
}

/** The two 7-day windows that make up a biweekly period (period start + 7 days). */
export function weeksInBiweek(biweekStartISO: string): [string, string] {
  const start = new Date(biweekStartISO).toISOString();
  const second = new Date(new Date(start).getTime() + WEEK_MS).toISOString();
  return [start, second];
}

/** 7-day window start inside the current 14-day competition. */
export function periodWeekStartUtcISO(
  instant: Date | string,
  timeZone = ENV.weekTimezone,
): string {
  const bi = biweekStartUtcISO(instant, timeZone);
  const t = (typeof instant === "string" ? new Date(instant) : instant).getTime();
  const mid = new Date(bi).getTime() + WEEK_MS;
  return t >= mid ? new Date(mid).toISOString() : bi;
}

/** Next Monday 00:00 Phoenix after the week containing `instant` (schedule target). */
export function nextMondayWeekStartUtcISO(
  instant: Date | string = new Date(),
  timeZone = ENV.weekTimezone,
): string {
  const current = weekStartUtcISO(instant, timeZone);
  return weekStartUtcISO(
    new Date(new Date(current).getTime() + 7 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000),
    timeZone,
  );
}

export function isInWeek(eventTimeISO: string, weekStartISO: string): boolean {
  const t = new Date(eventTimeISO).getTime();
  const start = new Date(weekStartISO).getTime();
  const end = start + 7 * 24 * 60 * 60 * 1000;
  return t >= start && t < end;
}

/** GHA pulls 24h; Harbor import allows 36h so a slow deploy does not drop the oldest events. */
export const IMPORT_LOOKBACK_HOURS = 36;

/** True if the event is inside the routine Splunk import lookback (ending at `asOf`). */
export function isInImportLookback(
  eventTimeISO: string,
  asOf: Date | string = new Date(),
  lookbackHours = IMPORT_LOOKBACK_HOURS,
): boolean {
  const t = new Date(eventTimeISO).getTime();
  if (Number.isNaN(t)) return false;
  const end = (typeof asOf === "string" ? new Date(asOf) : asOf).getTime();
  const start = end - lookbackHours * 60 * 60 * 1000;
  return t >= start && t <= end;
}

/** @deprecated Use isInImportLookback. Kept for call sites that still say "two weeks". */
export function isInLastTwoWeeks(
  eventTimeISO: string,
  asOf: Date | string = new Date(),
  _timeZone = ENV.weekTimezone,
): boolean {
  return isInImportLookback(eventTimeISO, asOf);
}

/** Competition 7-day window for an event timestamp. */
export function weekStartForEvent(
  eventTimeISO: string,
  timeZone = ENV.weekTimezone,
): string {
  return periodWeekStartUtcISO(eventTimeISO, timeZone);
}

export function phoenixDayKey(eventTimeISO: string, timeZone = ENV.weekTimezone): string {
  return phoenixDateString(new Date(eventTimeISO), timeZone);
}

/**
 * Whether a stored timestamp can be turned into a day key at all.
 *
 * `phoenixDateString` formats via `Intl.DateTimeFormat.format`, which *throws* RangeError on an
 * invalid Date rather than returning "Invalid Date" the way `toLocaleDateString` does. A single
 * unparseable `event_time_utc` therefore took down a whole leaderboard read with a bare
 * "Invalid time value". Callers that read timestamps out of the database screen them with this
 * first. SQLite compares those columns as text, so a malformed value can and does sort inside a
 * week window.
 */
export function isParsableInstant(value: string | null | undefined): boolean {
  return typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));
}
