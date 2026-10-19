import { ADMIN_PASSWORD, isAdminEmail } from "../config/admin";

export type SessionRole = "participant" | "admin";

export interface Session {
  email: string;
  name: string;
  role: SessionRole;
  /** Present for admin sessions — used for Apps Script requireAdmin_ posts. */
  adminPassword?: string;
  /**
   * Laptop sessions only: retained so My Profile can upload a photo without re-prompting.
   * Same shared password used at participant login.
   */
  password?: string;
  /** Relative API path e.g. /api/avatars/….jpg when set. */
  photoUrl?: string | null;
  /** Matches leaderboard `emailHash` for profile row lookup after rename. */
  emailHash?: string;
  signupStatus?: string;
  accessStatus?: string;
  /** Signed in via Harbor/SSO — no app password. */
  harborSso?: boolean;
  /** Allowlisted admins who also compete (Alice / Bob / Cara). */
  isAdmin?: boolean;
  isParticipant?: boolean;
}

const SESSION_KEY = "fieldcam_session_v1";

export function readSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function writeSession(session: Session): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

export function adminCredentialsValid(email: string, password: string): boolean {
  return isAdminEmail(email) && password === ADMIN_PASSWORD;
}
