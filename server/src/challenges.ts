import { randomUUID } from "node:crypto";
import { audit, getDb, nowISO } from "./db.js";
import { weekStartUtcISO } from "./week.js";
import { recomputeWeekScores } from "./scoring/engine.js";

export interface ChallengeAward {
  awardId: string;
  email: string;
  name: string;
  cameraId: string | null;
  weekStart: string;
  points: number;
  title: string;
  notes: string | null;
  awardedBy: string;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

export function listChallengeAwards(weekStart?: string, includeRevoked = false): ChallengeAward[] {
  const db = getDb();
  const ws = weekStart || weekStartUtcISO(new Date());
  const rows = db
    .prepare(
      `SELECT a.*, p.name
       FROM challenge_awards a
       LEFT JOIN participants p ON lower(p.email) = lower(a.email)
       WHERE a.week_start = ?
         AND (? = 1 OR a.revoked_at IS NULL)
       ORDER BY a.created_at DESC`,
    )
    .all(ws, includeRevoked ? 1 : 0) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    awardId: String(r.award_id),
    email: String(r.email),
    name: (r.name && String(r.name).trim()) || String(r.email),
    cameraId: r.camera_id ? String(r.camera_id) : null,
    weekStart: String(r.week_start),
    points: Number(r.points),
    title: String(r.title),
    notes: r.notes ? String(r.notes) : null,
    awardedBy: String(r.awarded_by),
    createdAt: String(r.created_at),
    revokedAt: r.revoked_at ? String(r.revoked_at) : null,
    revokedBy: r.revoked_by ? String(r.revoked_by) : null,
  }));
}

export function awardChallenge(
  actor: string,
  input: {
    email: string;
    points: number;
    title: string;
    notes?: string;
    cameraId?: string;
    weekStart?: string;
  },
): { award: ChallengeAward; scores: ReturnType<typeof recomputeWeekScores> } {
  const email = input.email.trim().toLowerCase();
  const title = input.title.trim();
  const points = Number(input.points);
  if (!email.includes("@")) throw new Error("email required");
  if (!title) throw new Error("Challenge title required");
  if (!Number.isFinite(points) || points === 0) throw new Error("points must be a non-zero number");

  const db = getDb();
  const participant = db
    .prepare(`SELECT email, signup_status FROM participants WHERE lower(email) = lower(?)`)
    .get(email) as { email: string; signup_status: string } | undefined;
  if (!participant) throw new Error("Participant not found — they need to be on the roster first");
  if (participant.signup_status === "rejected") {
    throw new Error("Rejected registrations cannot receive challenge points");
  }

  const weekStart = input.weekStart || weekStartUtcISO(new Date());
  const now = nowISO();
  const awardId = randomUUID();
  const cameraId = input.cameraId?.trim() || null;
  db.prepare(
    `INSERT INTO challenge_awards (
      award_id, email, camera_id, week_start, points, title, notes, awarded_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(awardId, email, cameraId, weekStart, points, title, input.notes?.trim() || null, actor, now);

  audit(actor, "challenge.award", {
    entityType: "challenge_award",
    entityId: awardId,
    newValue: { email, points, title, cameraId, weekStart },
  });

  const scores = recomputeWeekScores(weekStart);
  const award = listChallengeAwards(weekStart, true).find((a) => a.awardId === awardId);
  if (!award) throw new Error("Award saved but could not be reloaded");
  return { award, scores };
}

export function revokeChallenge(
  actor: string,
  awardId: string,
): { awardId: string; weekStart: string; scores: ReturnType<typeof recomputeWeekScores> } {
  const db = getDb();
  const row = db
    .prepare(`SELECT award_id, week_start, revoked_at FROM challenge_awards WHERE award_id = ?`)
    .get(awardId) as { award_id: string; week_start: string; revoked_at: string | null } | undefined;
  if (!row) throw new Error("Award not found");
  if (row.revoked_at) throw new Error("Award already revoked");
  db.prepare(
    `UPDATE challenge_awards SET revoked_at = ?, revoked_by = ? WHERE award_id = ?`,
  ).run(nowISO(), actor, awardId);
  audit(actor, "challenge.revoke", {
    entityType: "challenge_award",
    entityId: awardId,
    reason: "admin_revoke",
  });
  const scores = recomputeWeekScores(row.week_start);
  return { awardId, weekStart: row.week_start, scores };
}
