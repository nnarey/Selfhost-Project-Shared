import { randomUUID } from "node:crypto";
import { audit, getDb, nowISO } from "./db.js";
import { emailHandle } from "./participants.js";
import { recomputeWeekScores } from "./scoring/engine.js";
import { periodWeekStartUtcISO } from "./week.js";

export interface ScoreAdjustment {
  adjustmentId: string;
  email: string;
  name: string;
  weekStart: string;
  deltaPoints: number;
  reason: string;
  setTo: number | null;
  awardedBy: string;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface ScorePerson {
  email: string;
  name: string;
  totalPoints: number;
  rank: number | null;
}

function personTotal(weekStart: string, email: string): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_points), 0) AS total
       FROM weekly_scores
       WHERE week_start = ? AND lower(email) = lower(?)`,
    )
    .get(weekStart, email) as { total: number };
  return Number(row?.total) || 0;
}

export function listScorePeople(weekStart?: string): { weekStart: string; people: ScorePerson[] } {
  const db = getDb();
  const ws = weekStart || periodWeekStartUtcISO(new Date());
  const people = db
    .prepare(
      `SELECT p.email, p.name,
              COALESCE(s.total, 0) AS totalPoints,
              s.rank AS rank
       FROM participants p
       LEFT JOIN (
         SELECT email, SUM(total_points) AS total, MIN(rank) AS rank
         FROM weekly_scores
         WHERE week_start = ?
         GROUP BY email
       ) s ON lower(s.email) = lower(p.email)
       WHERE p.signup_status IN ('pending', 'approved')
       ORDER BY COALESCE(s.total, 0) DESC, p.name COLLATE NOCASE`,
    )
    .all(ws) as Array<{ email: string; name: string; totalPoints: number; rank: number | null }>;
  return {
    weekStart: ws,
    people: people.map((p) => ({
      email: p.email,
      name: (p.name && String(p.name).trim()) || emailHandle(p.email),
      totalPoints: Number(p.totalPoints) || 0,
      rank: p.rank == null ? null : Number(p.rank),
    })),
  };
}

export function listScoreAdjustments(
  weekStart?: string,
  includeRevoked = false,
): ScoreAdjustment[] {
  const db = getDb();
  const ws = weekStart || periodWeekStartUtcISO(new Date());
  const rows = db
    .prepare(
      `SELECT a.*, p.name
       FROM score_adjustments a
       LEFT JOIN participants p ON lower(p.email) = lower(a.email)
       WHERE a.week_start = ?
         AND (? = 1 OR a.revoked_at IS NULL)
       ORDER BY a.created_at DESC`,
    )
    .all(ws, includeRevoked ? 1 : 0) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    adjustmentId: String(r.adjustment_id),
    email: String(r.email),
    name: (r.name && String(r.name).trim()) || emailHandle(String(r.email)),
    weekStart: String(r.week_start),
    deltaPoints: Number(r.delta_points),
    reason: String(r.reason),
    setTo: r.set_to == null ? null : Number(r.set_to),
    awardedBy: String(r.awarded_by),
    createdAt: String(r.created_at),
    revokedAt: r.revoked_at ? String(r.revoked_at) : null,
    revokedBy: r.revoked_by ? String(r.revoked_by) : null,
  }));
}

export function applyScoreAdjustment(
  actor: string,
  input: {
    email: string;
    reason: string;
    delta?: number;
    setTotal?: number;
    weekStart?: string;
  },
): {
  adjustment: ScoreAdjustment;
  beforePoints: number;
  afterPoints: number;
  scores: ReturnType<typeof recomputeWeekScores>;
} {
  const email = input.email.trim().toLowerCase();
  const reason = input.reason.trim();
  if (!email.includes("@")) throw new Error("email required");
  if (!reason) throw new Error("Reason is required for an audited score change");

  const db = getDb();
  const participant = db
    .prepare(`SELECT email, signup_status FROM participants WHERE lower(email) = lower(?)`)
    .get(email) as { email: string; signup_status: string } | undefined;
  if (!participant) throw new Error("Participant not found — they need to be on the roster first");
  if (participant.signup_status === "rejected") {
    throw new Error("Rejected registrations cannot have their scores changed");
  }

  const weekStart = input.weekStart || periodWeekStartUtcISO(new Date());
  recomputeWeekScores(weekStart);
  const beforePoints = personTotal(weekStart, email);

  let delta: number;
  let setTo: number | null = null;
  if (input.setTotal != null && Number.isFinite(Number(input.setTotal))) {
    setTo = Number(input.setTotal);
    delta = setTo - beforePoints;
  } else {
    delta = Number(input.delta);
  }
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error("Change must add, subtract, or set a different total");
  }

  const now = nowISO();
  const adjustmentId = randomUUID();
  db.prepare(
    `INSERT INTO score_adjustments (
      adjustment_id, email, week_start, delta_points, reason, set_to, awarded_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(adjustmentId, email, weekStart, delta, reason, setTo, actor, now);

  audit(actor, "scores.adjust", {
    entityType: "score_adjustment",
    entityId: adjustmentId,
    reason,
    oldValue: { email, totalPoints: beforePoints },
    newValue: { email, delta, setTo, weekStart },
  });

  const scores = recomputeWeekScores(weekStart);
  const afterPoints = personTotal(weekStart, email);
  const adjustment = listScoreAdjustments(weekStart, true).find(
    (a) => a.adjustmentId === adjustmentId,
  );
  if (!adjustment) throw new Error("Adjustment saved but could not be reloaded");
  return { adjustment, beforePoints, afterPoints, scores };
}

export function revokeScoreAdjustment(
  actor: string,
  adjustmentId: string,
): { adjustmentId: string; weekStart: string; scores: ReturnType<typeof recomputeWeekScores> } {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT adjustment_id, week_start, revoked_at FROM score_adjustments WHERE adjustment_id = ?`,
    )
    .get(adjustmentId) as
    | { adjustment_id: string; week_start: string; revoked_at: string | null }
    | undefined;
  if (!row) throw new Error("Adjustment not found");
  if (row.revoked_at) throw new Error("Adjustment already revoked");
  db.prepare(
    `UPDATE score_adjustments SET revoked_at = ?, revoked_by = ? WHERE adjustment_id = ?`,
  ).run(nowISO(), actor, adjustmentId);
  audit(actor, "scores.adjust_revoke", {
    entityType: "score_adjustment",
    entityId: adjustmentId,
    reason: "admin_revoke",
  });
  const scores = recomputeWeekScores(row.week_start);
  return { adjustmentId, weekStart: row.week_start, scores };
}
