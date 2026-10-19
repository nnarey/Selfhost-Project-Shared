import { audit, getDb, nowISO } from "./db.js";

/**
 * Tombstones for admin-removed people.
 *
 * Participants are re-created automatically in several places — the permanent-holder roster is
 * re-seeded on every leaderboard load, and imports/Fleet sync backfill anyone they see an email
 * for. Without a tombstone an admin removal is undone almost immediately, which is why removed
 * people kept reappearing. Being registered against a camera in the agency again is the one signal
 * that they genuinely belong back on the roster, so that (and only that) clears the tombstone.
 */

function norm(email: string): string {
  return email.trim().toLowerCase();
}

export function listRemovedParticipants(): Array<{
  email: string;
  reason: string | null;
  removedBy: string;
  removedAt: string;
}> {
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT email, reason, removed_by AS removedBy, removed_at AS removedAt
         FROM removed_participants
         ORDER BY removed_at DESC`,
      )
      .all() as Array<{
      email: string;
      reason: string | null;
      removedBy: string;
      removedAt: string;
    }>
  );
}

export function loadRemovedEmails(): Set<string> {
  const db = getDb();
  return new Set(
    (db.prepare(`SELECT email FROM removed_participants`).all() as Array<{ email: string }>).map(
      (r) => norm(r.email),
    ),
  );
}

export function isParticipantRemoved(email: string): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT 1 AS hit FROM removed_participants WHERE email = ?`)
    .get(norm(email)) as { hit: number } | undefined;
  return Boolean(row);
}

export function suppressParticipants(actor: string, emails: string[], reason?: string): number {
  const db = getDb();
  const now = nowISO();
  const insert = db.prepare(
    `INSERT INTO removed_participants (email, reason, removed_by, removed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       reason = excluded.reason,
       removed_by = excluded.removed_by,
       removed_at = excluded.removed_at`,
  );
  let n = 0;
  const tx = db.transaction(() => {
    for (const email of emails) {
      const e = norm(email);
      if (!e) continue;
      insert.run(e, reason?.trim() || null, actor, now);
      n += 1;
    }
  });
  tx();
  return n;
}

/** Called when someone is registered against a camera again — they are back on the roster. */
export function clearParticipantRemoval(email: string, actor = "agency"): boolean {
  const db = getDb();
  const e = norm(email);
  const info = db.prepare(`DELETE FROM removed_participants WHERE email = ?`).run(e);
  if (info.changes > 0) {
    audit(actor, "participant.removal_cleared", {
      entityType: "participant",
      entityId: e,
    });
    return true;
  }
  return false;
}
