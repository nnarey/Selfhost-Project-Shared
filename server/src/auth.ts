import { createHash, randomBytes } from "node:crypto";
import { ENV } from "./env.js";
import { getDb, nowISO, audit } from "./db.js";
import { verifyPassword } from "./password.js";
import { accessStatusFrom, approveIfInAgency, type AccessStatus } from "./membership.js";
import { evidenceConfigured } from "./fleet/client.js";
import { isAdminEmail } from "./config/adminEmails.js";

function emailHash(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12);
}

export interface ParticipantLoginResult {
  email: string;
  name: string;
  role: "participant";
  photoUrl: string | null;
  emailHash: string;
  signupStatus: string;
  inAgency: boolean;
  accessStatus: AccessStatus;
}

export async function loadParticipantSession(email: string): Promise<ParticipantLoginResult> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Email required");

  const row = getDb()
    .prepare(
      `SELECT email, name, signup_status, photo_url FROM participants WHERE lower(email) = lower(?)`,
    )
    .get(normalized) as
    | {
        email: string;
        name: string;
        signup_status: string;
        photo_url: string | null;
      }
    | undefined;

  if (!row) {
    audit(normalized, "participant.login_failed", { reason: "not_found" });
    throw new Error("No account for this email");
  }

  if (row.signup_status === "rejected") {
    audit(normalized, "participant.login_failed", { reason: "rejected" });
    throw new Error("This registration was rejected. Contact an admin if that seems wrong.");
  }

  const membership = await approveIfInAgency(row.email, row.email);
  const fresh = getDb()
    .prepare(`SELECT email, name, signup_status, photo_url FROM participants WHERE email = ?`)
    .get(row.email) as {
    email: string;
    name: string;
    signup_status: string;
    photo_url: string | null;
  };

  const configured = evidenceConfigured();
  const inAgency = configured ? membership.inAgency : fresh.signup_status === "approved";
  const accessStatus = accessStatusFrom({
    signupStatus: fresh.signup_status,
    inAgency,
    evidenceConfigured: configured,
  });

  const name = (fresh.name || normalized.split("@")[0] || normalized).trim();
  audit(normalized, "participant.login", {
    newValue: { accessStatus, inAgency, signupStatus: fresh.signup_status, via: "identity" },
  });

  return {
    email: fresh.email.toLowerCase(),
    name,
    role: "participant",
    photoUrl: fresh.photo_url || null,
    emailHash: emailHash(fresh.email),
    signupStatus: fresh.signup_status,
    inAgency,
    accessStatus,
  };
}

/**
 * Per-user password (or legacy shared password). Pending sign-ups can log in
 * and check out; admin adds them to the Fleet agency outside this app.
 */
export async function loginParticipant(
  email: string,
  password: string,
): Promise<ParticipantLoginResult> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Email required");

  const row = getDb()
    .prepare(
      `SELECT email, signup_status, password_hash
       FROM participants WHERE lower(email) = lower(?)`,
    )
    .get(normalized) as
    | {
        email: string;
        signup_status: string;
        password_hash: string | null;
      }
    | undefined;

  if (!row) {
    audit(normalized, "participant.login_failed", { reason: "not_found" });
    throw new Error("Incorrect email or password");
  }

  if (row.signup_status === "rejected") {
    audit(normalized, "participant.login_failed", { reason: "rejected" });
    throw new Error("This registration was rejected. Contact an admin if that seems wrong.");
  }

  const ok = row.password_hash
    ? verifyPassword(password, row.password_hash)
    : password === ENV.adminPassword;

  if (!ok) {
    audit(normalized, "participant.login_failed", { reason: "bad_password" });
    throw new Error("Incorrect email or password");
  }

  const membership = await approveIfInAgency(row.email, row.email);
  if (!row.password_hash && !membership.inAgency && row.signup_status !== "approved") {
    audit(normalized, "participant.login_failed", { reason: "not_approved" });
    throw new Error("Incorrect email or password");
  }

  return loadParticipantSession(row.email);
}

export function issueAdminSession(email: string): { token: string; expiresAt: string; email: string } {
  const normalized = email.trim().toLowerCase();
  if (!normalized.endsWith("@northline.example")) {
    throw new Error("Admin login requires an @northline.example email");
  }
  if (!isAdminEmail(normalized)) {
    throw new Error("This email is not on the admin allowlist");
  }

  const token = randomBytes(32).toString("hex");
  const createdAt = nowISO();
  const expiresAt = new Date(
    Date.now() + ENV.adminSessionHours * 60 * 60 * 1000,
  ).toISOString();

  getDb()
    .prepare(
      `INSERT INTO admin_sessions (token, email, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    )
    .run(token, normalized, createdAt, expiresAt);

  audit(normalized, "admin.login", {});
  return { token, expiresAt, email: normalized };
}

export function loginAdmin(email: string, password: string): { token: string; expiresAt: string; email: string } {
  const normalized = email.trim().toLowerCase();
  if (password !== ENV.adminPassword) {
    audit(normalized || "unknown", "admin.login_failed", { reason: "bad_password" });
    throw new Error("Incorrect admin password");
  }
  return issueAdminSession(normalized);
}

export function loginAdminFromIdentity(email: string): { token: string; expiresAt: string; email: string } {
  return issueAdminSession(email);
}

export function requireAdmin(token: string | undefined | null): string {
  if (!token) throw new Error("Unauthorized");
  const row = getDb()
    .prepare(`SELECT email, expires_at FROM admin_sessions WHERE token = ?`)
    .get(token) as { email: string; expires_at: string } | undefined;
  if (!row) throw new Error("Unauthorized");
  if (new Date(row.expires_at).getTime() < Date.now()) {
    getDb().prepare(`DELETE FROM admin_sessions WHERE token = ?`).run(token);
    throw new Error("Session expired");
  }
  return row.email;
}

export function logoutAdmin(token: string | undefined | null): void {
  if (!token) return;
  const email = (() => {
    try {
      return requireAdmin(token);
    } catch {
      return "unknown";
    }
  })();
  getDb().prepare(`DELETE FROM admin_sessions WHERE token = ?`).run(token);
  audit(email, "admin.logout", {});
}
