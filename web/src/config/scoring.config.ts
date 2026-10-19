// Tunable scoring weights for the FieldCam Self-Host World Cup.
//
// Demo scoring defaults. Kept in one file on purpose so Alice/Bob
// can tune point values after review without touching any component code.

export const SCORING_WEIGHTS = {
  /** Base points per valid recording. At most 10 clips under 5m per camera per day earn session points; 5m+ always count. Multipliers: 5m 2x, 10m 5x, 20m 12x, 40m 25x, 80m 55x. */
  recordingSession: 10,
  /** Points per hour of recording (decimal hours, e.g. 1.75h = 262.5 pts). */
  recordingHour: 150,
  /** Points per successful fleet upload, capped at 8 points per camera per day. */
  upload: 8,
  /** Points per livestream session, capped below. */
  livestream: 50,
  /** Max livestreams that score per camera per day. */
  livestreamCapPerDay: 3,
  /** Bonus per recording triggered by attaching/detaching the POV, capped below. Additive — the
   *  recording still earns its normal session and hour points. */
  povRecording: 50,
  /** Max POV recordings that score per camera per day. */
  povRecordingCapPerDay: 3,
  /** Points per #selfhost report, including "worked as expected" reports. */
  report: 200,
  /** Bonus points per consecutive active day, capped below. */
  streakBonusPerDay: 5,
  /** Max streak-bonus days that count (7 days x 5 = 35 pt cap). */
  streakCapDays: 7,
  /** Penalty applied per day a participant is Inactive. Uncapped — totals may go negative. */
  inactivePenaltyPerDay: -100,
} as const;

/** Program-wide targets shown as progress meters on Overall Statistics. */
export const PROGRAM_GOALS = {
  recordings: 10_000,
  recordingHours: 5_000,
} as const;

/** Hours since a participant's last logged recording before they're auto-marked Inactive. */
export const INACTIVITY_THRESHOLD_HOURS = 24;

/** Match points awarded for group-stage results. */
export const MATCH_POINTS = {
  win: 3,
  draw: 1,
  loss: 0,
} as const;

/** How many days of activity feed the seeded demo dataset. */
export const DEMO_ACTIVITY_WINDOW_DAYS = 14;
