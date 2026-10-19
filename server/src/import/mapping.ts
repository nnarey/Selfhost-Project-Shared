import { getDb, nowISO } from "../db.js";
import type { ColumnMapping } from "../types.js";

export const CANONICAL_ACTIVITY_FIELDS = [
  "event_id",
  "event_time_utc",
  "camera_id",
  "event_type",
  "source_event",
  "recording_source",
  "upload_transport",
  "duration_seconds",
  "purpose",
  "status",
  "avg_power_mw",
  "recording_resolution",
] as const;

export const CANONICAL_ASSIGNMENT_FIELDS = [
  "assignment_id",
  "camera_id",
  "email",
  "assigned_at_utc",
  "unassigned_at_utc",
  "source",
  "status",
] as const;

/** Default identity mapping for synthetic fixtures / already-canonical CSVs. */
export const DEFAULT_SPLUNK_MAPPING: ColumnMapping[] = CANONICAL_ACTIVITY_FIELDS.map((f) => ({
  sourceColumn: f,
  canonicalField: f,
}));

export const DEFAULT_FLEET_MAPPING: ColumnMapping[] = CANONICAL_ASSIGNMENT_FIELDS.map((f) => ({
  sourceColumn: f,
  canonicalField: f,
}));

function normHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .replace(/[()]/g, "")
    .trim();
}

/** Heuristic native Splunk-like aliases ready for real samples. */
export const NATIVE_SPLUNK_ALIASES: Record<string, string> = {
  event_id: "event_id",
  "stable event id": "event_id",
  "recording id": "event_id",
  recordingid: "event_id",
  _cd: "event_id",
  id: "event_id",
  event_time_utc: "event_time_utc",
  "event time": "event_time_utc",
  _time: "event_time_utc",
  timestamp: "event_time_utc",
  camera_id: "camera_id",
  "camera id": "camera_id",
  host: "camera_id",
  serial: "camera_id",
  event_type: "event_type",
  "event type": "event_type",
  type: "event_type",
  // Concrete Splunk Event name (RecordingStopped, UploadTelemetry, …)
  event: "source_event",
  source_event: "source_event",
  // What triggered the recording (POV_ATTACH, _BUTTON, _SIGNAL, …).
  // Splunk exports this as StartReason on stop rows; POV scoring reads it.
  startreason: "recording_source",
  "start reason": "recording_source",
  recording_source: "recording_source",
  "recording source": "recording_source",
  // Newer exports drop StartReason and emit a pov_state row with this flag instead.
  "pov recording": "recording_source",
  // Network path an upload took (TRANSPORT_DOCK, TRANSPORT_WIFI). Already
  // present in the export; without this it was dropped and upload success read as one blended
  // number over two very different paths.
  "upload transport": "upload_transport",
  uploadtransport: "upload_transport",
  upload_transport: "upload_transport",
  transport: "upload_transport",
  duration_seconds: "duration_seconds",
  "duration seconds": "duration_seconds",
  durationseconds: "duration_seconds",
  duration: "duration_seconds",
  recording_duration_seconds: "duration_seconds",
  purpose: "purpose",
  recording_purpose: "purpose",
  status: "status",
  result: "status",
  // Per-DVR-state power draw, in milliwatts. Carried only by `power` rows
  // (PowerStateChanged); the DVR state itself rides in `purpose`.
  "avg power mw": "avg_power_mw",
  avgpower: "avg_power_mw",
  "avg power": "avg_power_mw",
  avg_power_mw: "avg_power_mw",
  avgpowermw: "avg_power_mw",
  "power mw": "avg_power_mw",
  // Camera config on a power sample; draw is config-dependent so this must not be blended.
  "recording resolution": "recording_resolution",
  recordingresolution: "recording_resolution",
  recording_resolution: "recording_resolution",
  resolution: "recording_resolution",
};

export const NATIVE_FLEET_ALIASES: Record<string, string> = {
  assignment_id: "assignment_id",
  id: "assignment_id",
  camera_id: "camera_id",
  host: "camera_id",
  serial: "camera_id",
  device_id: "camera_id",
  email: "email",
  user_email: "email",
  assignee_email: "email",
  assigned_at_utc: "assigned_at_utc",
  assigned_at: "assigned_at_utc",
  start_time: "assigned_at_utc",
  unassigned_at_utc: "unassigned_at_utc",
  unassigned_at: "unassigned_at_utc",
  end_time: "unassigned_at_utc",
  source: "source",
  status: "status",
};

export function inferMapping(
  headers: string[],
  sourceKind: "splunk" | "fleet",
): ColumnMapping[] {
  const aliases = sourceKind === "splunk" ? NATIVE_SPLUNK_ALIASES : NATIVE_FLEET_ALIASES;
  const used = new Set<string>();
  const mappings: ColumnMapping[] = [];
  for (const header of headers) {
    const key = normHeader(header);
    const canonical = aliases[key] || aliases[header.trim().toLowerCase()];
    if (canonical && !used.has(canonical)) {
      mappings.push({ sourceColumn: header, canonicalField: canonical });
      used.add(canonical);
    }
  }
  return mappings;
}

/** Normalize unix-epoch seconds/ms or ISO strings to ISO UTC. */
export function normalizeTimestamp(value: string | undefined | null): string {
  const raw = (value || "").trim();
  if (!raw) return "";
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return raw;
}

export function applyMapping(
  row: Record<string, string>,
  mappings: ColumnMapping[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of mappings) {
    if (row[m.sourceColumn] != null) out[m.canonicalField] = row[m.sourceColumn];
  }
  if (out.event_time_utc) out.event_time_utc = normalizeTimestamp(out.event_time_utc);
  if (out.assigned_at_utc) out.assigned_at_utc = normalizeTimestamp(out.assigned_at_utc);
  if (out.unassigned_at_utc) out.unassigned_at_utc = normalizeTimestamp(out.unassigned_at_utc);
  if (out.event_type) out.event_type = out.event_type.trim().toLowerCase();
  // "POV Recording" arrives as true/false. Scoring matches recording_source on the substring POV.
  if ((out.recording_source || "").trim().toLowerCase() === "true") {
    out.recording_source = "POV";
  } else if ((out.recording_source || "").trim().toLowerCase() === "false") {
    out.recording_source = "";
  }
  // Start/Stop (and other pairs) share Stable Event ID — make row IDs unique per Event.
  const baseId = (out.event_id || "").trim();
  const sourceEvent = (out.source_event || "").trim();
  if (baseId && sourceEvent && !baseId.includes("|")) {
    out.event_id = `${baseId}|${sourceEvent}`;
  }
  return out;
}

export function ensureDefaultMappingProfiles(): void {
  const db = getDb();
  const now = nowISO();
  const upsert = db.prepare(
    `INSERT INTO mapping_profiles (id, name, source_kind, version, mappings_json, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mappings_json = excluded.mappings_json,
       updated_at = excluded.updated_at`,
  );
  upsert.run(
    "canonical-splunk",
    "Canonical Splunk events",
    "splunk",
    JSON.stringify(DEFAULT_SPLUNK_MAPPING),
    now,
    now,
  );
  upsert.run(
    "canonical-fleet",
    "Canonical Fleet assignments",
    "fleet",
    JSON.stringify(DEFAULT_FLEET_MAPPING),
    now,
    now,
  );
}

export function listMappingProfiles() {
  return getDb()
    .prepare(`SELECT id, name, source_kind, version, mappings_json, updated_at FROM mapping_profiles`)
    .all()
    .map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row.id),
        name: String(row.name),
        sourceKind: String(row.source_kind),
        version: Number(row.version),
        mappings: JSON.parse(String(row.mappings_json)) as ColumnMapping[],
        updatedAt: String(row.updated_at),
      };
    });
}

export function saveMappingProfile(
  id: string,
  name: string,
  sourceKind: "splunk" | "fleet",
  mappings: ColumnMapping[],
) {
  const db = getDb();
  const now = nowISO();
  const existing = db.prepare(`SELECT version FROM mapping_profiles WHERE id = ?`).get(id) as
    | { version: number }
    | undefined;
  if (existing) {
    db.prepare(
      `UPDATE mapping_profiles SET name = ?, mappings_json = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    ).run(name, JSON.stringify(mappings), now, id);
  } else {
    db.prepare(
      `INSERT INTO mapping_profiles (id, name, source_kind, version, mappings_json, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    ).run(id, name, sourceKind, JSON.stringify(mappings), now, now);
  }
  return listMappingProfiles().find((p) => p.id === id);
}
