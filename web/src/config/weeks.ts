/** Week-label and week-state helpers for the Overall Statistics trend charts. */

const WEEK_MS = 7 * 24 * 3600_000;
// Signed as a UTC offset (-7) and added, matching the server twin. Declaring it positive and
// subtracting gives the same answer but inverts the convention, so anyone copying the server
// pattern here would shift dates 14 hours the wrong way.
const PHOENIX_OFFSET_MS = -7 * 3600_000;

/** "2026-08-24T07:00:00.000Z" -> "Aug 24" (the Phoenix Monday the week opens on). */
export function weekLabel(weekStartUtc: string): string {
  const d = new Date(weekStartUtc);
  if (Number.isNaN(d.getTime())) return weekStartUtc.slice(0, 10);
  // The stored instant is Phoenix midnight expressed in UTC; shift back to name the local day.
  const local = new Date(d.getTime() + PHOENIX_OFFSET_MS);
  return local.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** True while the week is still running, so its total is partial by definition. */
export function isWeekInProgress(weekStartUtc: string, now = Date.now()): boolean {
  const start = Date.parse(weekStartUtc);
  if (!Number.isFinite(start)) return false;
  return now >= start && now < start + WEEK_MS;
}
