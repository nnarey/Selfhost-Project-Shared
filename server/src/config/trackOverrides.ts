import { audit, getDb, nowISO } from "../db.js";
import { isPermanentHolderEmail } from "./permanentHolders.js";

export type BiweeklyTrack = "permanent" | "checkout";

function normEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function normSerial(raw: string): string {
  return raw.trim().toUpperCase();
}

function key(email: string, cameraId: string): string {
  return `${normEmail(email)}\0${normSerial(cameraId)}`;
}

export interface TrackOverride {
  email: string;
  cameraId: string;
  track: BiweeklyTrack;
  reason: string | null;
}

export function listTrackOverrides(): TrackOverride[] {
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT email, camera_id, track, reason
         FROM leaderboard_track_overrides
         ORDER BY email, camera_id`,
      )
      .all() as Array<{
      email: string;
      camera_id: string;
      track: string;
      reason: string | null;
    }>
  ).map((r) => ({
    email: r.email,
    cameraId: r.camera_id,
    track: r.track === "permanent" ? "permanent" : "checkout",
    reason: r.reason,
  }));
}

/** Move one person's score on one camera to the other board, or pass null to clear. */
export function setTrackOverride(
  actor: string,
  email: string,
  cameraId: string,
  track: BiweeklyTrack | null,
  reason?: string,
): { email: string; cameraId: string; track: BiweeklyTrack | null } {
  const e = normEmail(email);
  const cam = normSerial(cameraId);
  if (!e) throw new Error("email required");
  if (!cam) throw new Error("cameraId required");
  if (track && track !== "permanent" && track !== "checkout") {
    throw new Error("track must be 'permanent' or 'checkout'");
  }

  const db = getDb();

  if (!track) {
    db.prepare(
      `DELETE FROM leaderboard_track_overrides WHERE lower(email) = ? AND upper(camera_id) = ?`,
    ).run(e, cam);
    audit(actor, "leaderboard.track_override_clear", {
      entityType: "weekly_scores",
      entityId: `${e}:${cam}`,
    });
    return { email: e, cameraId: cam, track: null };
  }

  db.prepare(
    `INSERT INTO leaderboard_track_overrides (email, camera_id, track, reason, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email, camera_id) DO UPDATE SET
       track = excluded.track,
       reason = excluded.reason,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(e, cam, track, reason?.trim() || null, actor, nowISO());

  audit(actor, "leaderboard.track_override", {
    entityType: "weekly_scores",
    entityId: `${e}:${cam}`,
    newValue: { track, reason: reason?.trim() || null },
  });

  return { email: e, cameraId: cam, track };
}

/**
 * Which biweekly board a score row belongs on.
 *
 * Default is unchanged from before overrides existed — the person's permanent-holder roster
 * membership decides. An override only fires for the exact (person, camera) an admin has moved,
 * so a permanent holder who spent a period on a checkout camera can be scored on the checkout
 * board for that camera while their own camera stays on the permanent board.
 */
export function resolveRowTrack(
  email: string,
  cameraId: string | null,
  overrides: Map<string, BiweeklyTrack>,
): BiweeklyTrack {
  if (cameraId) {
    const override = overrides.get(key(email, cameraId));
    if (override) return override;
  }
  return isPermanentHolderEmail(email) ? "permanent" : "checkout";
}

export function loadTrackOverrideMap(): Map<string, BiweeklyTrack> {
  return new Map(listTrackOverrides().map((o) => [key(o.email, o.cameraId), o.track]));
}

/**
 * Every (person, camera) that actually has a score row, with the board it currently lands on.
 * This is what the admin picks from — it mirrors the rows on the boards rather than asking an
 * admin to type a serial from memory.
 */
export function listScoreRowTracks(): Array<{
  email: string;
  name: string;
  cameraId: string;
  totalPoints: number;
  track: BiweeklyTrack;
  overridden: boolean;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ws.email AS email, p.name AS name, ws.camera_id AS cameraId,
              SUM(ws.total_points) AS totalPoints
       FROM weekly_scores ws
       JOIN participants p ON lower(p.email) = lower(ws.email)
       WHERE ws.camera_id IS NOT NULL AND trim(ws.camera_id) != ''
       GROUP BY lower(ws.email), ws.camera_id
       ORDER BY p.name, ws.camera_id`,
    )
    .all() as Array<{
    email: string;
    name: string;
    cameraId: string;
    totalPoints: number;
  }>;

  const overrides = loadTrackOverrideMap();
  return rows.map((r) => ({
    email: r.email,
    name: r.name,
    cameraId: r.cameraId,
    totalPoints: Math.round(Number(r.totalPoints || 0) * 1000) / 1000,
    track: resolveRowTrack(r.email, r.cameraId, overrides),
    overridden: overrides.has(key(r.email, r.cameraId)),
  }));
}
