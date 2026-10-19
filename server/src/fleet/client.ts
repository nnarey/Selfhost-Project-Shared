import { ENV } from "../env.js";
import type { EvidenceAgencyInfo, FleetDevice } from "./types.js";

interface TokenCache {
  accessToken: string;
  expiresAtMs: number;
}

let tokenCache: TokenCache | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function dig(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[key];
  }
  return cur;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

export function evidenceConfigured(): boolean {
  if (!ENV.fleetEnabled || ENV.fleetMode === "off") return false;
  return Boolean(
    ENV.fleetBaseUrl &&
      ENV.fleetAgencyId &&
      ENV.fleetClientId &&
      ENV.fleetClientSecret,
  );
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(
      `Fleet API ${res.status} ${res.statusText}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body;
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAtMs > Date.now() + 30_000) {
    return tokenCache.accessToken;
  }
  const tokenUrl =
    ENV.fleetTokenUrl ||
    `${ENV.fleetBaseUrl.replace(/\/$/, "")}/api/oauth2/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    partner_id: ENV.fleetAgencyId,
    client_id: ENV.fleetClientId,
    client_secret: ENV.fleetClientSecret,
  });

  const json = asRecord(
    await fetchJson(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    }),
  );
  const accessToken = firstString(json?.access_token, json?.accessToken);
  if (!accessToken) throw new Error("Evidence token response missing access_token");
  const expiresIn = Number(json?.expires_in || 3600);
  tokenCache = {
    accessToken,
    expiresAtMs: Date.now() + Math.max(60, expiresIn) * 1000,
  };
  return accessToken;
}

function normalizeDevice(raw: unknown): FleetDevice | null {
  const rec = asRecord(raw);
  if (!rec) return null;

  const attrs = asRecord(rec.attributes) || rec;
  const cameraId = firstString(
    dig(rec, ["attributes", "serial"]),
    dig(rec, ["attributes", "serial_number"]),
    dig(rec, ["attributes", "device_serial"]),
    dig(rec, ["serial"]),
    dig(rec, ["serial_number"]),
    dig(rec, ["id"]),
    dig(rec, ["device_id"]),
  );
  if (!cameraId) return null;

  const model = firstString(
    dig(rec, ["attributes", "model"]),
    dig(rec, ["attributes", "device_model"]),
    dig(rec, ["model"]),
    dig(rec, ["type"]),
  );

  const label = firstString(
    dig(rec, ["attributes", "name"]),
    dig(rec, ["attributes", "label"]),
    dig(rec, ["name"]),
    dig(rec, ["label"]),
  );

  const ownerId = firstString(
    dig(rec, ["relationships", "owner", "data", "id"]),
    dig(rec, ["relationships", "assignee", "data", "id"]),
    dig(rec, ["owner", "id"]),
    dig(rec, ["owner_id"]),
    dig(rec, ["assignee_id"]),
    dig(attrs, ["owner_id"]),
  );

  const ownerEmail = firstString(
    dig(rec, ["relationships", "owner", "data", "email"]),
    dig(rec, ["owner", "email"]),
    dig(rec, ["owner_email"]),
    dig(attrs, ["owner_email"]),
  );

  const assignedAt = firstString(
    dig(rec, ["attributes", "assigned_at"]),
    dig(rec, ["attributes", "assigned_on"]),
    dig(rec, ["assigned_at"]),
    dig(rec, ["assignment_date"]),
  );

  const deviceAgencyId = firstString(
    dig(rec, ["relationships", "agency", "data", "id"]),
    dig(rec, ["agency", "id"]),
    dig(attrs, ["agency_id"]),
  );

  return {
    cameraId,
    model,
    label,
    agencyId: deviceAgencyId,
    owner: ownerId || ownerEmail
      ? {
          id: ownerId || ownerEmail || "",
          email: ownerEmail,
          assignedAtUtc: assignedAt,
        }
      : null,
    raw,
  };
}

function extractDeviceList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const rec = asRecord(payload);
  if (!rec) return [];
  if (Array.isArray(rec.data)) return rec.data;
  if (Array.isArray(rec.devices)) return rec.devices;
  if (Array.isArray(rec.results)) return rec.results;
  if (Array.isArray(rec.items)) return rec.items;
  const nested = asRecord(rec.data);
  if (nested) {
    if (Array.isArray(nested.items)) return nested.items;
    if (Array.isArray(nested.devices)) return nested.devices;
    if (Array.isArray(nested.results)) return nested.results;
    if (Array.isArray(nested.data)) return nested.data;
  }
  // JSON:API sometimes nests included resources separately; keep empty but log shape.
  return [];
}

export async function fetchEvidenceAgency(): Promise<EvidenceAgencyInfo> {
  if (!evidenceConfigured()) {
    throw new Error("Fleet API is not configured");
  }
  const token = await getAccessToken();
  const base = ENV.fleetBaseUrl.replace(/\/$/, "");
  const agencyId = ENV.fleetAgencyId;
  const payload = await fetchJson(`${base}/api/v1/agencies/${encodeURIComponent(agencyId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const rec = asRecord(payload);
  const data = asRecord(rec?.data) || rec;
  const attrs = asRecord(data?.attributes) || data;
  return {
    id: firstString(data?.id, attrs?.id, agencyId) || agencyId,
    name: firstString(attrs?.name, attrs?.agency_name, data?.name),
    domain: firstString(attrs?.domain, attrs?.subdomain, attrs?.hostname),
  };
}

function nextPageUrl(payload: unknown, currentUrl: string): string | null {
  const rec = asRecord(payload);
  const links = asRecord(rec?.links);
  const next = firstString(links?.next, dig(links, ["next", "href"]));
  if (!next) return null;
  try {
    return new URL(next, currentUrl).toString();
  } catch {
    return null;
  }
}

export async function fetchFleetDevices(): Promise<FleetDevice[]> {
  if (!evidenceConfigured()) {
    throw new Error("Fleet API is not configured");
  }
  const token = await getAccessToken();
  const base = ENV.fleetBaseUrl.replace(/\/$/, "");
  const agencyId = ENV.fleetAgencyId;
  const start = new URL(`${base}/api/v1/agencies/${encodeURIComponent(agencyId)}/devices`);
  // Only narrow server-side for a single model; the API takes one value, and asking it for a
  // comma-joined list returns nothing. Multi-model allowlists are filtered in sync.ts instead.
  if (ENV.fleetDeviceModels.length === 1) {
    start.searchParams.set("model", ENV.fleetDeviceModels[0]);
  }
  if (ENV.fleetDeviceQuery) {
    for (const part of ENV.fleetDeviceQuery.split("&")) {
      const [k, v] = part.split("=");
      if (k && v != null) start.searchParams.set(decodeURIComponent(k), decodeURIComponent(v));
    }
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const rawItems: unknown[] = [];
  let pageUrl: string | null = start.toString();
  for (let page = 0; page < 50 && pageUrl; page++) {
    const payload = await fetchJson(pageUrl, { headers });
    const list = extractDeviceList(payload);
    rawItems.push(...list);
    pageUrl = nextPageUrl(payload, pageUrl);
    if (!list.length) break;
  }

  if (!rawItems.length) {
    console.warn(`Fleet devices response had 0 items. URL=${start.toString()}`);
  }

  const devices = rawItems
    .map(normalizeDevice)
    .filter((d): d is FleetDevice => Boolean(d))
    .filter((d) => !d.agencyId || d.agencyId.toLowerCase() === agencyId.toLowerCase());

  return devices;
}

export async function fetchEvidenceUserEmail(ownerId: string): Promise<string | null> {
  if (!evidenceConfigured() || !ownerId) return null;
  if (ownerId.includes("@")) return ownerId.toLowerCase();
  const token = await getAccessToken();
  const base = ENV.fleetBaseUrl.replace(/\/$/, "");
  const agencyId = encodeURIComponent(ENV.fleetAgencyId);
  const url = `${base}/api/v1/agencies/${agencyId}/users/${encodeURIComponent(ownerId)}`;
  try {
    const payload = await fetchJson(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    const rec = asRecord(payload);
    const data = asRecord(rec?.data) || rec;
    const attrs = asRecord(data?.attributes) || data;
    return firstString(
      dig(attrs, ["email"]),
      dig(data, ["email"]),
      dig(rec, ["email"]),
    )?.toLowerCase() || null;
  } catch {
    return null;
  }
}
