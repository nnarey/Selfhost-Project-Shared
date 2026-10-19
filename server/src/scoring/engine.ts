import { createHash } from "node:crypto";
import { workingHoursBetween } from "../workingHours.js";
import { audit, getDb, nowISO } from "../db.js";
import { ENV } from "../env.js";
import { emailHandle } from "../participants.js";
import {
  biweekEndUtcISO,
  biweekStartUtcISO,
  isParsableInstant,
  phoenixDayKey,
  competitionStartUtcISO,
  periodWeekStartUtcISO,
  weekEndUtcISO,
  weeksInBiweek,
} from "../week.js";
import type { MetricKey, ScoreMetricBreakdown } from "../types.js";
import { resolveProfileForWeek, type ResolvedProfile } from "./profiles.js";
import {
  ensurePermanentHolders,
  isPermanentHolderEmail,
  type LeaderboardTrack,
} from "../config/permanentHolders.js";
import { loadTrackOverrideMap, resolveRowTrack } from "../config/trackOverrides.js";
import { competitionWeekFloorUtc } from "../config/season.js";

/**
 * Rows skipped because their stored timestamp could not be parsed.
 *
 * Counted rather than thrown on. Bad data should cost you that row, not the whole leaderboard —
 * but it should not vanish silently either, so a recompute logs the tally.
 */
let unparsableInstants = 0;

/* Sample FieldCam runtime budget used by the shift estimate:
 *   4600 mAh, 3.8 V nominal
 *   4 h recording inside a 16 h shift (12 h idle + 4 h recording)
 */
export const FIELDCAM_BATTERY_MAH = 4600;
export const FIELDCAM_NOMINAL_VOLTS = 3.8;
export const FIELDCAM_RECORDING_HOURS = 4;
export const FIELDCAM_TARGET_SHIFT_HOURS = 16;
/**
 * The sample shift profile is 12 hours idle and 4 hours recording at one resolution.
 * Power draw depends on resolution, so a median across mixed configs measures nothing.
 */
export const PRD_SHIFT_RESOLUTION = "VIDEO_QUALITY_LOW_HD";

/** Duration at which session points first increase (also the short-clip daily cap threshold). */
export const RECORDING_DURATION_DOUBLE_BASE_SECONDS = 5 * 60;

/** Longest duration that still increases the legacy recording multiplier. */
export const RECORDING_DURATION_MULTIPLIER_CAP_SECONDS = 80 * 60;

/**
 * Recordings at or after this instant use the medium-length bell. Earlier recordings keep the
 * legacy ladder so weeks that are recomputed later do not change points already earned.
 */
export const RECORDING_MULTIPLIER_BELL_FROM_UTC = "2026-09-28T08:15:00.000Z";

/** Max sub-5-minute recordings per camera per Phoenix day that earn session points. Clips at 5m+ always count. Hours still count in full. */
export const RECORDING_SESSION_POINTS_PER_DAY_CAP = 10;
/**
 * POV recordings that can score per camera per day. The accessory currently drops its connection
 * after ~12s, so an uncapped bonus would reward re-attaching in a loop rather than real use.
 */
export const POV_RECORDINGS_PER_DAY_CAP = 3;
/** Successful livestreams that score per camera per day. */
export const LIVESTREAMS_PER_DAY_CAP = 3;

/** Legacy ladder: longer always scores higher. 5m → 2×, 10m → 5×, 20m → 12×, 40m → 25×, 80m → 55×. */
const LEGACY_DURATION_MULTIPLIER_STEPS: ReadonlyArray<{
  minSeconds: number;
  multiplier: number;
}> = [
  { minSeconds: 80 * 60, multiplier: 55 },
  { minSeconds: 40 * 60, multiplier: 25 },
  { minSeconds: 20 * 60, multiplier: 12 },
  { minSeconds: 10 * 60, multiplier: 5 },
  { minSeconds: 5 * 60, multiplier: 2 },
];

/**
 * One-minute bins matching the fleet recording-length histogram. The 6–7 minute bin is the
 * mode and gets 25×; every other bin is 25× times that bin's share of the mode.
 * Under 2 minutes is not a flat 1×. 20 minutes and longer stays at the last bin, 2×.
 */
const BELL_DURATION_MULTIPLIER_STEPS: ReadonlyArray<{
  minSeconds: number;
  multiplier: number;
}> = [
  { minSeconds: 20 * 60, multiplier: 2 },
  { minSeconds: 19 * 60, multiplier: 2 },
  { minSeconds: 18 * 60, multiplier: 2 },
  { minSeconds: 17 * 60, multiplier: 3 },
  { minSeconds: 16 * 60, multiplier: 3 },
  { minSeconds: 15 * 60, multiplier: 4 },
  { minSeconds: 14 * 60, multiplier: 4 },
  { minSeconds: 13 * 60, multiplier: 5 },
  { minSeconds: 12 * 60, multiplier: 7 },
  { minSeconds: 11 * 60, multiplier: 9 },
  { minSeconds: 10 * 60, multiplier: 11 },
  { minSeconds: 9 * 60, multiplier: 14 },
  { minSeconds: 8 * 60, multiplier: 18 },
  { minSeconds: 7 * 60, multiplier: 22 },
  { minSeconds: 6 * 60, multiplier: 25 },
  { minSeconds: 5 * 60, multiplier: 24 },
  { minSeconds: 4 * 60, multiplier: 17 },
  { minSeconds: 3 * 60, multiplier: 12 },
  { minSeconds: 2 * 60, multiplier: 11 },
  { minSeconds: 1 * 60, multiplier: 9 },
  { minSeconds: 0, multiplier: 7 },
];

export function recordingDurationMultiplier(durationSeconds: number, eventTimeUtc?: string): number {
  const duration = Number(durationSeconds) || 0;
  const at = eventTimeUtc ? Date.parse(eventTimeUtc) : NaN;
  const bellFrom = Date.parse(RECORDING_MULTIPLIER_BELL_FROM_UTC);
  const steps =
    Number.isFinite(at) && at >= bellFrom
      ? BELL_DURATION_MULTIPLIER_STEPS
      : LEGACY_DURATION_MULTIPLIER_STEPS;
  for (const step of steps) {
    if (duration >= step.minSeconds) return step.multiplier;
  }
  return 1;
}

interface DailyRow {
  email: string;
  activity_date: string;
  recordingEvents: number;
  recordings: number;
  /** Successful qualifying recordings under the threshold — scored instead of, never alongside, `recordings`. */
  shortRecordings: number;
  /** Recordings triggered by attaching/detaching the POV. Counted in addition to the buckets above. */
  povRecordings: number;
  /** `povRecordings` after the per-camera-per-day cap — this is what actually scores. */
  povWeight: number;
  recordingWeight: number;
  hours: number;
  uploads: number;
  livestreams: number;
  /** `livestreams` after the per-camera-per-day cap — this is what actually scores. */
  livestreamWeight: number;
  /** Phone bond or comms session. Counted on the board, not scored. */
  mobileActions: number;
  reports: number;
}

interface AssignmentRow {
  assignment_id: string;
  camera_id: string;
  email: string;
  assigned_at_utc: string;
  unassigned_at_utc: string | null;
  source: string;
  status: string;
  created_at: string;
}

/** A successful qualifying recording, whatever its length. Duration decides which bucket it lands in. */
function isScorableRecording(event: {
  event_type: string;
  purpose: string | null;
  status: string | null;
}): boolean {
  if (event.event_type !== "recording") return false;
  if ((event.purpose || "").toUpperCase() !== "PURPOSE_STANDARD") return false;
  return (event.status || "").toLowerCase() === "success";
}

/**
 * A recording the participant triggered with the POV accessory — the camera reports this as the
 * recording's source. Deliberately substring-matched on "POV" so POV_ATTACH, POV_DETACH and any
 * future POV_* source all qualify without another deploy.
 */
function isPovRecording(event: { recording_source: string | null }): boolean {
  return (event.recording_source || "").toUpperCase().includes("POV");
}

function isValidRecording(
  event: {
    event_type: string;
    duration_seconds: number | null;
    purpose: string | null;
    status: string | null;
  },
  minSeconds: number,
): boolean {
  if (!isScorableRecording(event)) return false;
  return Number(event.duration_seconds || 0) >= minSeconds;
}

function emailHash(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12);
}

function applyCap(value: number, cap: number | null): number {
  if (cap == null) return value;
  return Math.min(value, cap);
}

function computeStreakDays(dates: string[]): number {
  if (!dates.length) return 0;
  const set = new Set(dates);
  const sorted = [...set].sort();
  let streak = 0;
  const cursor = new Date(sorted[sorted.length - 1] + "T00:00:00Z");
  while (true) {
    const key = cursor.toISOString().slice(0, 10);
    if (set.has(key)) {
      streak += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    } else break;
  }
  return streak;
}

/** Latest successful qualifying recording for this person (any camera). */
/**
 * When this person last recorded anything, for anchoring the inactivity penalty.
 *
 * Deliberately no duration floor, and deliberately not called "valid": a 27-second clip is
 * someone using the camera. It does not clear the 30-second scoring bar and so earns the short
 * bucket rather than a full recording — but charging idle days on top of that penalises them for
 * trying, on a day they demonstrably picked the device up.
 *
 * Whether a recording *scores* and whether it *counts as activity* are different questions. This
 * answers the second one.
 */
function lastRecordingUtc(email: string): string | null {
  const db = getDb();
  const start = competitionStartUtcISO();
  const row = db
    .prepare(
      `SELECT MAX(event_time_utc) AS t
       FROM activity_events
       WHERE lower(email) = lower(?)
         AND event_type = 'recording'
         AND upper(coalesce(purpose, '')) = 'PURPOSE_STANDARD'
         AND lower(coalesce(status, '')) = 'success'
         AND event_time_utc >= ?`,
    )
    .get(email, start) as { t: string | null } | undefined;
  return row?.t ?? null;
}

/**
 * Inactive days during an open assignment: rolling 24h from the last valid
 * recording event (not calendar-day noon). First −10 after `thresholdHours`
 * idle; another −10 every 24h after that.
 *
 * Scoped to the week being scored. A biweek sums two week rows, so a penalty measured from a
 * shared anchor was counted once per row — including for the second week before it had even
 * started, doubling everyone's penalty.
 *
 * The clock also cannot start before we knew the person had the camera. `assigned_at_utc` is
 * rewritten backwards by the cold-start attribution backfill (see `backfillOpenAssignmentStarts`),
 * so a camera registered today carries a start date from the top of the attribution window; using
 * the later of that and the row's `created_at` keeps someone from being penalised for days they
 * did not have the device.
 */
const SCORES_RESET_AT_KEY = "scores_reset_at";

/** When an admin last reset scores. Idle time cannot predate it — a reset means a clean slate. */
function scoresResetAtMs(): number {
  const row = getDb()
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(SCORES_RESET_AT_KEY) as { value: string } | undefined;
  const ms = row?.value ? new Date(row.value).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function computeInactiveDays(
  weekStart: string,
  weekEnd: string,
  assignments: AssignmentRow[],
  lastValidRecordingISO: string | null,
  thresholdHours: number,
  asOfISO: string,
): number {
  const open = assignments.filter(
    (a) =>
      (a.source === "fleet") &&
      a.status !== "provisional" &&
      a.status !== "returned",
  );
  if (!open.length) return 0;

  const weekStartMs = new Date(weekStart).getTime();
  const asOf = Math.min(new Date(asOfISO).getTime(), new Date(weekEnd).getTime() - 1);
  // Nothing to answer for in a week that has not begun.
  if (asOf < weekStartMs) return 0;

  const competitionStartMs = new Date(competitionStartUtcISO()).getTime();
  const coveredNow = open.some((a) => {
    const start = new Date(a.assigned_at_utc).getTime();
    const end = a.unassigned_at_utc ? new Date(a.unassigned_at_utc).getTime() : Infinity;
    return asOf >= start && asOf < end;
  });
  if (!coveredNow) return 0;

  // When their current holding was established. `assigned_at_utc` is rewritten backwards by the
  // cold-start attribution backfill, so it cannot be trusted on its own — `created_at` is when the
  // row actually entered the system, i.e. when the assignments CSV that granted it was uploaded.
  // Taking the LATEST across their open assignments means picking up a camera restarts the clock,
  // which is the point: someone who did not have the device cannot owe idle days on it.
  const assignmentAnchor = Math.max(
    ...open.map((a) =>
      Math.max(new Date(a.assigned_at_utc).getTime(), new Date(a.created_at).getTime()),
    ),
  );
  const recMs = lastValidRecordingISO ? new Date(lastValidRecordingISO).getTime() : 0;
  const lastRecInPeriod = recMs >= competitionStartMs ? recMs : 0;
  // Latest of: their last recording, when they got the camera, and the start of the scored window.
  // Whichever happened most recently is the only fair place to start counting idle time from.
  const anchor = Math.max(
    lastRecInPeriod,
    assignmentAnchor,
    competitionStartMs,
    weekStartMs,
    scoresResetAtMs(),
  );
  /*
   * Idle time is counted in Phoenix working hours, not wall-clock hours.
   *
   * The calendar version charged a day for Saturday and a day for Sunday, so a camera untouched
   * from Friday to Monday cost 200 points for two days nobody was expected to be recording. It
   * also contradicted the reminder rule, which already runs on working time — someone could be
   * losing points for days that were not yet enough to earn them a nudge.
   */
  const workingHoursIdle = workingHoursBetween(anchor, asOf);
  if (workingHoursIdle < thresholdHours) return 0;
  return 1 + Math.floor((workingHoursIdle - thresholdHours) / 24);
}

export function rebuildDailyActivity(weekStart: string): void {
  const db = getDb();
  const weekEnd = weekEndUtcISO(weekStart);
  db.prepare(`DELETE FROM daily_activity WHERE activity_date >= ? AND activity_date < ?`).run(
    phoenixDayKey(weekStart),
    phoenixDayKey(weekEnd),
  );

  const events = db
    .prepare(
      `SELECT * FROM activity_events
       WHERE email IS NOT NULL
         AND event_time_utc >= ?
         AND event_time_utc >= ?
         AND event_time_utc < ?`,
    )
    .all(competitionStartUtcISO(), weekStart, weekEnd) as Array<{
    email: string;
    event_time_utc: string;
    event_type: string;
    duration_seconds: number | null;
    purpose: string | null;
    status: string | null;
  }>;

  const reports = db
    .prepare(
      `SELECT email, reported_at_utc FROM reports
       WHERE status = 'approved'
         AND reported_at_utc >= ?
         AND reported_at_utc >= ?
         AND reported_at_utc < ?`,
    )
    .all(competitionStartUtcISO(), weekStart, weekEnd) as Array<{ email: string; reported_at_utc: string }>;

  type Acc = {
    recordings: number;
    hours: number;
    uploads: number;
    livestreams: number;
    reports: number;
  };
  const map = new Map<string, Acc>();

  const bump = (email: string, date: string, fn: (a: Acc) => void) => {
    const key = `${email}|${date}`;
    let acc = map.get(key);
    if (!acc) {
      acc = { recordings: 0, hours: 0, uploads: 0, livestreams: 0, reports: 0 };
      map.set(key, acc);
    }
    fn(acc);
  };

  for (const e of events) {
    if (!isParsableInstant(e.event_time_utc)) {
      unparsableInstants += 1;
      continue;
    }
    const date = phoenixDayKey(e.event_time_utc);
    if (isValidRecording(e, 30)) {
      bump(e.email, date, (a) => {
        a.recordings += 1;
        a.hours += Number(e.duration_seconds || 0) / 3600;
      });
    } else if (e.event_type === "upload" && (e.status || "").toLowerCase() === "success") {
      bump(e.email, date, (a) => {
        a.uploads += 1;
      });
    } else if (e.event_type === "livestream" && (e.status || "").toLowerCase() === "success") {
      bump(e.email, date, (a) => {
        a.livestreams += 1;
      });
    }
  }

  for (const r of reports) {
    if (!isParsableInstant(r.reported_at_utc)) {
      unparsableInstants += 1;
      continue;
    }
    bump(r.email.toLowerCase(), phoenixDayKey(r.reported_at_utc), (a) => {
      a.reports += 1;
    });
  }

  const insert = db.prepare(
    `INSERT INTO daily_activity (
      email, activity_date, week_start, recordings, hours, uploads, livestreams, reports
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const [key, acc] of map) {
      const [email, date] = key.split("|");
      insert.run(
        email,
        date,
        weekStart,
        acc.recordings,
        acc.hours,
        acc.uploads,
        acc.livestreams,
        acc.reports,
      );
    }
  });
  tx();
}

function currentCamera(email: string, asOfISO: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT a.camera_id FROM assignment_history a
       INNER JOIN cameras c ON c.camera_id = a.camera_id
       WHERE a.email = ?
         AND a.assigned_at_utc <= ?
         AND (a.unassigned_at_utc IS NULL OR a.unassigned_at_utc > ?)
         AND a.source IN ('fleet')
       ORDER BY a.assigned_at_utc DESC
       LIMIT 1`,
    )
    .get(email, asOfISO, asOfISO) as { camera_id: string } | undefined;
  return row?.camera_id ?? null;
}

/** Drop score rows for serials that are no longer in the live Fleet inventory. */
export function dropScoresForUnknownCameras(): number {
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM weekly_scores
       WHERE camera_id IS NOT NULL AND trim(camera_id) != ''
         AND camera_id NOT IN (SELECT camera_id FROM cameras)`,
    )
    .run();
  return Number(result.changes || 0);
}

function reconcileScoresToInventory(): void {
  const dropped = dropScoresForUnknownCameras();
  if (dropped > 0) {
    for (const ws of listLeaderboardWeeks()) {
      recomputeWeekScores(ws);
    }
  }
}

function loadCameraDaily(
  weekStart: string,
  weekEnd: string,
  opts: {
    minSeconds?: number;
    durationDoubleBaseSeconds?: number;
    durationMultiplierCapSeconds?: number;
    sessionPointsPerDayCap?: number;
    povRecordingsPerDayCap?: number;
    livestreamsPerDayCap?: number;
  } = {},
): Map<string, Map<string, DailyRow[]>> {
  const db = getDb();
  const events = db
    .prepare(
      `SELECT email, camera_id, event_time_utc, event_type, duration_seconds, purpose, status,
              recording_source
       FROM activity_events
       WHERE email IS NOT NULL
         AND event_time_utc >= ?
         AND event_time_utc >= ?
         AND event_time_utc < ?`,
    )
    .all(competitionStartUtcISO(), weekStart, weekEnd) as Array<{
    email: string;
    camera_id: string;
    event_time_utc: string;
    event_type: string;
    duration_seconds: number | null;
    purpose: string | null;
    status: string | null;
    recording_source: string | null;
  }>;

  const minSeconds = opts.minSeconds ?? 30;
  const doubleBase = opts.durationDoubleBaseSeconds ?? RECORDING_DURATION_DOUBLE_BASE_SECONDS;
  const sessionDayCap = opts.sessionPointsPerDayCap ?? RECORDING_SESSION_POINTS_PER_DAY_CAP;
  const povDayCap = opts.povRecordingsPerDayCap ?? POV_RECORDINGS_PER_DAY_CAP;
  const livestreamDayCap = opts.livestreamsPerDayCap ?? LIVESTREAMS_PER_DAY_CAP;

  type Acc = {
    recordingDurations: Array<{ duration: number; at: string }>;
    recordingEvents: number;
    shortRecordings: number;
    povRecordings: number;
    hours: number;
    uploads: number;
    livestreams: number;
    mobileActions: number;
    reports: number;
  };
  const map = new Map<string, Acc>();

  for (const e of events) {
    const cameraId = (e.camera_id || "").trim();
    if (!cameraId) continue;
    // A timestamp we cannot parse has no day, no week and no period. Skip it rather than let it
    // throw out of Intl and 500 the entire board — see isParsableInstant.
    if (!isParsableInstant(e.event_time_utc)) {
      unparsableInstants += 1;
      continue;
    }
    const email = e.email.toLowerCase();
    const date = phoenixDayKey(e.event_time_utc);
    const key = `${email}|${cameraId}|${date}`;
    let acc = map.get(key);
    if (!acc) {
      acc = {
        recordingDurations: [],
        recordingEvents: 0,
        shortRecordings: 0,
        povRecordings: 0,
        hours: 0,
        uploads: 0,
        livestreams: 0,
        mobileActions: 0,
        reports: 0,
      };
      map.set(key, acc);
    }
    // Splunk logs a recording twice: a zero-duration `started` row and a `success` row when it
    // completes. Counting raw rows made this column exactly double the real total and stopped it
    // reconciling with the two buckets below it, which both require a completed qualifying recording.
    if (isScorableRecording(e)) {
      acc.recordingEvents += 1;
      // Additive bonus: a POV recording still lands in the long/short bucket below and earns
      // those points too. Counted here as well, never instead.
      if (isPovRecording(e)) acc.povRecordings += 1;
    } else if (e.event_type === "pov_state" && isPovRecording(e)) {
      // Newer exports do not stamp StartReason on the recording. They emit a separate
      // pov_state row when a recording starts with the POV attached. That row has no
      // duration, so it earns the POV bonus and nothing in the recording buckets.
      acc.povRecordings += 1;
    }
    if (isValidRecording(e, minSeconds)) {
      const duration = Number(e.duration_seconds || 0);
      acc.recordingDurations.push({ duration, at: e.event_time_utc });
      acc.hours += duration / 3600;
    } else if (isScorableRecording(e)) {
      // Same recording, just under the threshold — counted here and nowhere else.
      acc.shortRecordings += 1;
    } else if (e.event_type === "upload" && (e.status || "").toLowerCase() === "success") {
      acc.uploads += 1;
    } else if (e.event_type === "livestream" && (e.status || "").toLowerCase() === "success") {
      acc.livestreams += 1;
    } else if (e.event_type === "mobile" && (e.status || "").toLowerCase() === "success") {
      acc.mobileActions += 1;
    }
  }

  const out = new Map<string, Map<string, DailyRow[]>>();
  for (const [key, acc] of map) {
    const [email, cameraId, date] = key.split("|");
    let byCam = out.get(email);
    if (!byCam) {
      byCam = new Map();
      out.set(email, byCam);
    }
    const days = byCam.get(cameraId) ?? [];
    const longDurations = acc.recordingDurations.filter((d) => d.duration >= doubleBase);
    const shortDurations = acc.recordingDurations
      .filter((d) => d.duration < doubleBase)
      .slice(0, sessionDayCap);
    const recordingWeight = [...longDurations, ...shortDurations].reduce(
      (n, clip) => n + recordingDurationMultiplier(clip.duration, clip.at),
      0,
    );
    days.push({
      email,
      activity_date: date,
      recordingEvents: acc.recordingEvents,
      recordings: acc.recordingDurations.length,
      shortRecordings: acc.shortRecordings,
      povRecordings: acc.povRecordings,
      povWeight: Math.min(acc.povRecordings, povDayCap),
      recordingWeight,
      hours: acc.hours,
      uploads: acc.uploads,
      livestreams: acc.livestreams,
      livestreamWeight: Math.min(acc.livestreams, livestreamDayCap),
      mobileActions: acc.mobileActions,
      reports: acc.reports,
    });
    byCam.set(cameraId, days);
  }

  attachApprovedReports(db, out, weekStart, weekEnd);
  return out;
}

/**
 * Approved reports belong to a person, but these boards are keyed by camera, so each report has to
 * be pinned to exactly one. Put it on the camera that person scored highest on this period —
 * ranked by recording weight, then hours, then serial for a stable result — so on the permanent
 * board (one row per camera) the report lands on their real entry instead of spinning up a
 * near-empty second row for whichever camera happened to be assigned that day.
 *
 * Someone with no recorded activity at all still needs somewhere to land, so fall back to the
 * camera assigned when they filed it. Without any camera the report cannot be placed on a
 * camera-keyed board and is skipped.
 */
function attachApprovedReports(
  db: ReturnType<typeof getDb>,
  out: Map<string, Map<string, DailyRow[]>>,
  weekStart: string,
  weekEnd: string,
): void {
  const approvedReports = db
    .prepare(
      `SELECT email, reported_at_utc FROM reports
       WHERE status = 'approved'
         AND email IS NOT NULL
         AND reported_at_utc >= ?
         AND reported_at_utc >= ?
         AND reported_at_utc < ?`,
    )
    .all(competitionStartUtcISO(), weekStart, weekEnd) as Array<{
    email: string;
    reported_at_utc: string;
  }>;
  if (!approvedReports.length) return;

  const assignments = db
    .prepare(
      `SELECT email, camera_id, assigned_at_utc, unassigned_at_utc
       FROM assignment_history
       WHERE email IS NOT NULL AND source IN ('fleet')`,
    )
    .all() as Array<{
    email: string;
    camera_id: string;
    assigned_at_utc: string;
    unassigned_at_utc: string | null;
  }>;

  const bestCameraFor = (email: string): string => {
    const byCam = out.get(email);
    if (!byCam?.size) return "";
    return [...byCam.entries()]
      .map(([cameraId, days]) => ({
        cameraId,
        weight: days.reduce((n, d) => n + d.recordingWeight, 0),
        hours: days.reduce((n, d) => n + d.hours, 0),
      }))
      .sort(
        (a, b) =>
          b.weight - a.weight || b.hours - a.hours || a.cameraId.localeCompare(b.cameraId),
      )[0].cameraId;
  };

  for (const r of approvedReports) {
    if (!isParsableInstant(r.reported_at_utc)) {
      unparsableInstants += 1;
      continue;
    }
    const email = r.email.toLowerCase();
    const date = phoenixDayKey(r.reported_at_utc);

    let cameraId = bestCameraFor(email);
    if (!cameraId) {
      const at = new Date(r.reported_at_utc).getTime();
      cameraId =
        assignments
          .filter(
            (a) =>
              a.email.toLowerCase() === email &&
              new Date(a.assigned_at_utc).getTime() <= at &&
              (!a.unassigned_at_utc || new Date(a.unassigned_at_utc).getTime() > at),
          )
          .sort(
            (a, b) =>
              new Date(b.assigned_at_utc).getTime() - new Date(a.assigned_at_utc).getTime() ||
              a.camera_id.localeCompare(b.camera_id),
          )[0]?.camera_id ?? "";
    }
    if (!cameraId) continue;

    let byCam = out.get(email);
    if (!byCam) {
      byCam = new Map();
      out.set(email, byCam);
    }
    const days = byCam.get(cameraId) ?? [];
    const day = days.find((d) => d.activity_date === date);
    if (day) {
      day.reports += 1;
    } else {
      days.push({
        email,
        activity_date: date,
        recordingEvents: 0,
        recordings: 0,
        shortRecordings: 0,
        povRecordings: 0,
        povWeight: 0,
        recordingWeight: 0,
        hours: 0,
        uploads: 0,
        livestreams: 0,
        livestreamWeight: 0,
        mobileActions: 0,
        reports: 1,
      });
    }
    byCam.set(cameraId, days);
  }
}

export interface ScoreRowSnapshot {
  email: string;
  name: string;
  cameraId: string | null;
  totalPoints: number;
  rank: number;
  breakdown: ScoreMetricBreakdown[];
}

export interface RecomputeOptions {
  /** Override profile resolution (draft preview). */
  profileOverride?: ResolvedProfile;
  /** When false, compute ranks/totals without writing weekly_scores. Default true. */
  persist?: boolean;
}

export function recomputeWeekScores(
  weekStart?: string,
  asOfISO = nowISO(),
  opts: RecomputeOptions = {},
): {
  weekStart: string;
  profileId: string;
  version: number;
  count: number;
  entries: ScoreRowSnapshot[];
} {
  const db = getDb();
  const ws = weekStart || periodWeekStartUtcISO(asOfISO);
  const weekEnd = weekEndUtcISO(ws);
  const resolved = opts.profileOverride || resolveProfileForWeek(ws);
  const persist = opts.persist !== false;
  const unparsableBefore = unparsableInstants;
  rebuildDailyActivity(ws);

  const participants = db
    .prepare(`SELECT email, name FROM participants WHERE signup_status IN ('pending', 'approved')`)
    .all() as Array<{ email: string; name: string }>;

  const recordingRule = resolved.rules.find((r) => r.metricKey === "recording_count");
  let durationDoubleBaseSeconds = RECORDING_DURATION_DOUBLE_BASE_SECONDS;
  let durationMultiplierCapSeconds = RECORDING_DURATION_MULTIPLIER_CAP_SECONDS;
  let sessionPointsPerDayCap = RECORDING_SESSION_POINTS_PER_DAY_CAP;
  try {
    const parsed = JSON.parse(recordingRule?.paramsJson || "{}") as {
      durationDoubleBaseSeconds?: number;
      durationMultiplierCapSeconds?: number;
      sessionPointsPerDayCap?: number;
    };
    if (Number.isFinite(parsed.durationDoubleBaseSeconds) && (parsed.durationDoubleBaseSeconds ?? 0) > 0) {
      durationDoubleBaseSeconds = Number(parsed.durationDoubleBaseSeconds);
    }
    if (
      Number.isFinite(parsed.durationMultiplierCapSeconds) &&
      (parsed.durationMultiplierCapSeconds ?? 0) > 0
    ) {
      durationMultiplierCapSeconds = Number(parsed.durationMultiplierCapSeconds);
    }
    if (Number.isFinite(parsed.sessionPointsPerDayCap) && (parsed.sessionPointsPerDayCap ?? 0) > 0) {
      sessionPointsPerDayCap = Number(parsed.sessionPointsPerDayCap);
    }
  } catch {
    // default
  }

  const povRule = resolved.rules.find((r) => r.metricKey === "pov_recording_count");
  let povRecordingsPerDayCap = POV_RECORDINGS_PER_DAY_CAP;
  try {
    const parsed = JSON.parse(povRule?.paramsJson || "{}") as { povRecordingsPerDayCap?: number };
    if (Number.isFinite(parsed.povRecordingsPerDayCap) && (parsed.povRecordingsPerDayCap ?? 0) > 0) {
      povRecordingsPerDayCap = Number(parsed.povRecordingsPerDayCap);
    }
  } catch {
    // default
  }

  const cameraDaily = loadCameraDaily(ws, weekEnd, {
    minSeconds: recordingRule?.minimum ?? 30,
    durationDoubleBaseSeconds,
    durationMultiplierCapSeconds,
    sessionPointsPerDayCap,
    povRecordingsPerDayCap,
    livestreamsPerDayCap: (() => {
      const livestreamRule = resolved.rules.find((r) => r.metricKey === "livestream_count");
      try {
        const parsed = JSON.parse(livestreamRule?.paramsJson || "{}") as { livestreamsPerDayCap?: number };
        if (Number.isFinite(parsed.livestreamsPerDayCap) && (parsed.livestreamsPerDayCap ?? 0) > 0) {
          return Number(parsed.livestreamsPerDayCap);
        }
      } catch {
        // default
      }
      return LIVESTREAMS_PER_DAY_CAP;
    })(),
  });
  const challengeBonuses = loadChallengeBonuses(ws);
  const manualAdjustments = loadManualAdjustments(ws);

  const assignments = db
    .prepare(`SELECT * FROM assignment_history`)
    .all() as AssignmentRow[];

  type Scored = {
    email: string;
    name: string;
    cameraId: string | null;
    total: number;
    raw: Record<MetricKey, number> & { recording_weight?: number; upload_weight?: number };
    breakdown: ScoreMetricBreakdown[];
  };

  const scored: Scored[] = [];

  for (const p of participants) {
    const byCam = cameraDaily.get(p.email.toLowerCase()) ?? new Map<string, DailyRow[]>();
    const cameraIds = [...byCam.keys()].sort();
    const targets = cameraIds.length
      ? cameraIds
      : [currentCamera(p.email, asOfISO)];
    const homeCamera = targets[0] ?? null;
    const liveCamera = currentCamera(p.email, asOfISO);
    const lastRecAny = lastRecordingUtc(p.email);
    const personAssign = assignments.filter(
      (a) => a.email.toLowerCase() === p.email.toLowerCase(),
    );
    const bonus = challengeBonuses.get(p.email.toLowerCase());

    for (const cameraId of targets) {
      const days = (cameraId && byCam.get(cameraId)) || [];
      const challengePoints =
        (cameraId && bonus?.scoped.get(cameraId) ? bonus.scoped.get(cameraId)! : 0) +
        (cameraId === homeCamera ? bonus?.unscoped ?? 0 : 0);
      const manualAdjustment = cameraId === homeCamera ? (manualAdjustments.get(p.email.toLowerCase()) ?? 0) : 0;
      const raw = computeRawMetrics(
        days,
        personAssign,
        ws,
        weekEnd,
        asOfISO,
        resolved,
        challengePoints,
        manualAdjustment,
        lastRecAny,
      );
      if (!liveCamera || cameraId !== liveCamera) {
        raw.inactive_day_count = 0;
      }
      const breakdown: ScoreMetricBreakdown[] = [];
      let total = 0;

      for (const rule of [...resolved.rules].sort((a, b) => a.displayOrder - b.displayOrder)) {
        const rawValue = raw[rule.metricKey] ?? 0;
        let units = rawValue;
        if (rule.metricKey === "active_day_streak") {
          units = applyCap(rawValue, rule.cap);
        } else if (rule.cap != null) {
          units = applyCap(rawValue, rule.cap);
        }
        const scoredUnits =
          rule.metricKey === "recording_count"
            ? (raw.recording_weight ?? units)
            : rule.metricKey === "upload_count"
              ? (raw.upload_weight ?? units)
              : rule.metricKey === "pov_recording_count"
                ? (raw.pov_weight ?? units)
                : rule.metricKey === "livestream_count"
                  ? (raw.livestream_weight ?? units)
                  : units;
        const points = rule.enabled ? scoredUnits * rule.pointsPerUnit : 0;
        if (rule.enabled) total += points;
        breakdown.push({
          metricKey: rule.metricKey,
          label: rule.label,
          raw: rawValue,
          points,
          enabled: rule.enabled,
          displayOrder: rule.displayOrder,
        });
      }

      scored.push({
        email: p.email,
        name: (p.name && String(p.name).trim()) || emailHandle(p.email),
        cameraId,
        total: Math.round(total * 1000) / 1000,
        raw,
        breakdown: breakdown.map((b) => ({
          ...b,
          points: Math.round(b.points * 1000) / 1000,
        })),
      });
    }
  }

  scored.sort((a, b) => compareScores(a, b, resolved.tieBreakers));

  const entries: ScoreRowSnapshot[] = scored.map((s, idx) => ({
    email: s.email,
    name: s.name,
    cameraId: s.cameraId,
    totalPoints: s.total,
    rank: idx + 1,
    breakdown: s.breakdown,
  }));

  if (persist) {
    db.prepare(`DELETE FROM weekly_scores WHERE week_start = ?`).run(ws);
    const insert = db.prepare(
      `INSERT INTO weekly_scores (
        email, week_start, scoring_profile_id, scoring_profile_version,
        total_points, rank, camera_id, metrics_json, recomputed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const recomputedAt = nowISO();
    const tx = db.transaction(() => {
      scored.forEach((s, idx) => {
        insert.run(
          s.email,
          ws,
          resolved.profile.profileId,
          resolved.profile.version,
          s.total,
          idx + 1,
          s.cameraId ?? "",
          JSON.stringify({ raw: s.raw, breakdown: s.breakdown }),
          recomputedAt,
        );
      });
    });
    tx();

    db.prepare(
      `INSERT INTO sync_meta(key, value) VALUES('last_score_recompute', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(recomputedAt);
  }

  const skipped = unparsableInstants - unparsableBefore;
  if (skipped > 0) {
    console.warn(
      // Both rebuildDailyActivity and loadCameraDaily scan the same events, so one bad row is
      // counted twice here. Report reads rather than rows instead of implying a distinct count.
      `Week ${ws}: skipped ${skipped} row read(s) with an unparseable timestamp. ` +
        `Find them with: SELECT event_id, camera_id, event_time_utc FROM activity_events ` +
        `WHERE event_time_utc IS NULL OR datetime(event_time_utc) IS NULL;`,
    );
  }

  return {
    weekStart: ws,
    profileId: resolved.profile.profileId,
    version: resolved.profile.version,
    count: scored.length,
    entries,
  };
}

export function readWeekScoreRows(weekStart: string): ScoreRowSnapshot[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ws.*, p.name
       FROM weekly_scores ws
       JOIN participants p ON lower(p.email) = lower(ws.email)
       WHERE ws.week_start = ?
       ORDER BY ws.rank ASC`,
    )
    .all(weekStart) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const metrics = JSON.parse(String(r.metrics_json || "{}")) as {
      breakdown?: ScoreMetricBreakdown[];
    };
    return {
      email: String(r.email),
      name: (r.name && String(r.name).trim()) || emailHandle(String(r.email)),
      cameraId: r.camera_id ? String(r.camera_id) : null,
      totalPoints: Number(r.total_points),
      rank: Number(r.rank),
      breakdown: metrics.breakdown || [],
    };
  });
}

export function diffScoreRows(
  before: ScoreRowSnapshot[],
  after: ScoreRowSnapshot[],
): Array<{
  email: string;
  name: string;
  beforePoints: number;
  afterPoints: number;
  deltaPoints: number;
  beforeRank: number | null;
  afterRank: number | null;
}> {
  const rowKey = (r: ScoreRowSnapshot) =>
    `${r.email.toLowerCase()}|${r.cameraId || ""}`;
  const beforeMap = new Map(before.map((r) => [rowKey(r), r]));
  const afterMap = new Map(after.map((r) => [rowKey(r), r]));
  const emails = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const deltas = [];
  for (const email of emails) {
    const b = beforeMap.get(email);
    const a = afterMap.get(email);
    const beforePoints = b?.totalPoints ?? 0;
    const afterPoints = a?.totalPoints ?? 0;
    const beforeRank = b?.rank ?? null;
    const afterRank = a?.rank ?? null;
    if (beforePoints === afterPoints && beforeRank === afterRank) continue;
    deltas.push({
      email,
      name: a?.name || b?.name || email,
      beforePoints,
      afterPoints,
      deltaPoints: Math.round((afterPoints - beforePoints) * 1000) / 1000,
      beforeRank,
      afterRank,
    });
  }
  deltas.sort((x, y) => Math.abs(y.deltaPoints) - Math.abs(x.deltaPoints));
  return deltas;
}

/** Persist immutable weekly snapshot bound to the scoring profile used for that week. */
export function snapshotOpenWeek(
  actor: string,
  weekStart?: string,
  reason = "manual_snapshot",
): { weekStart: string; revision: number; profileId: string; version: number } {
  const db = getDb();
  const ws = weekStart || periodWeekStartUtcISO(new Date());
  const scores = recomputeWeekScores(ws);
  const resolved = resolveProfileForWeek(ws);
  const maxRow = db
    .prepare(`SELECT MAX(revision) as rev FROM weekly_snapshots WHERE week_start = ?`)
    .get(ws) as { rev: number | null } | undefined;
  const revision = (maxRow?.rev || 0) + 1;
  const payload = {
    weekStart: ws,
    scoringProfile: {
      profileId: resolved.profile.profileId,
      version: resolved.profile.version,
      name: resolved.profile.name,
      rules: resolved.rules,
      tieBreakers: resolved.tieBreakers,
    },
    entries: readWeekScoreRows(ws),
    recomputed: scores,
  };
  db.prepare(
    `INSERT INTO weekly_snapshots (
      week_start, revision, scoring_profile_id, scoring_profile_version,
      payload_json, created_at, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ws,
    revision,
    resolved.profile.profileId,
    resolved.profile.version,
    JSON.stringify(payload),
    nowISO(),
    reason,
  );
  audit(actor, "snapshot.create", {
    entityType: "weekly_snapshot",
    entityId: `${ws}#${revision}`,
    reason,
    newValue: {
      profileId: resolved.profile.profileId,
      version: resolved.profile.version,
    },
  });
  return {
    weekStart: ws,
    revision,
    profileId: resolved.profile.profileId,
    version: resolved.profile.version,
  };
}

export function listSnapshots(limit = 20) {
  return getDb()
    .prepare(
      `SELECT week_start as weekStart, revision, scoring_profile_id as profileId,
              scoring_profile_version as version, created_at as createdAt, reason
       FROM weekly_snapshots
       ORDER BY week_start DESC, revision DESC
       LIMIT ?`,
    )
    .all(limit);
}

/**
 * Audited correction stub: recompute an open or closed week and write a new snapshot revision.
 * Closed-week historical revision path for local/Harbor scoring.
 */
export function correctWeekScores(
  actor: string,
  weekStart: string,
  reason: string,
): {
  weekStart: string;
  scores: ReturnType<typeof recomputeWeekScores>;
  snapshot: ReturnType<typeof snapshotOpenWeek>;
} {
  if (!reason?.trim()) throw new Error("Correction requires an audit reason");
  const before = readWeekScoreRows(weekStart);
  const scores = recomputeWeekScores(weekStart);
  const after = readWeekScoreRows(weekStart);
  const snapshot = snapshotOpenWeek(actor, weekStart, `correction: ${reason}`);
  audit(actor, "scores.correction", {
    entityType: "weekly_scores",
    entityId: weekStart,
    reason,
    oldValue: { entries: before.slice(0, 50) },
    newValue: { entries: after.slice(0, 50), deltas: diffScoreRows(before, after).slice(0, 50) },
  });
  return { weekStart, scores, snapshot };
}

function loadManualAdjustments(weekStart: string): Map<string, number> {
  const db = getDb();
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'score_adjustments'`)
    .get() as { name?: string } | undefined;
  if (!exists) return new Map();
  const rows = db
    .prepare(
      `SELECT lower(email) AS email, SUM(delta_points) AS points
       FROM score_adjustments
       WHERE week_start = ? AND revoked_at IS NULL
       GROUP BY lower(email)`,
    )
    .all(weekStart) as Array<{ email: string; points: number }>;
  return new Map(rows.map((r) => [r.email, Number(r.points) || 0]));
}

function loadChallengeBonuses(
  weekStart: string,
): Map<string, { scoped: Map<string, number>; unscoped: number }> {
  const db = getDb();
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'challenge_awards'`)
    .get() as { name?: string } | undefined;
  if (!exists) return new Map();
  const rows = db
    .prepare(
      `SELECT lower(email) AS email, camera_id, SUM(points) AS points
       FROM challenge_awards
       WHERE week_start = ? AND revoked_at IS NULL
       GROUP BY lower(email), camera_id`,
    )
    .all(weekStart) as Array<{ email: string; camera_id: string | null; points: number }>;
  const out = new Map<string, { scoped: Map<string, number>; unscoped: number }>();
  for (const r of rows) {
    let acc = out.get(r.email);
    if (!acc) {
      acc = { scoped: new Map(), unscoped: 0 };
      out.set(r.email, acc);
    }
    if (r.camera_id) acc.scoped.set(r.camera_id, Number(r.points) || 0);
    else acc.unscoped += Number(r.points) || 0;
  }
  return out;
}

type RawMetrics = Record<MetricKey, number> & {
  recording_weight: number;
  upload_weight: number;
  pov_weight: number;
  livestream_weight: number;
};

function computeRawMetrics(
  days: DailyRow[],
  assignments: AssignmentRow[],
  weekStart: string,
  weekEnd: string,
  asOfISO: string,
  resolved: ResolvedProfile,
  challengePoints = 0,
  manualAdjustment = 0,
  lastValidRecordingISO: string | null = null,
): RawMetrics {
  const recordingEvents = days.reduce((n, d) => n + d.recordingEvents, 0);
  const recordings = days.reduce((n, d) => n + d.recordings, 0);
  const shortRecordings = days.reduce((n, d) => n + d.shortRecordings, 0);
  const recordingWeight = days.reduce((n, d) => n + d.recordingWeight, 0);
  const hours = days.reduce((n, d) => n + d.hours, 0);
  const uploads = days.reduce((n, d) => n + d.uploads, 0);
  const uploadRule = resolved.rules.find((r) => r.metricKey === "upload_count");
  const uploadPointsPerUnit = uploadRule?.pointsPerUnit || 8;
  let uploadPointsPerDayCap = 8;
  try {
    const parsed = JSON.parse(uploadRule?.paramsJson || "{}") as { uploadPointsPerDayCap?: number };
    if (Number.isFinite(parsed.uploadPointsPerDayCap) && (parsed.uploadPointsPerDayCap ?? 0) > 0) {
      uploadPointsPerDayCap = Number(parsed.uploadPointsPerDayCap);
    }
  } catch {
    // default
  }
  const scoredUploadsPerDay =
    uploadPointsPerUnit > 0 ? uploadPointsPerDayCap / uploadPointsPerUnit : 0;
  const uploadWeight = days.reduce(
    (n, d) => n + Math.min(d.uploads, scoredUploadsPerDay),
    0,
  );
  const povRecordings = days.reduce((n, d) => n + d.povRecordings, 0);
  const povWeight = days.reduce((n, d) => n + d.povWeight, 0);
  const livestreams = days.reduce((n, d) => n + d.livestreams, 0);
  const livestreamWeight = days.reduce((n, d) => n + d.livestreamWeight, 0);
  const mobileActions = days.reduce((n, d) => n + d.mobileActions, 0);
  const reports = days.reduce((n, d) => n + d.reports, 0);
  const activeDates = days
    .filter((d) => d.recordings > 0 || d.uploads > 0 || d.livestreams > 0 || d.reports > 0)
    .map((d) => d.activity_date);
  const streak = computeStreakDays(activeDates);

  const recordingRule = resolved.rules.find((r) => r.metricKey === "recording_count");
  const inactiveRule = resolved.rules.find((r) => r.metricKey === "inactive_day_count");
  let thresholdHours = 24;
  try {
    thresholdHours = JSON.parse(inactiveRule?.paramsJson || "{}").thresholdHours ?? 24;
  } catch {
    // default
  }

  const inactive = computeInactiveDays(
    weekStart,
    weekEnd,
    assignments,
    lastValidRecordingISO,
    thresholdHours,
    asOfISO,
  );

  void recordingRule;

  return {
    recording_event_count: recordingEvents,
    recording_count: recordings,
    short_recording_count: shortRecordings,
    recording_weight: recordingWeight,
    recording_hours: Math.round(hours * 1000) / 1000,
    upload_count: uploads,
    upload_weight: uploadWeight,
    livestream_count: livestreams,
    livestream_weight: livestreamWeight,
    mobile_action_count: mobileActions,
    pov_recording_count: povRecordings,
    pov_weight: povWeight,
    approved_report_count: reports,
    active_day_streak: streak,
    inactive_day_count: inactive,
    challenge_bonus: challengePoints,
    manual_adjustment: manualAdjustment,
  };
}

function compareScores(
  a: { total: number; name: string; cameraId: string | null; raw: Record<MetricKey, number> },
  b: { total: number; name: string; cameraId: string | null; raw: Record<MetricKey, number> },
  tieBreakers: MetricKey[],
): number {
  if (b.total !== a.total) return b.total - a.total;
  for (const key of tieBreakers) {
    const diff = (b.raw[key] ?? 0) - (a.raw[key] ?? 0);
    if (diff !== 0) return diff;
  }
  const nameCmp = a.name.localeCompare(b.name);
  if (nameCmp !== 0) return nameCmp;
  return (a.cameraId || "").localeCompare(b.cameraId || "");
}

/** Weeks that have activity/scores, plus the open Phoenix week (newest first). */
export interface ResetScoresResult {
  dryRun: boolean;
  scope: "period" | "all";
  weekStart: string | null;
  weeksRecomputed: string[];
  cleared: {
    weeklyScores: number;
    dailyActivity: number;
    activityEvents: number;
    quarantinedActivity: number;
    scoreAdjustments: number;
    challengeAwards: number;
    reports: number;
  };
}

/**
 * Wipe scores back to zero.
 *
 * Deleting `weekly_scores` on its own achieves nothing: `ensureWeekScoreRows` recomputes any week
 * with no rows the next time a board is read, so the same numbers come straight back from
 * `activity_events`. A reset that actually holds has to clear the source data, which is why
 * `clearActivity` defaults on — leave it off and this is just a recalculation.
 *
 * Manual credit (admin adjustments, challenge bonuses) and approved reports are opt-in to clear, so
 * an admin can reset imported activity without throwing away points they granted by hand.
 */
export function resetScores(
  actor: string,
  opts: {
    weekStart?: string;
    clearActivity?: boolean;
    clearManual?: boolean;
    clearReports?: boolean;
    dryRun?: boolean;
  } = {},
): ResetScoresResult {
  const db = getDb();
  const dryRun = opts.dryRun !== false;
  const clearActivity = opts.clearActivity !== false;
  const clearManual = Boolean(opts.clearManual);
  const clearReports = Boolean(opts.clearReports);

  const weekStart = opts.weekStart?.trim() || null;
  const scope: "period" | "all" = weekStart ? "period" : "all";
  const weekEnd = weekStart ? weekEndUtcISO(weekStart) : null;

  const countWeek = (table: string) =>
    weekStart
      ? (
          db
            .prepare(`SELECT count(*) AS c FROM ${table} WHERE week_start = ?`)
            .get(weekStart) as { c: number }
        ).c
      : (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;

  const countQuarantine = () =>
    weekStart && weekEnd
      ? (
          db
            .prepare(
              `SELECT count(*) AS c FROM quarantined_activity
               WHERE event_time_utc >= ? AND event_time_utc < ?`,
            )
            .get(weekStart, weekEnd) as { c: number }
        ).c
      : (db.prepare(`SELECT count(*) AS c FROM quarantined_activity`).get() as { c: number }).c;

  const cleared = {
    weeklyScores: countWeek("weekly_scores"),
    dailyActivity: countWeek("daily_activity"),
    activityEvents: clearActivity ? countWeek("activity_events") : 0,
    quarantinedActivity: clearActivity ? countQuarantine() : 0,
    scoreAdjustments: clearManual ? countWeek("score_adjustments") : 0,
    challengeAwards: clearManual ? countWeek("challenge_awards") : 0,
    reports: clearReports ? countWeek("reports") : 0,
  };

  // Capture the weeks to rebuild before anything is deleted, so scoped resets still leave
  // consistent (zeroed) rows behind rather than stale ones.
  const weeks = weekStart ? [weekStart] : listLeaderboardWeeks();

  if (dryRun) {
    return { dryRun, scope, weekStart, weeksRecomputed: [], cleared };
  }

  const delWeek = (table: string) => {
    if (weekStart) db.prepare(`DELETE FROM ${table} WHERE week_start = ?`).run(weekStart);
    else db.prepare(`DELETE FROM ${table}`).run();
  };

  const tx = db.transaction(() => {
    if (clearActivity) {
      delWeek("activity_events");
      if (weekStart && weekEnd) {
        db.prepare(
          `DELETE FROM quarantined_activity WHERE event_time_utc >= ? AND event_time_utc < ?`,
        ).run(weekStart, weekEnd);
      } else {
        db.prepare(`DELETE FROM quarantined_activity`).run();
      }
    }
    if (clearManual) {
      delWeek("score_adjustments");
      delWeek("challenge_awards");
    }
    if (clearReports) delWeek("reports");
    delWeek("daily_activity");
    delWeek("weekly_scores");
  });
  tx();

  // Restart the idle clock: wiping activity would otherwise read as "never recorded since you got
  // the camera" and hand everyone an inactivity penalty the moment scores were reset to zero.
  db.prepare(
    `INSERT INTO sync_meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SCORES_RESET_AT_KEY, nowISO());

  for (const ws of weeks) recomputeWeekScores(ws);

  audit(actor, "scores.reset", {
    entityType: "weekly_scores",
    entityId: weekStart || "all",
    newValue: { scope, clearActivity, clearManual, clearReports, cleared, weeks },
  });

  return { dryRun, scope, weekStart, weeksRecomputed: weeks, cleared };
}

export function listLeaderboardWeeks(opts?: { includePreseason?: boolean }): string[] {
  const db = getDb();
  const currentPeriod = biweekStartUtcISO(new Date());
  const [firstWeek, secondWeek] = weeksInBiweek(currentPeriod);
  const fromDb = db
    .prepare(
      `SELECT week_start AS ws FROM activity_events WHERE week_start IS NOT NULL
       UNION
       SELECT week_start AS ws FROM weekly_scores
       UNION
       SELECT ? AS ws
       UNION
       SELECT ? AS ws`,
    )
    .all(firstWeek, secondWeek) as Array<{ ws: string }>;
  const startMs = new Date(competitionStartUtcISO()).getTime();
  return [...new Set(fromDb.map((r) => r.ws).filter(Boolean))]
    .filter((ws) => opts?.includePreseason || new Date(ws).getTime() >= startMs)
    .sort((a, b) => b.localeCompare(a));
}

/**
 * Prefer the week that the latest committed import wrote into, so Splunk CSVs
 * that land in the prior Phoenix week still surface on the default leaderboard.
 */
export function defaultLeaderboardWeek(): string {
  return periodWeekStartUtcISO(new Date());
}

function emptyMetricRaw(): Record<MetricKey, number> {
  return {
    recording_event_count: 0,
    recording_count: 0,
    short_recording_count: 0,
    recording_hours: 0,
    upload_count: 0,
    livestream_count: 0,
    mobile_action_count: 0,
    pov_recording_count: 0,
    approved_report_count: 0,
    active_day_streak: 0,
    inactive_day_count: 0,
    challenge_bonus: 0,
    manual_adjustment: 0,
  };
}

const SCORING_FORMULA_VERSION = "livestream-50-cap-3-2026-09-30";

function ensureScoringFormula(): void {
  const db = getDb();
  const row = db
    .prepare(`SELECT value FROM sync_meta WHERE key = 'scoring_formula'`)
    .get() as { value: string } | undefined;
  if (row?.value === SCORING_FORMULA_VERSION) return;
  const start = competitionStartUtcISO();
  db.prepare(
    `UPDATE pending_nudges SET status = 'cancelled'
     WHERE status IN ('queued', 'pending') AND created_at < ?`,
  ).run(start);
  for (const ws of listLeaderboardWeeks()) {
    recomputeWeekScores(ws);
  }
  db.prepare(
    `INSERT INTO sync_meta(key, value) VALUES('scoring_formula', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SCORING_FORMULA_VERSION);
}

/** All-time person standings: same weekly scores as the camera boards, summed across every window. */
export function getOverallLeaderboard() {
  ensureScoringFormula();
  reconcileScoresToInventory();
  const seeded = ensurePermanentHolders();
  const weeks = listLeaderboardWeeks({ includePreseason: true });
  const rows = weeks
    .flatMap((ws) => ensureWeekScoreRows(ws, seeded.created > 0))
    .filter((r) => !ENV.leaderboardPermanentOnly || isPermanentHolderEmail(String(r.email)));
  const anchor = defaultLeaderboardWeek();
  const { profile, public: scoringProfile } = scoringProfilePublic(anchor);
  const earliest = [...weeks].sort((a, b) => a.localeCompare(b))[0] || anchor;
  const latest = weeks[0] || anchor;
  return {
    weekStart: earliest,
    weekEnd: weekEndUtcISO(latest),
    openWeekStart: biweekStartUtcISO(new Date()),
    availableWeeks: [] as string[],
    track: "overall" as const,
    period: "all-time" as const,
    scope: "all-time" as const,
    scoringProfile,
    freshness: getImportFreshness(),
    entries: mergeScoreRows(rows, profile.tieBreakers, "person"),
  };
}

function loadWeekScoreJoinRows(weekStart: string): Array<Record<string, unknown>> {
  const db = getDb();
  return db
    .prepare(
      `SELECT ws.*, p.name, p.photo_url AS photo_url
       FROM weekly_scores ws
       JOIN participants p ON lower(p.email) = lower(ws.email)
       WHERE ws.week_start = ?
       ORDER BY ws.rank ASC`,
    )
    .all(weekStart) as Array<Record<string, unknown>>;
}

function ensureWeekScoreRows(weekStart: string, forceRecompute: boolean): Array<Record<string, unknown>> {
  let rows = loadWeekScoreJoinRows(weekStart);
  if (!rows.length || forceRecompute) {
    recomputeWeekScores(weekStart);
    rows = loadWeekScoreJoinRows(weekStart);
  }
  return rows;
}

function mergeScoreRows(
  rows: Array<Record<string, unknown>>,
  tieBreakers: MetricKey[],
  groupBy: "camera" | "person",
) {
  type Agg = {
    email: string;
    name: string;
    photoUrl: string | null;
    cameraId: string | null;
    /** Every camera that contributed to this row — people move between checkout cameras. */
    cameraIds: Set<string>;
    total: number;
    raw: Record<MetricKey, number>;
    breakdownByKey: Map<string, ScoreMetricBreakdown>;
  };

  const byKey = new Map<string, Agg>();
  for (const r of rows) {
    const email = String(r.email);
    const cameraId = r.camera_id ? String(r.camera_id) : null;
    const groupKey =
      groupBy === "person" ? email.toLowerCase() : `${email.toLowerCase()}\0${cameraId || ""}`;
    const metrics = JSON.parse(String(r.metrics_json || "{}")) as {
      raw?: Partial<Record<MetricKey, number>>;
      breakdown?: ScoreMetricBreakdown[];
    };
    const existing = byKey.get(groupKey);
    const acc: Agg = existing ?? {
      email,
      name: String(r.name ?? "").trim() || emailHandle(email),
      photoUrl: r.photo_url ? String(r.photo_url) : null,
      cameraId: groupBy === "person" ? null : cameraId,
      cameraIds: new Set<string>(),
      total: 0,
      raw: emptyMetricRaw(),
      breakdownByKey: new Map(),
    };
    if (!existing) byKey.set(groupKey, acc);
    if (cameraId) acc.cameraIds.add(cameraId);
    acc.total += Number(r.total_points) || 0;
    const rawSource =
      metrics.raw && Object.keys(metrics.raw).length
        ? metrics.raw
        : Object.fromEntries((metrics.breakdown || []).map((b) => [b.metricKey, b.raw]));
    for (const metricKey of Object.keys(acc.raw) as MetricKey[]) {
      const add = Number(rawSource[metricKey] || 0);
      if (metricKey === "active_day_streak") {
        acc.raw[metricKey] = Math.max(acc.raw[metricKey], add);
      } else {
        acc.raw[metricKey] += add;
      }
    }
    for (const b of metrics.breakdown || []) {
      const prev = acc.breakdownByKey.get(b.metricKey);
      if (!prev) {
        acc.breakdownByKey.set(b.metricKey, { ...b });
        continue;
      }
      prev.raw =
        b.metricKey === "active_day_streak" ? Math.max(prev.raw, b.raw) : prev.raw + b.raw;
      prev.points += b.points;
    }
  }

  const scored = [...byKey.values()].map((a) => ({
    ...a,
    total: Math.round(a.total * 1000) / 1000,
  }));
  scored.sort((a, b) => compareScores(a, b, tieBreakers));
  return scored.map((a, idx) => ({
    rank: idx + 1,
    name: a.name,
    cameraId: a.cameraId,
    cameraIds: [...a.cameraIds].sort(),
    emailHash: emailHash(a.email),
    photoUrl: a.photoUrl,
    totalPoints: a.total,
    breakdown: [...a.breakdownByKey.values()]
      .sort((x, y) => x.displayOrder - y.displayOrder)
      .map((b) => ({
        ...b,
        raw: Math.round(b.raw * 1000) / 1000,
        points: Math.round(b.points * 1000) / 1000,
      })),
  }));
}

function listLeaderboardBiweeks(): string[] {
  const starts = new Set(listLeaderboardWeeks().map((ws) => biweekStartUtcISO(ws)));
  return [...starts].sort((a, b) => b.localeCompare(a));
}

function scoringProfilePublic(weekStart: string) {
  const profile = resolveProfileForWeek(weekStart);
  return {
    profile,
    public: {
      profileId: profile.profile.profileId,
      version: profile.profile.version,
      name: profile.profile.name,
      metrics: profile.rules
        .filter((r) => r.enabled)
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .map((r) => ({
          metricKey: r.metricKey,
          label: r.label,
          displayOrder: r.displayOrder,
        })),
    },
  };
}

export function getLeaderboard(weekStart?: string, track?: LeaderboardTrack) {
  const effectiveTrack =
    ENV.leaderboardPermanentOnly && track === "checkout" ? "permanent" : track;
  if (effectiveTrack === "overall") {
    return getOverallLeaderboard();
  }

  ensureScoringFormula();
  reconcileScoresToInventory();
  const seeded = ensurePermanentHolders();
  const freshness = getImportFreshness();

  if (effectiveTrack === "checkout" || effectiveTrack === "permanent") {
    const trackOverrides = loadTrackOverrideMap();
    const biweekStart = biweekStartUtcISO(weekStart || defaultLeaderboardWeek());
    // The competition boards are what "resets" at kickoff, and they do it by ignoring preseason
    // weeks rather than by having them deleted. The first period straddles the season start, so
    // without this its board would still be carrying preseason points.
    const floor = competitionWeekFloorUtc();
    const periodWeeks = weeksInBiweek(biweekStart).filter(
      (w) => !floor || Date.parse(w) >= Date.parse(floor),
    );
    const rows = periodWeeks
      .flatMap((w) => ensureWeekScoreRows(w, seeded.created > 0))
      .filter(
        (r) =>
          resolveRowTrack(
            String(r.email),
            r.camera_id ? String(r.camera_id) : null,
            trackOverrides,
          ) === effectiveTrack,
      );
    // weeksInBiweek starts at the period start, so this is the period's own profile either way.
    const { profile, public: scoringProfile } = scoringProfilePublic(biweekStart);
    return {
      weekStart: biweekStart,
      weekEnd: biweekEndUtcISO(biweekStart),
      openWeekStart: biweekStartUtcISO(new Date()),
      availableWeeks: listLeaderboardBiweeks(),
      track: effectiveTrack,
      period: "biweekly" as const,
      scoringProfile,
      freshness,
      // Checkout is one row per person: people rotate through pool cameras, so their standing is
      // the sum of everything they recorded in the period. Permanent stays one row per camera —
      // those holders keep a single assigned FieldCam, and the board is read per device.
      entries: mergeScoreRows(
        rows,
        profile.tieBreakers,
        effectiveTrack === "checkout" ? "person" : "camera",
      ),
    };
  }

  const availableWeeks = listLeaderboardWeeks();
  const ws = weekStart || defaultLeaderboardWeek();
  const rows = ensureWeekScoreRows(ws, seeded.created > 0);
  const { public: scoringProfile } = scoringProfilePublic(ws);

  const entries = rows.map((r, idx) => {
    const metrics = JSON.parse(String(r.metrics_json || "{}")) as {
      breakdown?: ScoreMetricBreakdown[];
    };
    const email = String(r.email);
    const cameraId = r.camera_id ? String(r.camera_id) : null;
    return {
      rank: idx + 1,
      name: (r.name && String(r.name).trim()) || emailHandle(email),
      cameraId,
      cameraIds: cameraId ? [cameraId] : [],
      emailHash: emailHash(email),
      photoUrl: r.photo_url ? String(r.photo_url) : null,
      totalPoints: Number(r.total_points),
      breakdown: metrics.breakdown || [],
    };
  });

  return {
    weekStart: ws,
    weekEnd: weekEndUtcISO(ws),
    openWeekStart: biweekStartUtcISO(new Date()),
    availableWeeks,
    track: track ?? "all",
    period: "weekly" as const,
    scoringProfile,
    freshness,
    entries,
  };
}

export function getImportFreshness() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT export_time_utc, committed_at, batch_id, status
       FROM import_batches
       WHERE status = 'committed'
       ORDER BY committed_at DESC
       LIMIT 1`,
    )
    .get() as
    | {
        export_time_utc: string;
        committed_at: string;
        batch_id: string;
        status: string;
      }
    | undefined;

  if (!row) {
    return {
      hasImport: false,
      exportTimeUtc: null as string | null,
      committedAt: null as string | null,
      ageHours: null as number | null,
      staleForReminders: true,
      batchId: null as string | null,
    };
  }

  const ageHours =
    (Date.now() - new Date(row.export_time_utc || row.committed_at).getTime()) /
    (1000 * 60 * 60);

  return {
    hasImport: true,
    exportTimeUtc: row.export_time_utc,
    committedAt: row.committed_at,
    ageHours: Math.round(ageHours * 100) / 100,
    staleForReminders: ageHours > 24,
    batchId: row.batch_id,
  };
}

/** Minimum duration for a recording to count toward scoring/stats (matches `isValidRecording`). */
const OVERALL_STATS_MIN_SECONDS = 30;
const RATE_TREND_MIN_PP = 0.5;

/**
 * Windows the Stats page can be read over.
 *
 * Rolling durations anchored to the last snapshot, not calendar weeks — "last 7 days" from a
 * 09:00 Phoenix dump is the seven days ending at that dump, which is what the trend chips compare.
 * `hours: null` is all-time: no lower bound, and no prior window to compare against.
 */
export const STATS_WINDOWS = [
  // `short` is for compact labels ("Success rates (last 24h)"); `phrase` is the article-inclusive
  // mid-sentence form ("failures over the last 24 hours"). All-time needs both to differ.
  {
    key: "24h",
    hours: 24,
    label: "Last 24 hours",
    short: "last 24h",
    phrase: "the last 24 hours",
    prior: "prior 24h",
  },
  {
    key: "7d",
    hours: 24 * 7,
    label: "Last 7 days",
    short: "last 7 days",
    phrase: "the last 7 days",
    prior: "prior 7 days",
  },
  {
    key: "14d",
    hours: 24 * 14,
    label: "Last 14 days",
    short: "last 14 days",
    phrase: "the last 14 days",
    prior: "prior 14 days",
  },
  {
    key: "all",
    hours: null,
    label: "All time",
    short: "all time",
    phrase: "the whole program",
    prior: null,
  },
] as const;

export type StatsWindowKey = (typeof STATS_WINDOWS)[number]["key"];

export const DEFAULT_STATS_WINDOW: StatsWindowKey = "24h";

/** Unrecognised or absent `window=` falls back to 24h rather than erroring the whole page. */
export function parseStatsWindow(raw: unknown): StatsWindowKey {
  const found = STATS_WINDOWS.find((w) => w.key === raw);
  return found ? found.key : DEFAULT_STATS_WINDOW;
}

export type TimeBounds = { sinceUtc: string; untilUtc: string };
export type TrendDirection = "up" | "down" | "flat" | "unknown";
export type TrendTone = "better" | "worse" | "neutral";

export interface StatTrend {
  last: number | null;
  prior: number | null;
  delta: number | null;
  direction: TrendDirection;
  tone: TrendTone;
}

export interface VolumeStats {
  totalRecordings: number;
  recordingsOverThreshold: number;
  minThresholdSeconds: number;
  recordingsUnderThreshold: number;
  totalDurationSeconds: number;
  totalDurationHours: number;
  avgDurationSeconds: number;
  distinctParticipants: number;
  distinctCameras: number;
  totalUploads: number;
  totalLivestreams: number;
  totalReports: number;
}

export const VOLUME_TREND_KEYS = [
  "totalRecordings",
  "recordingsOverThreshold",
  "avgDurationSeconds",
  "totalDurationHours",
  "distinctParticipants",
  "distinctCameras",
  "totalUploads",
  "totalLivestreams",
  "totalReports",
] as const;

export type VolumeTrendKey = (typeof VOLUME_TREND_KEYS)[number];

function isoBounds(asOf: Date, hoursAgo: number, hoursAgoEnd: number): TimeBounds {
  const until = new Date(asOf.getTime() - hoursAgoEnd * 3600_000);
  const since = new Date(asOf.getTime() - hoursAgo * 3600_000);
  return { sinceUtc: since.toISOString(), untilUtc: until.toISOString() };
}

/** End of the "current" 24h slice: Splunk snapshot export time, else Harbor commit time, else now. */
export function statsWindowAsOf(now: Date = new Date()): Date {
  const freshness = getImportFreshness();
  const raw = freshness.exportTimeUtc || freshness.committedAt;
  if (!raw) return now;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? now : d;
}

/**
 * The selected window is [asOf-hours, asOf] (asOf inclusive); prior is the same span before it.
 * asOf+1ms is the exclusive SQL end so an event at the snapshot time still counts.
 *
 * All-time (`hours: null`) has no bounds at all, and so no prior window — `undefined` bounds mean
 * "every row" everywhere downstream, and a missing prior makes every trend read "unknown".
 */
function windowsFromAsOf(
  asOf: Date,
  hours: number | null,
): { current?: TimeBounds; previous?: TimeBounds } {
  if (hours == null) return {};
  const current = isoBounds(asOf, hours, 0);
  current.untilUtc = new Date(asOf.getTime() + 1).toISOString();
  const previous = isoBounds(asOf, hours * 2, hours);
  return { current, previous };
}

function activityTimeSql(bounds?: TimeBounds): { sql: string; params: string[] } {
  if (!bounds) return { sql: "", params: [] };
  return { sql: " AND event_time_utc >= ? AND event_time_utc < ?", params: [bounds.sinceUtc, bounds.untilUtc] };
}

/**
 * No comparison is possible — the all-time window has nothing before it. Distinct from a zeroed
 * prior window, which would read every all-time figure as an improvement over nothing.
 */
export function noTrend(last: number | null): StatTrend {
  return { last, prior: null, delta: null, direction: "unknown", tone: "neutral" };
}

/**
 * Volume: more vs the prior window is better (program usage). Both-zero is not a trend.
 */
export function volumeTrend(last: number, prior: number): StatTrend {
  if (last === 0 && prior === 0) {
    return { last, prior, delta: 0, direction: "unknown", tone: "neutral" };
  }
  const delta = Math.round((last - prior) * 100) / 100;
  const direction: TrendDirection = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const tone: TrendTone = delta > 0 ? "better" : delta < 0 ? "worse" : "neutral";
  return { last, prior, delta, direction, tone };
}

/**
 * Reliability: higher success rate is better. No sample in either window is unknown.
 * Differences under 0.5pp are treated as flat so a thin sample does not flash red/green.
 */
export function rateTrend(lastRate: number | null, priorRate: number | null): StatTrend {
  if (lastRate === null || priorRate === null) {
    return { last: lastRate, prior: priorRate, delta: null, direction: "unknown", tone: "neutral" };
  }
  const delta = Math.round((lastRate - priorRate) * 100) / 100;
  if (Math.abs(delta) < RATE_TREND_MIN_PP) {
    return { last: lastRate, prior: priorRate, delta, direction: "flat", tone: "neutral" };
  }
  const direction: TrendDirection = delta > 0 ? "up" : "down";
  const tone: TrendTone = delta > 0 ? "better" : "worse";
  return { last: lastRate, prior: priorRate, delta, direction, tone };
}

function queryVolumeStats(bounds?: TimeBounds): VolumeStats {
  const db = getDb();
  const recTime = activityTimeSql(bounds);
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS totalRecordings,
         SUM(CASE WHEN duration_seconds >= ? THEN 1 ELSE 0 END) AS recordingsOverThreshold,
         COALESCE(SUM(duration_seconds), 0) AS totalDurationSeconds,
         COALESCE(AVG(duration_seconds), 0) AS avgDurationSeconds,
         COUNT(DISTINCT email) AS distinctParticipants,
         COUNT(DISTINCT camera_id) AS distinctCameras
       FROM activity_events
       WHERE event_type = 'recording'
         AND UPPER(COALESCE(purpose, '')) = 'PURPOSE_STANDARD'
         AND LOWER(COALESCE(status, '')) = 'success'${recTime.sql}`,
    )
    .get(OVERALL_STATS_MIN_SECONDS, ...recTime.params) as {
    totalRecordings: number;
    recordingsOverThreshold: number | null;
    totalDurationSeconds: number;
    avgDurationSeconds: number;
    distinctParticipants: number;
    distinctCameras: number;
  };

  const upTime = activityTimeSql(bounds);
  const totals = db
    .prepare(
      `SELECT
         SUM(CASE WHEN event_type = 'upload' THEN 1 ELSE 0 END) AS totalUploads,
         SUM(CASE WHEN event_type = 'livestream' THEN 1 ELSE 0 END) AS totalLivestreams
       FROM activity_events
       WHERE LOWER(COALESCE(status, '')) = 'success'${upTime.sql}`,
    )
    .get(...upTime.params) as { totalUploads: number | null; totalLivestreams: number | null };

  const reportsSql = bounds
    ? `SELECT COUNT(*) AS totalReports FROM reports
       WHERE status = 'approved' AND reported_at_utc >= ? AND reported_at_utc < ?`
    : `SELECT COUNT(*) AS totalReports FROM reports WHERE status = 'approved'`;
  const reportsRow = db.prepare(reportsSql).get(...(bounds ? [bounds.sinceUtc, bounds.untilUtc] : [])) as {
    totalReports: number | null;
  };

  const totalRecordings = Number(row.totalRecordings || 0);
  const recordingsOverThreshold = Number(row.recordingsOverThreshold || 0);
  const totalDurationSeconds = Number(row.totalDurationSeconds || 0);

  return {
    totalRecordings,
    recordingsOverThreshold,
    minThresholdSeconds: OVERALL_STATS_MIN_SECONDS,
    recordingsUnderThreshold: totalRecordings - recordingsOverThreshold,
    totalDurationSeconds,
    totalDurationHours: Math.round((totalDurationSeconds / 3600) * 100) / 100,
    avgDurationSeconds: Math.round(Number(row.avgDurationSeconds || 0) * 100) / 100,
    distinctParticipants: Number(row.distinctParticipants || 0),
    distinctCameras: Number(row.distinctCameras || 0),
    totalUploads: Number(totals.totalUploads || 0),
    totalLivestreams: Number(totals.totalLivestreams || 0),
    totalReports: Number(reportsRow.totalReports || 0),
  };
}

function windowHasAnyActivity(bounds?: TimeBounds): boolean {
  const db = getDb();
  const time = activityTimeSql(bounds);
  const events = db
    .prepare(`SELECT COUNT(*) AS c FROM activity_events WHERE 1 = 1${time.sql}`)
    .get(...time.params) as { c: number };
  const reports = db
    .prepare(
      `SELECT COUNT(*) AS c FROM reports WHERE status = 'approved'${
        bounds ? " AND reported_at_utc >= ? AND reported_at_utc < ?" : ""
      }`,
    )
    .get(...(bounds ? [bounds.sinceUtc, bounds.untilUtc] : [])) as { c: number };
  return Number(events.c || 0) + Number(reports.c || 0) > 0;
}

/** Earliest activity timestamp, for labelling the all-time window with a real start date. */
function earliestActivityUtc(): string | null {
  const row = getDb()
    .prepare(`SELECT MIN(event_time_utc) AS t FROM activity_events`)
    .get() as { t: string | null };
  return row?.t ?? null;
}

/**
 * All-time recording totals across every participant/camera.
 *
 * Counts completed qualifying recordings only. Splunk logs each recording twice: a zero-duration
 * `started` row and a `success` row on completion, so counting raw rows doubled every total and
 * halved the average length by averaging the zeros in. Scoping every figure to the same base keeps
 * `recordingsUnderThreshold` an honest complement of `recordingsOverThreshold`, and makes these
 * totals reconcile with the leaderboard's own recording columns.
 */
export function getOverallStats(): VolumeStats {
  return queryVolumeStats();
}

export interface ReliabilityMetric {
  key: string;
  label: string;
  successes: number;
  failures: number;
  total: number;
  /** Percent, or null when nothing has been observed yet. */
  rate: number | null;
  /** Wilson 95% bounds, in percent. Null when total is 0. */
  ci95Lower: number | null;
  ci95Upper: number | null;
  /** Present on last-24h metrics: rate vs the prior 24h. */
  trend?: StatTrend;
}

/**
 * Wilson score interval — the standard interval for a proportion, and the one that behaves at the
 * edges. A normal approximation gives 100% +/- 0 for "33 of 33 succeeded", claiming a certainty a
 * sample that size cannot support; Wilson reports 89.6-100 instead.
 */
function wilson95(successes: number, total: number): [number, number] | null {
  if (total <= 0) return null;
  const z = 1.959964;
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [
    Math.round(Math.max(0, (centre - spread) / d) * 1000) / 10,
    Math.round(Math.min(1, (centre + spread) / d) * 1000) / 10,
  ];
}

/**
 * Success rates for the operations the Splunk export reports an outcome for.
 *
 * Recordings and uploads plus the Maintain scorecard events the daily Splunk pull now exports
 * (locationTime, availability, battery). Raise-the-bar metrics stay off until Q2 logging exists.
 */
export function getReliabilityMetrics(bounds?: TimeBounds): ReliabilityMetric[] {
  const db = getDb();
  const time = activityTimeSql(bounds);
  const build = (
    key: string,
    label: string,
    eventType: string,
    opts?: { weightByDuration?: boolean; rateDecimals?: number },
  ): ReliabilityMetric => {
    const weight = opts?.weightByDuration
      ? "COALESCE(duration_seconds, 1)"
      : "1";
    const r = db
      .prepare(
        `SELECT
           SUM(CASE WHEN LOWER(COALESCE(status,'')) = 'success' THEN ${weight} ELSE 0 END) AS ok,
           SUM(CASE WHEN LOWER(COALESCE(status,'')) = 'failed'  THEN ${weight} ELSE 0 END) AS bad
         FROM activity_events WHERE event_type = ?${time.sql}`,
      )
      .get(eventType, ...time.params) as { ok: number | null; bad: number | null };
    const successes = Number(r.ok || 0);
    const failures = Number(r.bad || 0);
    const total = successes + failures;
    const decimals = opts?.rateDecimals ?? 1;
    const scale = 10 ** decimals;
    const ci = wilson95(successes, total);
    return {
      key,
      label,
      successes,
      failures,
      total,
      rate: total > 0 ? Math.round((successes / total) * 100 * scale) / scale : null,
      ci95Lower: ci ? ci[0] : null,
      ci95Upper: ci ? ci[1] : null,
    };
  };
  return [
    build("recording", "Recording success", "recording"),
    build("upload", "Fleet upload success", "upload"),
    build("locationTime", "Location & time accuracy in Fleet", "locationtime"),
    build("availability", "Camera availability & stability", "availability", {
      weightByDuration: true,
      rateDecimals: 2,
    }),
    build("battery", "Shifts without a low-battery alert", "battery"),
    build("registration", "Registration success", "registration"),
    build("connectivity", "Connection success on LTE and WiFi", "connectivity"),
    build("videoQuality", "Video quality (frame drop, A/V sync)", "videoquality"),
  ];
}

export interface WindowedStats extends VolumeStats {
  empty: boolean;
  reliability: ReliabilityMetric[];
}

export interface StatsWindowInfo {
  key: StatsWindowKey;
  label: string;
  /** Compact form for labels and headings, e.g. "last 7 days". */
  short: string;
  /** Article-inclusive form for mid-sentence use, e.g. "the last 7 days". */
  phrase: string;
  /** Inline form for the comparison window, e.g. "prior 7 days". Null for all-time. */
  prior: string | null;
  /** Span in hours. Null for all-time, which has no lower bound. */
  hours: number | null;
  /** Start of the window. For all-time, the earliest activity on record, or null if there is none. */
  sinceUtc: string | null;
  untilUtc: string;
  asOfUtc: string;
}

export interface StatsDashboard {
  totalRecordings: number;
  recordingsOverThreshold: number;
  minThresholdSeconds: number;
  recordingsUnderThreshold: number;
  totalDurationSeconds: number;
  totalDurationHours: number;
  avgDurationSeconds: number;
  distinctParticipants: number;
  distinctCameras: number;
  totalUploads: number;
  totalLivestreams: number;
  totalReports: number;
  reliability: ReliabilityMetric[];
  deviceFailures: DeviceFailureRow[];
  uploadTransports: TransportRow[];
  runtime: RuntimeEstimate;
  window: StatsWindowInfo;
  freshness: ReturnType<typeof getImportFreshness>;
  /** The selected window. Equals the all-time figures when the window is all-time. */
  current: WindowedStats;
  /** The equal-length span before it, or null when the window is all-time. */
  previous: WindowedStats | null;
  volumeTrends: Record<VolumeTrendKey, StatTrend>;
}

function withReliabilityTrend(
  last: ReliabilityMetric[],
  prior: ReliabilityMetric[],
): ReliabilityMetric[] {
  const priorByKey = new Map(prior.map((m) => [m.key, m]));
  return last.map((m) => {
    const p = priorByKey.get(m.key);
    const lastRate = m.total > 0 ? m.rate : null;
    const priorRate = p && p.total > 0 ? p.rate : null;
    return { ...m, trend: rateTrend(lastRate, priorRate) };
  });
}

/**
 * Payload for GET /api/stats: all-time program figures, plus one selected window and its trends.
 *
 * Windows are anchored to the last Splunk snapshot (export time), not wall-clock now, so a
 * 09:00 Phoenix dump still reads as "current" at noon.
 *
 * All-time is a window like any other, with two consequences worth stating: `current` then equals
 * the all-time figures, and there is no earlier span to compare against, so every trend is
 * "unknown" rather than being computed against a zeroed prior window (which would report the whole
 * program as an improvement).
 */
export function getStatsDashboard(
  now: Date = new Date(),
  windowKey: StatsWindowKey = DEFAULT_STATS_WINDOW,
): StatsDashboard {
  const spec = STATS_WINDOWS.find((w) => w.key === windowKey) ?? STATS_WINDOWS[0];
  const asOf = statsWindowAsOf(now);
  const { current: currentBounds, previous: previousBounds } = windowsFromAsOf(asOf, spec.hours);
  // The "failed in 24h" column on the camera table keeps its own 24h anchor at every window.
  const recentBounds = windowsFromAsOf(asOf, 24).current;

  const allTime = queryVolumeStats();
  const currentVolume = currentBounds ? queryVolumeStats(currentBounds) : allTime;
  const previousVolume = previousBounds ? queryVolumeStats(previousBounds) : null;
  const currentRel = getReliabilityMetrics(currentBounds);
  const previousRel = previousBounds ? getReliabilityMetrics(previousBounds) : null;

  const volumeTrends = Object.fromEntries(
    VOLUME_TREND_KEYS.map((key) => [
      key,
      previousVolume
        ? volumeTrend(currentVolume[key], previousVolume[key])
        : noTrend(currentVolume[key]),
    ]),
  ) as Record<VolumeTrendKey, StatTrend>;

  return {
    ...allTime,
    reliability: getReliabilityMetrics(),
    deviceFailures: getDeviceFailures(1, { window: currentBounds, recent: recentBounds }),
    uploadTransports: getUploadTransports(currentBounds),
    runtime: getRuntimeEstimate(currentBounds),
    window: {
      key: spec.key,
      label: spec.label,
      short: spec.short,
      phrase: spec.phrase,
      prior: spec.prior,
      hours: spec.hours,
      sinceUtc: currentBounds ? currentBounds.sinceUtc : earliestActivityUtc(),
      untilUtc: asOf.toISOString(),
      asOfUtc: asOf.toISOString(),
    },
    freshness: getImportFreshness(),
    current: {
      ...currentVolume,
      empty: !windowHasAnyActivity(currentBounds),
      reliability: previousRel
        ? withReliabilityTrend(currentRel, previousRel)
        : currentRel.map((m) => ({ ...m, trend: rateTrend(null, null) })),
    },
    previous:
      previousBounds && previousVolume
        ? {
            ...previousVolume,
            empty: !windowHasAnyActivity(previousBounds),
            reliability: previousRel ?? [],
          }
        : null,
    volumeTrends,
  };
}

export interface TransportRow {
  transport: string;
  label: string;
  successes: number;
  failures: number;
  total: number;
  rate: number | null;
  ci95Lower: number | null;
  ci95Upper: number | null;
}

/** `TRANSPORT_WIFI` -> `Trusted WiFi`. Unmapped values pass through readably. */
function transportLabel(raw: string): string {
  const t = raw.replace(/^NET_TRANSPORT_/, "").toLowerCase();
  if (!t) return "Unknown";
  const words = t.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ").replace(/\bWifi\b/, "WiFi");
}

/**
 * Upload success split by the network path the upload took.
 *
 * A single blended upload rate averages two paths that behave differently — dock uploads succeed
 * noticeably more often than uploads over trusted WiFi — so the blended figure hides which one is
 * actually failing.
 *
 * Rows imported before `upload_transport` existed group as "Unknown" rather than being dropped;
 * silently excluding them would make the split look more complete than it is.
 */
export function getUploadTransports(bounds?: TimeBounds): TransportRow[] {
  const time = activityTimeSql(bounds);
  const rows = getDb()
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(upload_transport), ''), '') AS transport,
         SUM(CASE WHEN LOWER(COALESCE(status,'')) = 'success' THEN 1 ELSE 0 END) AS successes,
         SUM(CASE WHEN LOWER(COALESCE(status,'')) = 'failed'  THEN 1 ELSE 0 END) AS failures
       FROM activity_events
       WHERE event_type = 'upload' AND LOWER(COALESCE(status,'')) IN ('success','failed')${time.sql}
       GROUP BY 1`,
    )
    .all(...time.params) as Array<{ transport: string; successes: number; failures: number }>;

  return rows
    .map((r) => {
      const successes = Number(r.successes || 0);
      const failures = Number(r.failures || 0);
      const total = successes + failures;
      const ci = wilson95(successes, total);
      return {
        transport: r.transport,
        label: transportLabel(r.transport),
        successes,
        failures,
        total,
        rate: total > 0 ? Math.round((successes / total) * 1000) / 10 : null,
        ci95Lower: ci ? ci[0] : null,
        ci95Upper: ci ? ci[1] : null,
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
}

export interface DeviceFailureRow {
  cameraId: string;
  /** Who currently holds it, so an operator knows who to contact. Null if unassigned. */
  holderName: string | null;
  holderEmail: string | null;
  uploadFailures: number;
  uploadTotal: number;
  recordingFailures: number;
  recordingTotal: number;
  /** Upload success rate, percent. Null when the camera has no uploads at all. */
  uploadRate: number | null;
  ci95Lower: number | null;
  ci95Upper: number | null;
  uploadFailuresLast24h: number;
  recordingFailuresLast24h: number;
}

/**
 * Per-camera failure counts, for spotting a bad unit.
 *
 * Cameras, not people: a device that cannot finish an upload is a hardware or connectivity fault,
 * and attributing it to whoever happens to hold it invites the wrong conclusion.
 *
 * Ranked by failure count because that is the question being asked, but the rate and its interval
 * travel with every row. Rate alone would put a camera with four failures in thirteen uploads at
 * the top of the list on evidence too thin to act on.
 *
 * Two scopes, deliberately: `window` bounds the totals and rates (the page's selected window), and
 * `recent` bounds the separate "failed in 24h" count. Keeping the recency count on its own 24h
 * anchor is what makes a wider window readable — "nine failures over fourteen days, two of them
 * yesterday" says something the fourteen-day total alone does not.
 */
export function getDeviceFailures(
  minFailures = 1,
  opts?: { window?: TimeBounds; recent?: TimeBounds },
): DeviceFailureRow[] {
  const recent = opts?.recent;
  const time = activityTimeSql(opts?.window);
  const recentFailSql = recent
    ? `SUM(CASE WHEN event_type = 'upload' AND LOWER(COALESCE(status,'')) = 'failed' AND event_time_utc >= ? AND event_time_utc < ? THEN 1 ELSE 0 END) AS uploadFailuresLast24h,
         SUM(CASE WHEN event_type = 'recording' AND LOWER(COALESCE(status,'')) = 'failed' AND event_time_utc >= ? AND event_time_utc < ? THEN 1 ELSE 0 END) AS recordingFailuresLast24h`
    : `0 AS uploadFailuresLast24h, 0 AS recordingFailuresLast24h`;
  const recentParams = recent
    ? [recent.sinceUtc, recent.untilUtc, recent.sinceUtc, recent.untilUtc]
    : [];
  const rows = getDb()
    .prepare(
      `SELECT camera_id AS cameraId,
         SUM(CASE WHEN event_type = 'upload' AND LOWER(COALESCE(status,'')) = 'failed' THEN 1 ELSE 0 END) AS uploadFailures,
         SUM(CASE WHEN event_type = 'upload' AND LOWER(COALESCE(status,'')) IN ('success','failed') THEN 1 ELSE 0 END) AS uploadTotal,
         SUM(CASE WHEN event_type = 'recording' AND LOWER(COALESCE(status,'')) = 'failed' THEN 1 ELSE 0 END) AS recordingFailures,
         SUM(CASE WHEN event_type = 'recording' AND LOWER(COALESCE(status,'')) IN ('success','failed') THEN 1 ELSE 0 END) AS recordingTotal,
         ${recentFailSql}
       FROM activity_events WHERE camera_id IS NOT NULL AND camera_id != ''${time.sql}
       GROUP BY camera_id`,
    )
    .all(...recentParams, ...time.params) as Array<
    Omit<
      DeviceFailureRow,
      "uploadRate" | "ci95Lower" | "ci95Upper" | "holderName" | "holderEmail"
    >
  >;

  // Current holder per camera. The table is still about the device — a failed upload is a hardware
  // or connectivity fault — but naming the holder is what makes it actionable, because someone has
  // to go and look at the camera.
  const holders = new Map<string, { name: string | null; email: string }>();
  for (const h of getDb()
    .prepare(
      `SELECT a.camera_id AS cameraId, a.email AS email, p.name AS name
       FROM assignment_history a
       LEFT JOIN participants p ON lower(p.email) = lower(a.email)
       WHERE a.source IN ('fleet') AND a.unassigned_at_utc IS NULL`,
    )
    .all() as Array<{ cameraId: string; email: string; name: string | null }>) {
    holders.set(h.cameraId, { name: h.name, email: h.email });
  }

  return rows
    .map((r) => {
      const ok = r.uploadTotal - r.uploadFailures;
      const ci = wilson95(ok, r.uploadTotal);
      const holder = holders.get(r.cameraId);
      return {
        ...r,
        uploadFailures: Number(r.uploadFailures || 0),
        uploadTotal: Number(r.uploadTotal || 0),
        recordingFailures: Number(r.recordingFailures || 0),
        recordingTotal: Number(r.recordingTotal || 0),
        uploadFailuresLast24h: Number(r.uploadFailuresLast24h || 0),
        recordingFailuresLast24h: Number(r.recordingFailuresLast24h || 0),
        holderName: (holder?.name || "").trim() || holder?.email || null,
        holderEmail: holder?.email ?? null,
        uploadRate: r.uploadTotal > 0 ? Math.round((ok / r.uploadTotal) * 1000) / 10 : null,
        ci95Lower: ci ? ci[0] : null,
        ci95Upper: ci ? ci[1] : null,
      };
    })
    .filter((r) => r.uploadFailures + r.recordingFailures >= minFailures)
    .sort(
      (a, b) =>
        b.uploadFailures + b.recordingFailures - (a.uploadFailures + a.recordingFailures) ||
        (a.uploadRate ?? 100) - (b.uploadRate ?? 100),
    );
}

export interface WeeklyStatsRow {
  weekStart: string;
  recordings: number;
  recordingHours: number;
  participants: number;
  uploads: number;
  reports: number;
}

/**
 * The same measures as `getOverallStats`, bucketed by competition week.
 *
 * Filters match the all-time query exactly so a reader can add the weekly bars up and land on the
 * headline tile: recordings need the evidence purpose and a success status, uploads only a success
 * status. Weeks with no activity at all are omitted rather than zero-filled — the caller decides
 * whether an absent week means "nobody recorded" or "no import has covered it yet", and those are
 * very different claims.
 */
export function getWeeklyStats(): WeeklyStatsRow[] {
  const db = getDb();
  const activity = db
    .prepare(
      `SELECT
         week_start AS weekStart,
         SUM(CASE WHEN event_type = 'recording'
                   AND UPPER(COALESCE(purpose, '')) = 'PURPOSE_STANDARD'
                   AND LOWER(COALESCE(status, '')) = 'success'
              THEN 1 ELSE 0 END) AS recordings,
         COALESCE(SUM(CASE WHEN event_type = 'recording'
                   AND UPPER(COALESCE(purpose, '')) = 'PURPOSE_STANDARD'
                   AND LOWER(COALESCE(status, '')) = 'success'
              THEN duration_seconds ELSE 0 END), 0) AS durationSeconds,
         COUNT(DISTINCT CASE WHEN event_type = 'recording'
                   AND UPPER(COALESCE(purpose, '')) = 'PURPOSE_STANDARD'
                   AND LOWER(COALESCE(status, '')) = 'success'
              THEN email END) AS participants,
         SUM(CASE WHEN event_type = 'upload' AND LOWER(COALESCE(status, '')) = 'success'
              THEN 1 ELSE 0 END) AS uploads
       FROM activity_events
       WHERE week_start IS NOT NULL
       GROUP BY week_start`,
    )
    .all() as Array<{
    weekStart: string;
    recordings: number | null;
    durationSeconds: number | null;
    participants: number | null;
    uploads: number | null;
  }>;

  const reports = db
    .prepare(
      `SELECT week_start AS weekStart, COUNT(*) AS reports
       FROM reports WHERE status = 'approved' AND week_start IS NOT NULL
       GROUP BY week_start`,
    )
    .all() as Array<{ weekStart: string; reports: number }>;

  const byWeek = new Map<string, WeeklyStatsRow>();
  for (const r of activity) {
    byWeek.set(r.weekStart, {
      weekStart: r.weekStart,
      recordings: Number(r.recordings || 0),
      recordingHours: Math.round((Number(r.durationSeconds || 0) / 3600) * 100) / 100,
      participants: Number(r.participants || 0),
      uploads: Number(r.uploads || 0),
      reports: 0,
    });
  }
  // A week can hold reports without any telemetry, so reports may introduce a week of their own.
  for (const r of reports) {
    const row = byWeek.get(r.weekStart);
    if (row) row.reports = Number(r.reports || 0);
    else
      byWeek.set(r.weekStart, {
        weekStart: r.weekStart,
        recordings: 0,
        recordingHours: 0,
        participants: 0,
        uploads: 0,
        reports: Number(r.reports || 0),
      });
  }

  return [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/* ── Runtime estimate ────────────────────────────────────────────────────────
 *
 * Scoped to recording and buffering only; livestreaming is deliberately out (see below).
 *
 * Method is the sample shift estimate, reduced to that scope. A battery's energy is spent on
 * a fixed block of recording, and whatever is left is spent buffering:
 *
 *   shiftHours = recordingHours + (capacity_mWh - recordingHours * P_recording) / P_buffering
 *
 * No full-discharge test is needed — median power per DVR state extrapolates it. Livestreaming is
 * excluded deliberately: the run book substitutes a 2038 mW constant when livestream data is
 * missing, and FieldCam emits no livestream telemetry at all, so including it would make an eighth of
 * the answer a hardcoded guess.
 *
 * Median, not mean: power samples are right-skewed (a thermal event or a stuck upload produces a
 * few very large values), and the run book specifies median for the same reason.
 */
export interface PowerState {
  key: "buffering" | "recording" | "livestreaming";
  label: string;
  /** Median AvgPower in mW, or null when no samples have arrived. */
  medianMw: number | null;
  samples: number;
}

export interface RuntimeEstimate {
  states: PowerState[];
  /** Estimated hours a fresh battery lasts under the sample shift profile. Null until both medians exist. */
  shiftHours: number | null;
  /** Spread implied by the interquartile range of the two inputs — the honest width of the answer. */
  shiftHoursLow: number | null;
  shiftHoursHigh: number | null;
  targetHours: number;
  batteryMah: number;
  nominalVolts: number;
  recordingHours: number;
  /** True once both buffering and recording have at least one sample. */
  computable: boolean;
  /** Samples dropped for not being on the sample shift profile, and which configs they were on. */
  offProfileSamples: number;
  offProfileConfigs: string[];
  /**
   * On-profile samples across all time, regardless of the selected window.
   *
   * A 15-camera fleet produces few power samples, so a 24h window will often be empty. Without
   * this the UI cannot tell "no power data has ever arrived" from "none in the last day", and the
   * first reads as the feature being broken.
   */
  allTimeSamples: number;
}

const STATE_TO_KEY: Record<string, PowerState["key"]> = {
  STATE_BUFFERING: "buffering",
  STATE_RECORDING: "recording",
  STATE_LIVESTREAMING: "livestreaming",
};

/** A power sample: an average over a span, which is why the span has to travel with it. */
interface PowerSample {
  mw: number;
  seconds: number;
}

/**
 * Duration-weighted quantile.
 *
 * `AvgPower` is already an average over `SecondsInOldState`, so combining samples is averaging
 * averages — and that is only correct weighted by the spans they cover. An unweighted median
 * treats a 15-second sliver and a four-hour stretch as equal evidence, and they are not.
 *
 * This is not a nicety. Real data shows a strong monotonic bias: buffering reads 1626 mW median
 * over 10-60s states against 1302 mW over states longer than 15 minutes, because short states sit
 * next to transitions and carry their overhead. Unweighted, the slivers dominate by count and
 * inflate the result.
 */
function weightedQuantile(samples: PowerSample[], q: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a.mw - b.mw);
  const total = sorted.reduce((n, s) => n + Math.max(s.seconds, 0), 0);
  // No usable weights (all zero/absent) — fall back to treating them equally rather than failing.
  if (total <= 0) {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? sorted[lo].mw : sorted[lo].mw + (sorted[hi].mw - sorted[lo].mw) * (pos - lo);
  }
  const target = total * q;
  let seen = 0;
  for (const s of sorted) {
    seen += Math.max(s.seconds, 0);
    if (seen >= target) return s.mw;
  }
  return sorted[sorted.length - 1].mw;
}

/** Exported for testing: the run book formula, isolated from sampling and filtering. */
export function shiftHoursFromPower(recordingMw: number, bufferingMw: number): number | null {
  if (!(bufferingMw > 0)) return null;
  const capacityMwh = FIELDCAM_BATTERY_MAH * FIELDCAM_NOMINAL_VOLTS;
  const spentRecording = FIELDCAM_RECORDING_HOURS * recordingMw;
  const remaining = capacityMwh - spentRecording;
  if (remaining <= 0) return FIELDCAM_RECORDING_HOURS;
  return FIELDCAM_RECORDING_HOURS + remaining / bufferingMw;
}

export function getRuntimeEstimate(bounds?: TimeBounds): RuntimeEstimate {
  const db = getDb();
  const time = activityTimeSql(bounds);
  const allTimeSamples = bounds
    ? Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) n FROM activity_events
               WHERE event_type = 'power' AND avg_power_mw IS NOT NULL AND avg_power_mw > 0
                 AND (recording_resolution IS NULL OR recording_resolution = ?)`,
            )
            .get(PRD_SHIFT_RESOLUTION) as { n: number }
        ).n,
      )
    : 0;
  const all = db
    .prepare(
      `SELECT purpose, avg_power_mw, recording_resolution, duration_seconds
       FROM activity_events
       WHERE event_type = 'power'
         AND avg_power_mw IS NOT NULL
         AND avg_power_mw > 0${time.sql}`,
    )
    .all(...time.params) as Array<{
    purpose: string | null;
    avg_power_mw: number;
    recording_resolution: string | null;
    duration_seconds: number | null;
  }>;

  // Rows predating the resolution column have it NULL; treat those as on-profile rather than
  // discarding history captured before the fleet split configs.
  const onProfile = (r: { recording_resolution: string | null }) =>
    !r.recording_resolution || r.recording_resolution === PRD_SHIFT_RESOLUTION;
  const rows = all.filter(onProfile);
  const offProfile = all.filter((r) => !onProfile(r));
  const offProfileConfigs = [...new Set(offProfile.map((r) => String(r.recording_resolution)))].sort();

  const byKey = new Map<PowerState["key"], PowerSample[]>([
    ["buffering", []],
    ["recording", []],
    ["livestreaming", []],
  ]);
  for (const r of rows) {
    const key = STATE_TO_KEY[(r.purpose || "").toUpperCase()];
    if (key) {
      byKey.get(key)!.push({
        mw: Number(r.avg_power_mw),
        seconds: Number(r.duration_seconds || 0),
      });
    }
  }

  const states: PowerState[] = [
    { key: "buffering", label: "Buffering" },
    { key: "recording", label: "Recording" },
    { key: "livestreaming", label: "Livestreaming" },
  ].map(({ key, label }) => {
    const vals = byKey.get(key as PowerState["key"])!;
    const med = weightedQuantile(vals, 0.5);
    return {
      key: key as PowerState["key"],
      label,
      medianMw: med === null ? null : Math.round(med * 10) / 10,
      samples: vals.length,
    };
  });

  const buf = byKey.get("buffering")!;
  const rec = byKey.get("recording")!;
  const computable = buf.length > 0 && rec.length > 0;

  const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
  // Best case is low recording draw against low buffering draw; worst is the opposite corner.
  const best = computable
    ? shiftHoursFromPower(weightedQuantile(rec, 0.25)!, weightedQuantile(buf, 0.25)!)
    : null;
  const worst = computable
    ? shiftHoursFromPower(weightedQuantile(rec, 0.75)!, weightedQuantile(buf, 0.75)!)
    : null;

  return {
    states,
    shiftHours: computable
      ? round1(shiftHoursFromPower(weightedQuantile(rec, 0.5)!, weightedQuantile(buf, 0.5)!))
      : null,
    shiftHoursLow: round1(worst),
    shiftHoursHigh: round1(best),
    targetHours: FIELDCAM_TARGET_SHIFT_HOURS,
    batteryMah: FIELDCAM_BATTERY_MAH,
    nominalVolts: FIELDCAM_NOMINAL_VOLTS,
    recordingHours: FIELDCAM_RECORDING_HOURS,
    computable,
    offProfileSamples: offProfile.length,
    offProfileConfigs,
    allTimeSamples: bounds ? allTimeSamples : rows.length,
  };
}
