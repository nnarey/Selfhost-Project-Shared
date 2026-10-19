import { getDb, nowISO } from "../db.js";
import { loadRemovedEmails } from "../removedParticipants.js";

/** Holders with assigned FieldCams — scored on the Permanent cameras leaderboard only. */
export const PERMANENT_HOLDERS: Array<{ name: string; email: string }> = [
  { name: "Alice Chen", email: "alice@northline.example" },
  { name: "Bob Rivera", email: "bob@northline.example" },
  { name: "Cara Nguyen", email: "cara@northline.example" },
  { name: "Devon Park", email: "devon@northline.example" },
  { name: "Elena Brooks", email: "elena@northline.example" },
  { name: "Frank Okonkwo", email: "frank@northline.example" },
  { name: "Grace Kim", email: "grace@northline.example" },
  { name: "Hank Morales", email: "hank@northline.example" },
];

export const PERMANENT_HOLDER_EMAILS = new Set(
  PERMANENT_HOLDERS.map((h) => h.email.toLowerCase()),
);

export function isPermanentHolderEmail(email: string | null | undefined): boolean {
  return PERMANENT_HOLDER_EMAILS.has(String(email || "").trim().toLowerCase());
}

export type LeaderboardTrack = "permanent" | "checkout" | "overall";

export function parseLeaderboardTrack(raw: unknown): LeaderboardTrack | undefined {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "permanent" || v === "checkout" || v === "overall") return v;
  return undefined;
}

/** Insert/approve the permanent-camera roster so they appear even before first activity. */
export function ensurePermanentHolders(): { created: number; updated: number } {
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

  // Re-seeding this roster on every leaderboard load is what used to undo an admin removal, so
  // anyone tombstoned stays off until a camera assignment brings them back.
  const removed = loadRemovedEmails();

  const tx = db.transaction(() => {
    for (const holder of PERMANENT_HOLDERS) {
      const email = holder.email.toLowerCase();
      if (removed.has(email)) continue;
      const handle = email.split("@")[0] || email;
      const existing = select.get(email) as
        | { email: string; name: string; signup_status: string }
        | undefined;
      if (!existing) {
        insert.run(email, holder.name, now, now, now);
        created += 1;
        continue;
      }
      const nameIsPlaceholder =
        !existing.name.trim() ||
        existing.name.toLowerCase() === email ||
        existing.name.toLowerCase() === handle;
      const needsApprove = existing.signup_status !== "approved";
      if (nameIsPlaceholder || needsApprove) {
        update.run(nameIsPlaceholder ? holder.name : existing.name, now, email);
        updated += 1;
      }
    }
  });
  tx();
  return { created, updated };
}
