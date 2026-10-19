import type { Request } from "express";
import { ENV } from "./env.js";

export interface HarborIdentity {
  email: string;
  name: string;
}

const EMAIL_HEADERS = ["x-harbor-user-email", "x-user-email"];
const NAME_HEADERS = ["x-harbor-user-name", "x-user-name"];

function header(req: Request, names: string[]): string {
  for (const name of names) {
    const raw = req.header(name);
    if (raw?.trim()) return raw.trim();
  }
  return "";
}

/** SSO/Harbor identity, or the laptop LOCAL_DEV_IDENTITY when Harbor trust is off. */
export function harborIdentityFrom(req: Request): HarborIdentity | null {
  if (ENV.harborTrustIdentity) {
    const email = header(req, EMAIL_HEADERS).toLowerCase();
    if (!email.includes("@")) return null;
    const name = header(req, NAME_HEADERS);
    return { email, name };
  }
  const email = ENV.localDevIdentity.trim().toLowerCase();
  if (!email.includes("@")) return null;
  return { email, name: "Local" };
}

export function harborEmailMatches(req: Request, email: string): boolean {
  const id = harborIdentityFrom(req);
  if (!id) return false;
  return id.email === email.trim().toLowerCase();
}
