import { getDb, nowISO, audit } from "./db.js";
import { loginParticipant } from "./auth.js";
import { hashPassword } from "./password.js";
import { parseRegistrationAnswers, type RegistrationAnswers } from "./registration.js";
import { clearParticipantRemoval, isParticipantRemoved } from "./removedParticipants.js";
import type { SignupStatus } from "./types.js";

const MIN_PASSWORD_LEN = 8;
const DISPLAY_NAME_MAX = 40;
const DISPLAY_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,39}$/u;

/** Display label: local-part of email (before @). */
export function emailHandle(email: string): string {
  const normalized = email.trim().toLowerCase();
  const local = normalized.split("@")[0] || normalized;
  return local;
}

/**
 * Public self-serve signup. Creates/updates a pending row with a password hash.
 * Pending means "add this person to the Fleet agency." Checkout is allowed immediately.
 */
export function signupParticipant(input: {
  email: string;
  name: string;
  password: string;
  hub?: string;
  registration?: unknown;
  /** Harbor/SSO signup — no second password. */
  skipPassword?: boolean;
}): { email: string; name: string; signupStatus: "pending" } {
  const email = input.email.trim().toLowerCase();
  if (!email.endsWith("@northline.example")) {
    throw new Error("Sign up requires an @northline.example email");
  }
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Name required");
  if (name.length > DISPLAY_NAME_MAX) {
    throw new Error(`Name must be ${DISPLAY_NAME_MAX} characters or fewer`);
  }
  if (!DISPLAY_NAME_RE.test(name)) {
    throw new Error(
      "Name may use letters, numbers, spaces, and . _ ' - (must start with a letter or number)",
    );
  }
  const password = String(input.password || "");
  if (!input.skipPassword && password.length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  const answers = parseRegistrationAnswers(input.registration);
  const hub = (input.hub || answers.location || "Phoenix").trim() || "Phoenix";
  const passwordHash = input.skipPassword ? null : hashPassword(password);
  const registrationJson = JSON.stringify(answers);
  const db = getDb();
  const now = nowISO();
  const existing = db
    .prepare(`SELECT email, signup_status FROM participants WHERE email = ?`)
    .get(email) as { email: string; signup_status: string } | undefined;

  if (existing?.signup_status === "approved") {
    throw new Error("This email is already registered. Log in instead.");
  }

  if (!existing) {
    db.prepare(
      `INSERT INTO participants (
        email, name, hub, signup_status, password_hash, registration_json, account_user_id, camera_id,
        enrolled_at, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, NULL, NULL, ?, 'Active', ?, ?)`,
    ).run(email, name, hub, passwordHash, registrationJson, now, now, now);
  } else {
    db.prepare(
      `UPDATE participants SET
        name = ?, hub = ?, signup_status = 'pending', password_hash = ?, registration_json = ?, updated_at = ?
       WHERE email = ?`,
    ).run(name, hub, passwordHash, registrationJson, now, email);
  }

  audit(email, "participant.signup", {
    entityType: "participant",
    entityId: email,
    newValue: { signupStatus: "pending", name, hub },
  });
  return { email, name, signupStatus: "pending" };
}

export function listParticipants(status?: SignupStatus | "all"): Array<{
  email: string;
  name: string;
  hub: string;
  signupStatus: string;
  hasPassword: boolean;
  enrolledAt: string;
  updatedAt: string;
  registration: RegistrationAnswers | null;
}> {
  const db = getDb();
  const rows =
    status && status !== "all"
      ? (db
          .prepare(
            `SELECT email, name, hub, signup_status, password_hash, registration_json, enrolled_at, updated_at
             FROM participants WHERE signup_status = ? ORDER BY updated_at DESC`,
          )
          .all(status) as Array<{
          email: string;
          name: string;
          hub: string;
          signup_status: string;
          password_hash: string | null;
          registration_json: string | null;
          enrolled_at: string;
          updated_at: string;
        }>)
      : (db
          .prepare(
            `SELECT email, name, hub, signup_status, password_hash, registration_json, enrolled_at, updated_at
             FROM participants ORDER BY updated_at DESC`,
          )
          .all() as Array<{
          email: string;
          name: string;
          hub: string;
          signup_status: string;
          password_hash: string | null;
          registration_json: string | null;
          enrolled_at: string;
          updated_at: string;
        }>);

  return rows.map((r) => {
    let registration: RegistrationAnswers | null = null;
    if (r.registration_json) {
      try {
        registration = JSON.parse(r.registration_json) as RegistrationAnswers;
      } catch {
        registration = null;
      }
    }
    return {
      email: r.email,
      name: r.name,
      hub: r.hub,
      signupStatus: r.signup_status,
      hasPassword: Boolean(r.password_hash),
      enrolledAt: r.enrolled_at,
      updatedAt: r.updated_at,
      registration,
    };
  });
}

export function setParticipantSignupStatus(
  actor: string,
  email: string,
  status: SignupStatus,
): { email: string; signupStatus: SignupStatus } {
  if (status !== "pending" && status !== "approved" && status !== "rejected") {
    throw new Error("Invalid signup status");
  }
  const normalized = email.trim().toLowerCase();
  const db = getDb();
  const existing = db
    .prepare(`SELECT email, signup_status FROM participants WHERE lower(email) = lower(?)`)
    .get(normalized) as { email: string; signup_status: string } | undefined;
  if (!existing) throw new Error("Participant not found");

  const now = nowISO();
  db.prepare(`UPDATE participants SET signup_status = ?, updated_at = ? WHERE email = ?`).run(
    status,
    now,
    existing.email,
  );
  audit(actor, "participant.signup_status", {
    entityType: "participant",
    entityId: existing.email,
    oldValue: { signupStatus: existing.signup_status },
    newValue: { signupStatus: status },
  });
  return { email: existing.email, signupStatus: status };
}

/** Ensure an approved participant row exists so Fleet owners / Splunk emails can score. */
export function ensureParticipant(
  email: string,
  opts: {
    cameraId?: string | null;
    accountUserId?: string | null;
    /**
     * True when this call comes from a real camera assignment (Fleet import or Evidence
     * ownership). That is the signal that an admin-removed person belongs back on the roster, so
     * it lifts their tombstone; anything else leaves a removed person removed.
     */
    viaAssignment?: boolean;
  } = {},
): string | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return null;

  if (isParticipantRemoved(normalized)) {
    if (!opts.viaAssignment) return null;
    clearParticipantRemoval(normalized);
  }

  const db = getDb();
  const now = nowISO();
  const handle = emailHandle(normalized);
  const existing = db
    .prepare(`SELECT email, signup_status FROM participants WHERE email = ?`)
    .get(normalized) as { email: string; signup_status: string } | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO participants (
        email, name, hub, signup_status, account_user_id, camera_id,
        enrolled_at, status, created_at, updated_at
      ) VALUES (?, ?, 'Phoenix', 'approved', ?, ?, ?, 'Active', ?, ?)`,
    ).run(
      normalized,
      handle,
      opts.accountUserId || null,
      opts.cameraId || null,
      now,
      now,
      now,
    );
    return normalized;
  }

  // Seen in Fleet: leave the "awaiting agency" list. Do not revive rejected.
  if (existing.signup_status === "pending") {
    db.prepare(
      `UPDATE participants SET
        signup_status = 'approved',
        camera_id = COALESCE(?, camera_id),
        account_user_id = COALESCE(?, account_user_id),
        updated_at = ?
       WHERE email = ?`,
    ).run(opts.cameraId ?? null, opts.accountUserId ?? null, now, normalized);
    audit("fleet-sync", "participant.in_agency", {
      entityType: "participant",
      entityId: normalized,
      oldValue: { signupStatus: "pending" },
      newValue: { signupStatus: "approved", source: "fleet" },
    });
    return normalized;
  }

  db.prepare(
    `UPDATE participants SET
      camera_id = COALESCE(?, camera_id),
      account_user_id = COALESCE(?, account_user_id),
      updated_at = ?
     WHERE email = ?`,
  ).run(opts.cameraId ?? null, opts.accountUserId ?? null, now, normalized);
  return normalized;
}

/** Backfill participants from assignment history + activity emails (cold-start). */
export function ensureParticipantsFromEvidenceAndActivity(): number {
  const db = getDb();
  // `viaAssignment` marks the rows that came from assignment_history — only those count as being
  // registered against a camera, so activity alone never resurrects an admin-removed person.
  const emails = db
    .prepare(
      `SELECT lower(email) AS email, camera_id, max(via_assignment) AS via_assignment FROM (
         SELECT email, camera_id, 1 AS via_assignment FROM assignment_history
           WHERE email IS NOT NULL AND trim(email) != ''
         UNION ALL
         SELECT email, camera_id, 0 AS via_assignment FROM activity_events
           WHERE email IS NOT NULL AND trim(email) != ''
       )
       GROUP BY lower(email), camera_id`,
    )
    .all() as Array<{ email: string; camera_id: string | null; via_assignment: number }>;

  let created = 0;
  for (const row of emails) {
    const before = db
      .prepare(`SELECT email FROM participants WHERE email = ?`)
      .get(row.email);
    ensureParticipant(row.email, {
      cameraId: row.camera_id,
      viaAssignment: row.via_assignment === 1,
    });
    if (!before) created += 1;
  }
  return created;
}

/**
 * Backfill blank names to email local-part only.
 * Does not clobber customized display names.
 */
export function syncParticipantHandlesFromEmail(): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT email, name FROM participants
       WHERE name IS NULL OR trim(name) = ''`,
    )
    .all() as Array<{ email: string; name: string | null }>;
  const upd = db.prepare(`UPDATE participants SET name = ?, updated_at = ? WHERE email = ?`);
  const now = nowISO();
  let n = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      upd.run(emailHandle(row.email), now, row.email);
      n += 1;
    }
  });
  tx();
  return n;
}

/** Validate + persist a participant-chosen display name. */
export async function updateParticipantDisplayName(
  email: string,
  password: string,
  displayName: string,
  alreadyAuthed?: { email: string },
): Promise<{ email: string; name: string }> {
  const session = alreadyAuthed ?? (await loginParticipant(email, password));
  const name = displayName.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Display name required");
  if (name.length > DISPLAY_NAME_MAX) {
    throw new Error(`Display name must be ${DISPLAY_NAME_MAX} characters or fewer`);
  }
  if (!DISPLAY_NAME_RE.test(name)) {
    throw new Error(
      "Display name may use letters, numbers, spaces, and . _ ' - (must start with a letter or number)",
    );
  }
  const now = nowISO();
  getDb()
    .prepare(`UPDATE participants SET name = ?, updated_at = ? WHERE lower(email) = lower(?)`)
    .run(name, now, session.email);
  audit(session.email, "participant.name_update", {
    entityType: "participant",
    entityId: session.email,
    newValue: { name },
  });
  return { email: session.email, name };
}

/**
 * Roster counts for the public landing page.
 *
 * "Enrolled" is the real participant roster (rejected signups excluded). "Active" is people with a
 * qualifying recording inside the inactivity window the reminders use, which is what the tile's
 * "not inactive" wording has always meant — participants.status is never moved off 'Active', so
 * counting that column would just repeat the enrolled number.
 */
export function getRosterSummary(inactivityHours = 24): { enrolled: number; active: number } {
  const db = getDb();
  const enrolled = (
    db
      .prepare(
        `SELECT count(*) AS c FROM participants WHERE lower(signup_status) != 'rejected'`,
      )
      .get() as { c: number }
  ).c;

  const since = new Date(Date.now() - inactivityHours * 60 * 60 * 1000).toISOString();
  const active = (
    db
      .prepare(
        `SELECT count(DISTINCT lower(a.email)) AS c
         FROM activity_events a
         JOIN participants p ON lower(p.email) = lower(a.email)
         WHERE lower(p.signup_status) != 'rejected'
           AND a.event_type = 'recording'
           AND upper(COALESCE(a.purpose, '')) = 'PURPOSE_STANDARD'
           AND lower(COALESCE(a.status, '')) = 'success'
           AND COALESCE(a.duration_seconds, 0) >= 30
           AND a.event_time_utc >= ?`,
      )
      .get(since) as { c: number }
  ).c;

  return { enrolled, active };
}
