import { INACTIVITY_THRESHOLD_HOURS, SCORING_WEIGHTS } from "../config/scoring.config";
import type { ActivityRecord, Participant, ScoreBreakdown } from "./types";

/** Whole days between two ISO timestamps (a - b), can be fractional -> floored. */
function hoursBetween(aISO: string, bISO: string): number {
  return (new Date(aISO).getTime() - new Date(bISO).getTime()) / (1000 * 60 * 60);
}

/** Most recent date (YYYY-MM-DD) on which a participant logged at least one recording, if any. */
export function getLastRecordingDate(records: ActivityRecord[]): string | undefined {
  let latest: string | undefined;
  for (const r of records) {
    if (r.recordings > 0 && (!latest || r.date > latest)) latest = r.date;
  }
  return latest;
}

/**
 * Hours elapsed since the participant's last logged recording. Day-level
 * activity is treated as lasting through the end of that UTC day so a
 * recording yesterday afternoon is not idle at 8am the next morning.
 * Falls back to `enrolledAt` if the participant has never logged a recording.
 */
export function hoursSinceLastRecording(
  participant: Participant,
  records: ActivityRecord[],
  nowISO: string,
): number {
  const lastRecordingDate = getLastRecordingDate(records);
  const anchor = lastRecordingDate
    ? `${lastRecordingDate}T23:59:59.000Z`
    : participant.enrolledAt;
  return hoursBetween(nowISO, anchor);
}

/**
 * A day "qualifies" for the activity streak if the participant did anything
 * that day: recorded, uploaded, livestreamed, or filed a report.
 */
function isQualifyingDay(r: ActivityRecord): boolean {
  return r.recordings > 0 || r.uploads > 0 || r.livestreams > 0 || r.reports > 0;
}

/**
 * Current consecutive-day streak ending at the most recent activity date in
 * the provided records (records are assumed to belong to a single person).
 */
export function computeCurrentStreakDays(records: ActivityRecord[]): number {
  if (records.length === 0) return 0;
  const byDate = new Map(records.map((r) => [r.date, r]));
  const sortedDates = [...byDate.keys()].sort();
  const lastDate = sortedDates[sortedDates.length - 1];

  let streak = 0;
  const cursor = new Date(lastDate + "T00:00:00");
  // Walk backward day by day while each day qualifies.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const key = cursor.toISOString().slice(0, 10);
    const record = byDate.get(key);
    if (record && isQualifyingDay(record)) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

/** How many whole days a participant has been continuously Inactive, as of `nowISO`. */
export function computeInactiveDays(
  participant: Participant,
  records: ActivityRecord[],
  nowISO: string,
): number {
  if (participant.status !== "Inactive") return 0;
  const hoursInactive = Math.max(
    0,
    hoursSinceLastRecording(participant, records, nowISO) - INACTIVITY_THRESHOLD_HOURS,
  );
  return Math.floor(hoursInactive / 24) + (hoursInactive > 0 ? 1 : 0);
}

/**
 * Auto-computes whether a participant should be Inactive based on the 24h
 * no-recordings rule (no logged recording in the last `INACTIVITY_THRESHOLD_HOURS`
 * hours). Admin manual overrides (`manualStatusOverride`) are respected and
 * skip this computation.
 */
export function computeAutoStatus(
  participant: Participant,
  records: ActivityRecord[],
  nowISO: string,
): "Active" | "Inactive" {
  if (participant.manualStatusOverride) return participant.status;
  return hoursSinceLastRecording(participant, records, nowISO) > INACTIVITY_THRESHOLD_HOURS
    ? "Inactive"
    : "Active";
}

/** Sum of raw event-based points for a set of activity records (no streak/inactivity). */
export function sumBaseActivityPoints(records: ActivityRecord[]): {
  recordingPoints: number;
  hourPoints: number;
  uploadPoints: number;
  livestreamPoints: number;
  reportPoints: number;
  totals: ScoreBreakdown["totals"];
} {
  const totals = { recordings: 0, hours: 0, uploads: 0, livestreams: 0, reports: 0 };
  for (const r of records) {
    totals.recordings += r.recordings;
    totals.hours += r.hours;
    totals.uploads += r.uploads;
    totals.livestreams += r.livestreams;
    totals.reports += r.reports;
  }
  return {
    recordingPoints: totals.recordings * SCORING_WEIGHTS.recordingSession,
    hourPoints: totals.hours * SCORING_WEIGHTS.recordingHour,
    uploadPoints: totals.uploads * SCORING_WEIGHTS.upload,
    livestreamPoints:
      records.reduce(
        (n, r) => n + Math.min(r.livestreams, SCORING_WEIGHTS.livestreamCapPerDay),
        0,
      ) * SCORING_WEIGHTS.livestream,
    reportPoints: totals.reports * SCORING_WEIGHTS.report,
    totals,
  };
}

/**
 * Full score breakdown for a participant across all of their activity
 * records (season-to-date). Includes streak bonus and inactivity penalty.
 */
export function computePersonScore(
  participant: Participant,
  records: ActivityRecord[],
  nowISO: string,
): ScoreBreakdown {
  const base = sumBaseActivityPoints(records);
  const streakDays = Math.min(
    computeCurrentStreakDays(records),
    SCORING_WEIGHTS.streakCapDays,
  );
  const streakBonus = streakDays * SCORING_WEIGHTS.streakBonusPerDay;

  const inactiveDays = computeInactiveDays(participant, records, nowISO);
  const inactivePenalty = inactiveDays * SCORING_WEIGHTS.inactivePenaltyPerDay;

  const total =
    base.recordingPoints +
    base.hourPoints +
    base.uploadPoints +
    base.livestreamPoints +
    base.reportPoints +
    streakBonus +
    inactivePenalty;

  return {
    ...base,
    streakBonus,
    streakDays,
    inactivePenalty,
    inactiveDays,
    total,
  };
}

/** Sum of base activity points within an inclusive date window [startDate, endDate]. */
export function sumActivityInWindow(
  records: ActivityRecord[],
  startDate: string,
  endDate: string,
): ReturnType<typeof sumBaseActivityPoints> & { total: number } {
  const windowed = records.filter((r) => r.date >= startDate && r.date <= endDate);
  const base = sumBaseActivityPoints(windowed);
  const total =
    base.recordingPoints +
    base.hourPoints +
    base.uploadPoints +
    base.livestreamPoints +
    base.reportPoints;
  return { ...base, total };
}
