import { getDb } from "./db.js";
import { evidenceConfigured } from "./fleet/client.js";

export type AccessStatus = "ready" | "awaiting_fleet" | "rejected" | "unknown";

export async function approveIfInAgency(
  email: string,
  _actor = "fleet-membership",
): Promise<{ email: string; inAgency: boolean; signupStatus: string }> {
  const normalized = email.trim().toLowerCase();
  const row = getDb()
    .prepare(`SELECT email, signup_status FROM participants WHERE email = ?`)
    .get(normalized) as { email: string; signup_status: string } | undefined;

  if (!row) {
    return { email: normalized, inAgency: false, signupStatus: "unknown" };
  }
  if (row.signup_status === "rejected") {
    return { email: row.email, inAgency: false, signupStatus: "rejected" };
  }
  // Agency add happens in Fleet, not in this app. Pending signups may still check out.
  return {
    email: row.email,
    inAgency: row.signup_status === "approved",
    signupStatus: row.signup_status,
  };
}

export function accessStatusFrom(opts: {
  signupStatus: string;
  inAgency: boolean;
  evidenceConfigured: boolean;
}): AccessStatus {
  if (opts.signupStatus === "rejected") return "rejected";
  if (opts.signupStatus === "pending" || opts.signupStatus === "approved" || opts.inAgency) {
    return "ready";
  }
  if (!opts.evidenceConfigured && opts.signupStatus === "approved") return "ready";
  return "unknown";
}

export { evidenceConfigured };
