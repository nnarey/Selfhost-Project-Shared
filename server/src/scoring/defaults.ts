import type Database from "better-sqlite3";
import type { MetricKey, ScoringRule } from "../types.js";
import { ENV } from "../env.js";

export const DEFAULT_PROFILE_ID = "default";
export const DEFAULT_PROFILE_VERSION = 1;

export const DEFAULT_TIE_BREAKERS: MetricKey[] = [
  "approved_report_count",
  "recording_hours",
  "recording_count",
];

export const DEFAULT_RULES: ScoringRule[] = [
  {
    metricKey: "recording_event_count",
    label: "All recordings",
    aggregation: "count_recording_events",
    pointsPerUnit: 0,
    minimum: null,
    cap: null,
    enabled: true,
    displayOrder: 1,
    paramsJson: "{}",
  },
  {
    metricKey: "recording_count",
    label: "Recordings ≥ 30s",
    aggregation: "count_valid_recordings",
    pointsPerUnit: 10,
    minimum: 30,
    cap: null,
    enabled: true,
    displayOrder: 2,
    paramsJson: JSON.stringify({
      purpose: "PURPOSE_STANDARD",
      status: "success",
      durationDoubleBaseSeconds: 300,
      durationMultiplierCapSeconds: 4800,
      sessionPointsPerDayCap: 10,
    }),
  },
  {
    metricKey: "short_recording_count",
    label: "Recordings < 30s",
    aggregation: "count_short_recordings",
    pointsPerUnit: 5,
    minimum: null,
    cap: null,
    enabled: true,
    displayOrder: 3,
    paramsJson: JSON.stringify({
      purpose: "PURPOSE_STANDARD",
      status: "success",
    }),
  },
  {
    metricKey: "recording_hours",
    label: "Recording hours",
    aggregation: "sum_recording_hours",
    pointsPerUnit: 150,
    minimum: null,
    cap: null,
    enabled: true,
    displayOrder: 4,
    paramsJson: "{}",
  },
  {
    metricKey: "upload_count",
    label: "Successful uploads",
    aggregation: "count_uploads",
    pointsPerUnit: 8,
    minimum: null,
    cap: null,
    enabled: true,
    displayOrder: 5,
    paramsJson: JSON.stringify({ uploadPointsPerDayCap: 8 }),
  },
  {
    metricKey: "livestream_count",
    label: "Livestream sessions",
    aggregation: "count_livestreams",
    pointsPerUnit: 50,
    minimum: null,
    cap: null,
    enabled: true,
    displayOrder: 6,
    paramsJson: JSON.stringify({ livestreamsPerDayCap: 3 }),
  },
  {
    metricKey: "mobile_action_count",
    label: "Mobile actions",
    aggregation: "count_mobile_actions",
    pointsPerUnit: 0,
    minimum: null,
    cap: null,
    enabled: true,
    displayOrder: 7,
    paramsJson: "{}",
  },
  {
    metricKey: "pov_recording_count",
    label: "POV recordings",
    aggregation: "count_pov_recordings",
    pointsPerUnit: 50,
    minimum: null,
    cap: null,
    enabled: true,
    displayOrder: 8,
    paramsJson: JSON.stringify({ povRecordingsPerDayCap: 3 }),
  },
  {
    metricKey: "approved_report_count",
    label: "Approved reports",
    aggregation: "count_approved_reports",
    pointsPerUnit: 200,
    minimum: null,
    cap: null,
    enabled: true,
    displayOrder: 9,
    paramsJson: "{}",
  },
  {
    metricKey: "active_day_streak",
    label: "Active-day streak",
    aggregation: "active_day_streak",
    pointsPerUnit: 5,
    minimum: null,
    cap: 7,
    enabled: true,
    displayOrder: 10,
    paramsJson: "{}",
  },
  {
    metricKey: "inactive_day_count",
    label: "Inactivity penalty",
    aggregation: "inactive_day_count",
    pointsPerUnit: -100,
    minimum: null,
    cap: null,
    enabled: true,
    displayOrder: 11,
    paramsJson: JSON.stringify({ thresholdHours: 24 }),
  },
  {
    metricKey: "challenge_bonus",
    label: "Challenge bonus",
    aggregation: "sum_challenge_bonus",
    pointsPerUnit: 1,
    minimum: null,
    cap: null,
    enabled: true,
    displayOrder: 12,
    paramsJson: "{}",
  },
  {
    metricKey: "manual_adjustment",
    label: "Admin adjustment",
    aggregation: "sum_manual_adjustment",
    pointsPerUnit: 1,
    minimum: null,
    cap: null,
    enabled: true,
    displayOrder: 13,
    paramsJson: "{}",
  },
];

export function ensureDefaultScoringProfile(db: Database.Database): void {
  const recordingRule = DEFAULT_RULES.find((r) => r.metricKey === "recording_count");
  if (recordingRule) {
    db.prepare(
      `UPDATE scoring_rules SET params_json = ?, label = ?
       WHERE profile_id = ? AND profile_version = ? AND metric_key = 'recording_count'`,
    ).run(recordingRule.paramsJson, recordingRule.label, DEFAULT_PROFILE_ID, DEFAULT_PROFILE_VERSION);
  }
  const hoursRule = DEFAULT_RULES.find((r) => r.metricKey === "recording_hours");
  if (hoursRule) {
    db.prepare(
      `UPDATE scoring_rules SET points_per_unit = ?
       WHERE profile_id = ? AND profile_version = ? AND metric_key = 'recording_hours'`,
    ).run(hoursRule.pointsPerUnit, DEFAULT_PROFILE_ID, DEFAULT_PROFILE_VERSION);
  }
  const livestreamRule = DEFAULT_RULES.find((r) => r.metricKey === "livestream_count");
  if (livestreamRule) {
    db.prepare(
      `UPDATE scoring_rules SET points_per_unit = ?, params_json = ?
       WHERE profile_id = ? AND profile_version = ? AND metric_key = 'livestream_count'`,
    ).run(
      livestreamRule.pointsPerUnit,
      livestreamRule.paramsJson,
      DEFAULT_PROFILE_ID,
      DEFAULT_PROFILE_VERSION,
    );
  }
  const uploadRule = DEFAULT_RULES.find((r) => r.metricKey === "upload_count");
  if (uploadRule) {
    db.prepare(
      `UPDATE scoring_rules SET params_json = ?
       WHERE profile_id = ? AND profile_version = ? AND metric_key = 'upload_count'`,
    ).run(uploadRule.paramsJson, DEFAULT_PROFILE_ID, DEFAULT_PROFILE_VERSION);
  }
  const reportRule = DEFAULT_RULES.find((r) => r.metricKey === "approved_report_count");
  if (reportRule) {
    db.prepare(
      `UPDATE scoring_rules SET points_per_unit = ?
       WHERE profile_id = ? AND profile_version = ? AND metric_key = 'approved_report_count'`,
    ).run(reportRule.pointsPerUnit, DEFAULT_PROFILE_ID, DEFAULT_PROFILE_VERSION);
  }
  const inactiveRule = DEFAULT_RULES.find((r) => r.metricKey === "inactive_day_count");
  if (inactiveRule) {
    db.prepare(
      `UPDATE scoring_rules SET points_per_unit = ?
       WHERE profile_id = ? AND profile_version = ? AND metric_key = 'inactive_day_count'`,
    ).run(inactiveRule.pointsPerUnit, DEFAULT_PROFILE_ID, DEFAULT_PROFILE_VERSION);
  }
  db.prepare(
    `UPDATE scoring_profiles SET name = 'Default', notes = 'Shipped default scoring profile'
     WHERE profile_id IN ('default', 'pilot-default')`,
  ).run();

  const existing = db
    .prepare(`SELECT profile_id FROM scoring_profiles WHERE profile_id = ? AND version = ?`)
    .get(DEFAULT_PROFILE_ID, DEFAULT_PROFILE_VERSION);
  if (existing) return;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO scoring_profiles (
      profile_id, version, name, status, effective_week_start, timezone,
      tie_breakers_json, created_at, created_by, approved_at, approved_by, notes
    ) VALUES (?, ?, ?, 'active', NULL, ?, ?, ?, 'system', ?, 'system', ?)`,
  ).run(
    DEFAULT_PROFILE_ID,
    DEFAULT_PROFILE_VERSION,
    "Default",
    ENV.weekTimezone,
    JSON.stringify(DEFAULT_TIE_BREAKERS),
    now,
    now,
    "Shipped default scoring profile",
  );

  const insertRule = db.prepare(
    `INSERT INTO scoring_rules (
      profile_id, profile_version, metric_key, label, aggregation,
      points_per_unit, minimum, cap, enabled, display_order, params_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const rule of DEFAULT_RULES) {
    insertRule.run(
      DEFAULT_PROFILE_ID,
      DEFAULT_PROFILE_VERSION,
      rule.metricKey,
      rule.label,
      rule.aggregation,
      rule.pointsPerUnit,
      rule.minimum,
      rule.cap,
      rule.enabled ? 1 : 0,
      rule.displayOrder,
      rule.paramsJson,
    );
  }
}

/** Add the all-recordings (0 pt) column to existing profiles once. */
export function ensureRecordingEventCountRule(db: Database.Database): void {
  const rule = DEFAULT_RULES.find((r) => r.metricKey === "recording_event_count");
  if (!rule) return;
  const profiles = db
    .prepare(`SELECT profile_id, version FROM scoring_profiles`)
    .all() as Array<{ profile_id: string; version: number }>;
  const has = db.prepare(
    `SELECT metric_key FROM scoring_rules
     WHERE profile_id = ? AND profile_version = ? AND metric_key = 'recording_event_count'`,
  );
  const shift = db.prepare(
    `UPDATE scoring_rules SET display_order = display_order + 1
     WHERE profile_id = ? AND profile_version = ? AND metric_key != 'recording_event_count'`,
  );
  const insert = db.prepare(
    `INSERT INTO scoring_rules (
      profile_id, profile_version, metric_key, label, aggregation,
      points_per_unit, minimum, cap, enabled, display_order, params_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of profiles) {
    if (has.get(p.profile_id, p.version)) {
      db.prepare(
        `UPDATE scoring_rules SET label = ?, points_per_unit = 0, enabled = 1, display_order = ?
         WHERE profile_id = ? AND profile_version = ? AND metric_key = 'recording_event_count'`,
      ).run(rule.label, rule.displayOrder, p.profile_id, p.version);
      continue;
    }
    shift.run(p.profile_id, p.version);
    insert.run(
      p.profile_id,
      p.version,
      rule.metricKey,
      rule.label,
      rule.aggregation,
      rule.pointsPerUnit,
      rule.minimum,
      rule.cap,
      rule.enabled ? 1 : 0,
      rule.displayOrder,
      rule.paramsJson,
    );
  }
}

/**
 * Add the short-recording (5 pt) rule to existing profiles once.
 *
 * Recordings under the 30s threshold previously scored nothing. They now earn 5 points each and are
 * counted here *instead of* `recording_count`, never in addition — a recording lands in exactly one
 * of the two buckets, so nothing is paid twice.
 */
export function ensureShortRecordingRule(db: Database.Database): void {
  const rule = DEFAULT_RULES.find((r) => r.metricKey === "short_recording_count");
  if (!rule) return;
  const profiles = db
    .prepare(`SELECT profile_id, version FROM scoring_profiles`)
    .all() as Array<{ profile_id: string; version: number }>;
  const has = db.prepare(
    `SELECT metric_key FROM scoring_rules
     WHERE profile_id = ? AND profile_version = ? AND metric_key = 'short_recording_count'`,
  );
  const shift = db.prepare(
    `UPDATE scoring_rules SET display_order = display_order + 1
     WHERE profile_id = ? AND profile_version = ? AND display_order >= ?`,
  );
  const insert = db.prepare(
    `INSERT INTO scoring_rules (
      profile_id, profile_version, metric_key, label, aggregation,
      points_per_unit, minimum, cap, enabled, display_order, params_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of profiles) {
    if (has.get(p.profile_id, p.version)) continue;
    shift.run(p.profile_id, p.version, rule.displayOrder);
    insert.run(
      p.profile_id,
      p.version,
      rule.metricKey,
      rule.label,
      rule.aggregation,
      rule.pointsPerUnit,
      rule.minimum,
      rule.cap,
      rule.enabled ? 1 : 0,
      rule.displayOrder,
      rule.paramsJson,
    );
  }
}


/**
 * Add the POV recording bonus to existing profiles once.
 *
 * Purely additive: a POV recording still counts in `recording_count` or `short_recording_count` and
 * earns those points too. This is a bonus on top, not a third bucket, so nothing is displaced.
 */
export function ensureMobileActionRule(db: Database.Database): void {
  const rule = DEFAULT_RULES.find((r) => r.metricKey === "mobile_action_count");
  if (!rule) return;
  const profiles = db
    .prepare(`SELECT profile_id, version FROM scoring_profiles`)
    .all() as Array<{ profile_id: string; version: number }>;
  const has = db.prepare(
    `SELECT metric_key FROM scoring_rules
     WHERE profile_id = ? AND profile_version = ? AND metric_key = 'mobile_action_count'`,
  );
  const shift = db.prepare(
    `UPDATE scoring_rules SET display_order = display_order + 1
     WHERE profile_id = ? AND profile_version = ? AND display_order >= ?`,
  );
  const insert = db.prepare(
    `INSERT INTO scoring_rules (
      profile_id, profile_version, metric_key, label, aggregation,
      points_per_unit, minimum, cap, enabled, display_order, params_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of profiles) {
    if (has.get(p.profile_id, p.version)) continue;
    shift.run(p.profile_id, p.version, rule.displayOrder);
    insert.run(
      p.profile_id,
      p.version,
      rule.metricKey,
      rule.label,
      rule.aggregation,
      rule.pointsPerUnit,
      rule.minimum,
      rule.cap,
      rule.enabled ? 1 : 0,
      rule.displayOrder,
      rule.paramsJson,
    );
  }
}

export function ensurePovRecordingRule(db: Database.Database): void {
  const rule = DEFAULT_RULES.find((r) => r.metricKey === "pov_recording_count");
  if (!rule) return;
  const profiles = db
    .prepare(`SELECT profile_id, version FROM scoring_profiles`)
    .all() as Array<{ profile_id: string; version: number }>;
  const has = db.prepare(
    `SELECT metric_key FROM scoring_rules
     WHERE profile_id = ? AND profile_version = ? AND metric_key = 'pov_recording_count'`,
  );
  const shift = db.prepare(
    `UPDATE scoring_rules SET display_order = display_order + 1
     WHERE profile_id = ? AND profile_version = ? AND display_order >= ?`,
  );
  const insert = db.prepare(
    `INSERT INTO scoring_rules (
      profile_id, profile_version, metric_key, label, aggregation,
      points_per_unit, minimum, cap, enabled, display_order, params_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of profiles) {
    if (has.get(p.profile_id, p.version)) continue;
    shift.run(p.profile_id, p.version, rule.displayOrder);
    insert.run(
      p.profile_id,
      p.version,
      rule.metricKey,
      rule.label,
      rule.aggregation,
      rule.pointsPerUnit,
      rule.minimum,
      rule.cap,
      rule.enabled ? 1 : 0,
      rule.displayOrder,
      rule.paramsJson,
    );
  }
}
