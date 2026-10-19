import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { getDb, nowISO, audit } from "../db.js";
import { weekStartUtcISO } from "../week.js";
import { ALLOWLISTED_METRICS, type MetricKey, type ScoringProfile, type ScoringRule } from "../types.js";
import { DEFAULT_PROFILE_ID, DEFAULT_PROFILE_VERSION, DEFAULT_TIE_BREAKERS } from "./defaults.js";

export interface ResolvedProfile {
  profile: ScoringProfile;
  rules: ScoringRule[];
  tieBreakers: MetricKey[];
}

function mapProfile(row: Record<string, unknown>): ScoringProfile {
  return {
    profileId: String(row.profile_id),
    version: Number(row.version),
    name: String(row.name),
    status: row.status as ScoringProfile["status"],
    effectiveWeekStart: row.effective_week_start ? String(row.effective_week_start) : null,
    timezone: String(row.timezone),
    tieBreakersJson: String(row.tie_breakers_json),
    createdAt: String(row.created_at),
    createdBy: String(row.created_by),
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    notes: row.notes ? String(row.notes) : null,
  };
}

function mapRule(row: Record<string, unknown>): ScoringRule {
  return {
    metricKey: row.metric_key as MetricKey,
    label: String(row.label),
    aggregation: String(row.aggregation),
    pointsPerUnit: Number(row.points_per_unit),
    minimum: row.minimum == null ? null : Number(row.minimum),
    cap: row.cap == null ? null : Number(row.cap),
    enabled: Boolean(row.enabled),
    displayOrder: Number(row.display_order),
    paramsJson: String(row.params_json || "{}"),
  };
}

export function loadProfileRules(
  db: Database.Database,
  profileId: string,
  version: number,
): ScoringRule[] {
  return db
    .prepare(
      `SELECT * FROM scoring_rules WHERE profile_id = ? AND profile_version = ? ORDER BY display_order`,
    )
    .all(profileId, version)
    .map((r) => mapRule(r as Record<string, unknown>));
}

/** Resolve profile bound to a week start; fall back to active. */
export function resolveProfileForWeek(weekStartISO: string): ResolvedProfile {
  const db = getDb();
  let row = db
    .prepare(
      `SELECT * FROM scoring_profiles
       WHERE status IN ('active', 'scheduled', 'retired')
         AND effective_week_start IS NOT NULL
         AND effective_week_start <= ?
       ORDER BY effective_week_start DESC, version DESC
       LIMIT 1`,
    )
    .get(weekStartISO) as Record<string, unknown> | undefined;

  if (!row) {
    row = db
      .prepare(
        `SELECT * FROM scoring_profiles WHERE status = 'active'
         ORDER BY version DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
  }

  if (!row) {
    row = db
      .prepare(`SELECT * FROM scoring_profiles WHERE profile_id = ? AND version = ?`)
      .get(DEFAULT_PROFILE_ID, DEFAULT_PROFILE_VERSION) as Record<string, unknown>;
  }

  const profile = mapProfile(row);
  const rules = loadProfileRules(db, profile.profileId, profile.version);
  if (!rules.length) {
    throw new Error(`Scoring profile ${profile.profileId}@${profile.version} has no rules`);
  }
  let tieBreakers: MetricKey[] = DEFAULT_TIE_BREAKERS;
  try {
    tieBreakers = JSON.parse(profile.tieBreakersJson) as MetricKey[];
  } catch {
    // keep default
  }
  return { profile, rules, tieBreakers };
}

export function getActiveProfilePublic() {
  const weekStart = weekStartUtcISO(new Date());
  const resolved = resolveProfileForWeek(weekStart);
  return {
    profileId: resolved.profile.profileId,
    version: resolved.profile.version,
    name: resolved.profile.name,
    status: resolved.profile.status,
    timezone: resolved.profile.timezone,
    weekStart,
    metrics: resolved.rules
      .filter((r) => r.enabled)
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((r) => ({
        metricKey: r.metricKey,
        label: r.label,
        pointsPerUnit: r.pointsPerUnit,
        displayOrder: r.displayOrder,
      })),
    /** Every rule, including disabled ones, for the admin scoring editor. */
    rules: [...resolved.rules]
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((r) => ({
        metricKey: r.metricKey,
        label: r.label,
        pointsPerUnit: r.pointsPerUnit,
        enabled: r.enabled,
        cap: r.cap,
        minimum: r.minimum,
        displayOrder: r.displayOrder,
        aggregation: r.aggregation,
        paramsJson: r.paramsJson,
      })),
    tieBreakers: resolved.tieBreakers,
  };
}

export function validateRules(rules: ScoringRule[]): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const rule of rules) {
    if (!ALLOWLISTED_METRICS.includes(rule.metricKey)) {
      errors.push(`Unknown metricKey: ${rule.metricKey}`);
    }
    if (keys.has(rule.metricKey)) errors.push(`Duplicate metricKey: ${rule.metricKey}`);
    keys.add(rule.metricKey);
    if (!Number.isFinite(rule.pointsPerUnit)) {
      errors.push(`${rule.metricKey}: pointsPerUnit must be finite`);
    }
    if (rule.minimum != null && !Number.isFinite(rule.minimum)) {
      errors.push(`${rule.metricKey}: minimum must be finite`);
    }
    if (rule.cap != null && !Number.isFinite(rule.cap)) {
      errors.push(`${rule.metricKey}: cap must be finite`);
    }
  }
  return errors;
}

export function copyActiveToDraft(actor: string, name?: string) {
  const db = getDb();
  const active = resolveProfileForWeek(weekStartUtcISO(new Date()));
  const profileId = uuid();
  const version = 1;
  const now = nowISO();
  db.prepare(
    `INSERT INTO scoring_profiles (
      profile_id, version, name, status, effective_week_start, timezone,
      tie_breakers_json, created_at, created_by, notes
    ) VALUES (?, ?, ?, 'draft', NULL, ?, ?, ?, ?, ?)`,
  ).run(
    profileId,
    version,
    name || `${active.profile.name} draft`,
    active.profile.timezone,
    active.profile.tieBreakersJson,
    now,
    actor,
    `Copied from ${active.profile.profileId}@${active.profile.version}`,
  );

  const insert = db.prepare(
    `INSERT INTO scoring_rules (
      profile_id, profile_version, metric_key, label, aggregation,
      points_per_unit, minimum, cap, enabled, display_order, params_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const rule of active.rules) {
    insert.run(
      profileId,
      version,
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

  audit(actor, "scoring.draft_created", {
    entityType: "scoring_profile",
    entityId: `${profileId}@${version}`,
    newValue: { copiedFrom: `${active.profile.profileId}@${active.profile.version}` },
  });

  return {
    profileId,
    version,
    rules: active.rules,
    tieBreakers: active.tieBreakers,
  };
}

export function updateDraft(
  actor: string,
  profileId: string,
  version: number,
  patch: {
    name?: string;
    rules?: ScoringRule[];
    tieBreakers?: MetricKey[];
    notes?: string;
  },
) {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM scoring_profiles WHERE profile_id = ? AND version = ?`)
    .get(profileId, version) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Profile not found");
  if (String(row.status) !== "draft") throw new Error("Only draft profiles can be edited");

  if (patch.rules) {
    const errors = validateRules(patch.rules);
    if (errors.length) throw new Error(errors.join("; "));
    db.prepare(`DELETE FROM scoring_rules WHERE profile_id = ? AND profile_version = ?`).run(
      profileId,
      version,
    );
    const insert = db.prepare(
      `INSERT INTO scoring_rules (
        profile_id, profile_version, metric_key, label, aggregation,
        points_per_unit, minimum, cap, enabled, display_order, params_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const rule of patch.rules) {
      insert.run(
        profileId,
        version,
        rule.metricKey,
        rule.label,
        rule.aggregation,
        rule.pointsPerUnit,
        rule.minimum,
        rule.cap,
        rule.enabled ? 1 : 0,
        rule.displayOrder,
        rule.paramsJson || "{}",
      );
    }
  }

  db.prepare(
    `UPDATE scoring_profiles SET
      name = COALESCE(?, name),
      tie_breakers_json = COALESCE(?, tie_breakers_json),
      notes = COALESCE(?, notes)
     WHERE profile_id = ? AND version = ?`,
  ).run(
    patch.name ?? null,
    patch.tieBreakers ? JSON.stringify(patch.tieBreakers) : null,
    patch.notes ?? null,
    profileId,
    version,
  );

  audit(actor, "scoring.draft_updated", {
    entityType: "scoring_profile",
    entityId: `${profileId}@${version}`,
  });

  return getDraft(profileId, version);
}

export function getDraft(profileId: string, version: number) {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM scoring_profiles WHERE profile_id = ? AND version = ?`)
    .get(profileId, version) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Profile not found");
  const profile = mapProfile(row);
  return {
    profile,
    rules: loadProfileRules(db, profileId, version),
    tieBreakers: JSON.parse(profile.tieBreakersJson) as MetricKey[],
  };
}

export function scheduleDraft(
  actor: string,
  profileId: string,
  version: number,
  effectiveWeekStart: string,
  reason?: string,
) {
  const db = getDb();
  const draft = getDraft(profileId, version);
  if (draft.profile.status !== "draft") throw new Error("Only drafts can be scheduled");
  const errors = validateRules(draft.rules);
  if (errors.length) throw new Error(errors.join("; "));

  const monday = weekStartUtcISO(effectiveWeekStart);

  const overlap = db
    .prepare(
      `SELECT profile_id, version FROM scoring_profiles
       WHERE status = 'scheduled' AND effective_week_start = ?`,
    )
    .get(monday);
  if (overlap) throw new Error("A profile is already scheduled for that week");

  const now = nowISO();
  db.prepare(
    `UPDATE scoring_profiles SET
      status = 'scheduled',
      effective_week_start = ?,
      approved_at = ?,
      approved_by = ?
     WHERE profile_id = ? AND version = ?`,
  ).run(monday, now, actor, profileId, version);

  audit(actor, "scoring.scheduled", {
    entityType: "scoring_profile",
    entityId: `${profileId}@${version}`,
    newValue: { effectiveWeekStart: monday },
    reason,
  });

  return getDraft(profileId, version);
}


/** Emergency: promote draft as new active version for current open week and recompute. */
export function emergencyActivate(
  actor: string,
  profileId: string,
  version: number,
  reason: string,
) {
  if (!reason?.trim()) throw new Error("Emergency activation requires a reason");
  const db = getDb();
  const draft = getDraft(profileId, version);
  const errors = validateRules(draft.rules);
  if (errors.length) throw new Error(errors.join("; "));
  const weekStart = weekStartUtcISO(new Date());
  const now = nowISO();

  db.prepare(`UPDATE scoring_profiles SET status = 'retired' WHERE status = 'active'`).run();
  db.prepare(
    `UPDATE scoring_profiles SET
      status = 'active',
      effective_week_start = ?,
      approved_at = ?,
      approved_by = ?,
      notes = COALESCE(notes, '') || ?
     WHERE profile_id = ? AND version = ?`,
  ).run(weekStart, now, actor, `\nEmergency: ${reason}`, profileId, version);

  audit(actor, "scoring.emergency_activate", {
    entityType: "scoring_profile",
    entityId: `${profileId}@${version}`,
    reason,
    newValue: { weekStart },
  });

  return { weekStart, profile: getDraft(profileId, version) };
}
