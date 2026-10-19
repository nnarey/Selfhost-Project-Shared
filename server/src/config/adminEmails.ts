import { getDb, nowISO } from "../db.js";

/** Same allowlist as web/src/config/admin.ts — Harbor SSO email must match. */
export const ADMIN_PARTICIPANTS = [
  { name: "Alice Chen", email: "alice@northline.example" },
  { name: "Bob Rivera", email: "bob@northline.example" },
  { name: "Cara Nguyen", email: "cara@northline.example" },
] as const;

export const ADMIN_EMAILS = ADMIN_PARTICIPANTS.map((a) => a.email);

export function isAdminEmail(email: string): boolean {
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

/** Keep the demo admins on the roster as approved participants and admins. */
export function ensureAdminParticipants(): { created: number; updated: number } {
  const db = getDb();
  const now = nowISO();
  let created = 0;
  let updated = 0;
  const select = db.prepare(`SELECT email, name, signup_status FROM participants WHERE email = ?`);
  const insert = db.prepare(
    `INSERT INTO participants (
      email, name, hub, signup_status, account_user_id, camera_id,
      enrolled_at, status, created_at, updated_at
    ) VALUES (?, ?, 'Phoenix', 'approved', NULL, NULL, ?, 'Active', ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE participants SET name = ?, signup_status = 'approved', status = 'Active', updated_at = ?
     WHERE email = ?`,
  );

  const tx = db.transaction(() => {
    for (const admin of ADMIN_PARTICIPANTS) {
      const email = admin.email.toLowerCase();
      const existing = select.get(email) as
        | { email: string; name: string; signup_status: string }
        | undefined;
      if (!existing) {
        insert.run(email, admin.name, now, now, now);
        created += 1;
        continue;
      }
      if (existing.signup_status !== "approved") {
        update.run(existing.name?.trim() || admin.name, now, email);
        updated += 1;
      }
    }
  });
  tx();
  return { created, updated };
}
