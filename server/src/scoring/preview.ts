import { nowISO } from "../db.js";
import { nextMondayWeekStartUtcISO, weekStartUtcISO } from "../week.js";
import { diffScoreRows, readWeekScoreRows, recomputeWeekScores } from "./engine.js";
import { getDraft, validateRules, type ResolvedProfile } from "./profiles.js";

/** Preview draft rules against an open week without mutating persisted scores. */
export function previewDraftScores(
  profileId: string,
  version: number,
  weekStart?: string,
) {
  const draft = getDraft(profileId, version);
  const errors = validateRules(draft.rules);
  if (errors.length) throw new Error(errors.join("; "));

  const ws = weekStart || weekStartUtcISO(new Date());
  const before = readWeekScoreRows(ws);
  if (!before.length) {
    recomputeWeekScores(ws);
  }
  const baseline = before.length ? before : readWeekScoreRows(ws);

  const resolved: ResolvedProfile = {
    profile: draft.profile,
    rules: draft.rules,
    tieBreakers: draft.tieBreakers,
  };
  const projected = recomputeWeekScores(ws, nowISO(), {
    profileOverride: resolved,
    persist: false,
  });
  const deltas = diffScoreRows(baseline, projected.entries);
  const unavailable = draft.rules
    .filter((r) => r.enabled)
    .filter((r) => ["upload_count", "livestream_count"].includes(r.metricKey))
    .map((r) => r.metricKey);

  return {
    weekStart: ws,
    profileId,
    version,
    nextMonday: nextMondayWeekStartUtcISO(),
    validationErrors: [] as string[],
    unavailableMetrics: unavailable,
    deltas: deltas.slice(0, 40),
    projectedTop: projected.entries.slice(0, 10).map((e) => ({
      rank: e.rank,
      name: e.name,
      cameraId: e.cameraId,
      totalPoints: e.totalPoints,
    })),
  };
}

export function validateDraft(profileId: string, version: number) {
  const draft = getDraft(profileId, version);
  return {
    profileId,
    version,
    status: draft.profile.status,
    errors: validateRules(draft.rules),
    nextMonday: nextMondayWeekStartUtcISO(),
  };
}
