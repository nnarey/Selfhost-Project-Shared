// PHASE 2 — Google Apps Script HTTP client.
// Set VITE_APPS_SCRIPT_URL in web/.env.local to enable Sheets mode.
//
// In Vite dev, requests go to `/apps-script` (proxied) to avoid CORS.
// Deploy the web app as "Anyone" (Execute as: Me) so the proxy can call it
// without Google login cookies — URL secrecy + @northline.example app login is the gate.

import { ValidationError } from "./dataSource";

const APPS_SCRIPT_URL = import.meta.env.VITE_APPS_SCRIPT_URL as string | undefined;

export function isSheetsConfigured(): boolean {
  return Boolean(APPS_SCRIPT_URL?.trim());
}

export function getAppsScriptUrl(): string | undefined {
  return APPS_SCRIPT_URL?.trim() || undefined;
}

/** Browser-facing base URL (proxied in dev). */
function assertUrl(): string {
  if (!getAppsScriptUrl()) throw new Error("VITE_APPS_SCRIPT_URL is not set");
  if (import.meta.env.DEV) return "/apps-script";
  return getAppsScriptUrl()!;
}

function throwIfError(data: unknown): void {
  if (data && typeof data === "object" && "error" in data) {
    const msg = String((data as { error: unknown }).error);
    throw new ValidationError("SHEETS", humanizeSheetsError(msg));
  }
}

function humanizeSheetsError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("bad_credentials")) return "Incorrect email or password.";
  if (lower.includes("bad_admin")) {
    return "Admin login requires an allowlisted @northline.example email and the admin password.";
  }
  if (lower.includes("unauthorized")) return "Admin authorization failed.";
  return msg;
}

async function parseJsonResponse<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status}`);
  }
  // Login / auth HTML pages sometimes come back when access is too restrictive.
  if (text.trim().startsWith("<") || text.includes("Sign in") || text.includes("ServiceLogin")) {
    throw new Error(
      "Apps Script requires Northline Google login. Keep Who has access = Anyone within Northline, then set APPS_SCRIPT_COOKIE in web/.env.local (see .env.example) and restart Vite.",
    );
  }
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned non-JSON. Check the deployment URL.`);
  }
  throwIfError(data);
  return data;
}

export async function sheetsGet<T>(action: string): Promise<T> {
  const base = assertUrl();
  const url = `${base}?action=${encodeURIComponent(action)}`;
  const res = await fetch(url, { method: "GET" });
  return parseJsonResponse<T>(res, `Sheets GET ${action}`);
}

export async function sheetsPost<T>(body: Record<string, unknown>): Promise<T> {
  const base = assertUrl();
  const res = await fetch(base, {
    method: "POST",
    // text/plain avoids a CORS preflight when not using the proxy
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  return parseJsonResponse<T>(res, `Sheets POST ${String(body.action)}`);
}
