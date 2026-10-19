import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { audit, getDb, nowISO } from "../db.js";
import { ENV } from "../env.js";
import { isPermanentHolderEmail } from "../config/permanentHolders.js";
import { ensureParticipant } from "../participants.js";
import { weekStartUtcISO } from "../week.js";
import {
  evidenceConfigured,
  fetchEvidenceAgency,
  fetchFleetDevices,
  fetchEvidenceUserEmail,
} from "./client.js";
import { mockFleetDevices } from "./mock.js";
import type { FleetDevice, EvidenceSyncResult } from "./types.js";

/** Start of the import attribution window (previous Phoenix week Monday). */
function attributionWindowStartUtc(asOf = new Date()): string {
  const openWeek = weekStartUtcISO(asOf);
  return weekStartUtcISO(new Date(new Date(openWeek).getTime() - 12 * 60 * 60 * 1000));
}

/**
 * Fleet often omits true assigned_at. Cold-start open intervals created at poll time
 * cannot attribute earlier Splunk events — backdate open Fleet rows to the 2-week window start
 * when they begin after that window (and API did not supply an earlier assigned_at).
 */
export function backfillOpenAssignmentStarts(actor = "evidence-sync"): number {
  const db = getDb();
  const windowStart = attributionWindowStartUtc();
  const result = db
    .prepare(
      `UPDATE assignment_history
       SET assigned_at_utc = ?
       WHERE source = 'fleet'
         AND status = 'open'
         AND unassigned_at_utc IS NULL
         AND assigned_at_utc > ?`,
    )
    .run(windowStart, windowStart);
  const changed = Number(result.changes || 0);
  if (changed > 0) {
    audit(actor, "evidence.assignment.backfill_starts", {
      newValue: { windowStart, changed },
      reason: "Cold-start attribution: Fleet API had no historical assigned_at",
    });
  }
  return changed;
}

function assignmentId(cameraId: string, email: string, assignedAtUtc: string): string {
  return createHash("sha256")
    .update(`fleet|${cameraId}|${email}|${assignedAtUtc}`)
    .digest("hex")
    .slice(0, 32);
}

function parseOwnerMap(): Record<string, string> {
  const raw = ENV.fleetOwnerEmailMap.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k && v) out[k.trim()] = String(v).trim().toLowerCase();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Exact match, and fail closed on a missing model. The agency device list also returns docks
 * (`fieldcam_4_dock_*`) and older cameras; Fleet names whoever registered the hardware as its
 * owner, so anything that slips through here surfaces as a phantom camera checkout for that person.
 */
function modelMatches(model: string | null | undefined, allowed: Set<string>): boolean {
  return allowed.has(String(model || "").trim().toLowerCase());
}

async function resolveOwnerEmail(
  device: FleetDevice,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const owner = device.owner;
  if (!owner) return null;
  if (owner.email?.includes("@")) return owner.email.toLowerCase();

  const map = parseOwnerMap();
  if (owner.id && map[owner.id]) return map[owner.id];

  if (owner.id?.includes("@")) return owner.id.toLowerCase();

  const db = getDb();
  if (owner.id) {
    const byAccount = db
      .prepare(`SELECT email FROM participants WHERE account_user_id = ?`)
      .get(owner.id) as { email: string } | undefined;
    if (byAccount?.email) return byAccount.email.toLowerCase();
  }

  if (!owner.id) return null;
  if (cache.has(owner.id)) return cache.get(owner.id) || null;

  let email: string | null = null;
  if (ENV.fleetMode === "live" && evidenceConfigured()) {
    email = await fetchEvidenceUserEmail(owner.id);
  }
  cache.set(owner.id, email);
  if (email && owner.id) {
    // remember mapping for later offline resolution
    db.prepare(
      `INSERT INTO sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(`fleet_owner:${owner.id}`, email);
  } else if (owner.id) {
    const remembered = db
      .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
      .get(`fleet_owner:${owner.id}`) as { value: string } | undefined;
    if (remembered?.value) {
      cache.set(owner.id, remembered.value);
      return remembered.value;
    }
  }
  return email;
}

function setMeta(key: string, value: string) {
  getDb()
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

export function getEvidenceSyncStatus() {
  const db = getDb();
  const last = db.prepare(`SELECT value FROM sync_meta WHERE key = 'fleet_last_sync'`).get() as
    | { value: string }
    | undefined;
  const lastResult = db
    .prepare(`SELECT value FROM sync_meta WHERE key = 'fleet_last_result'`)
    .get() as { value: string } | undefined;
  return {
    enabled: ENV.fleetEnabled,
    mode: ENV.fleetMode,
    configured: evidenceConfigured(),
    pollSeconds: ENV.fleetPollSeconds,
    modelFilter: ENV.fleetDeviceModels.join(","),
    lastSyncAt: last?.value || null,
    lastResult: lastResult?.value ? JSON.parse(lastResult.value) : null,
  };
}

function pruneCamerasNotInAgency(keepCameraIds: string[], now: string): number {
  const db = getDb();
  const keep = [...new Set(keepCameraIds.map((id) => id.trim()).filter(Boolean))];
  if (!keep.length) return 0;
  const placeholders = keep.map(() => "?").join(",");
  const extra = db
    .prepare(`SELECT camera_id FROM cameras WHERE camera_id NOT IN (${placeholders})`)
    .all(...keep) as Array<{ camera_id: string }>;
  if (!extra.length) return 0;

  const extraIds = extra.map((r) => r.camera_id);
  const extraPh = extraIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE assignment_history
     SET unassigned_at_utc = ?, status = 'closed'
     WHERE camera_id IN (${extraPh}) AND status = 'open' AND unassigned_at_utc IS NULL`,
  ).run(now, ...extraIds);
  db.prepare(`UPDATE participants SET camera_id = NULL, updated_at = ? WHERE camera_id IN (${extraPh})`).run(
    now,
    ...extraIds,
  );
  db.prepare(`DELETE FROM cameras WHERE camera_id IN (${extraPh})`).run(...extraIds);
  db.prepare(
    `DELETE FROM weekly_scores
     WHERE camera_id IS NOT NULL AND trim(camera_id) != ''
       AND camera_id NOT IN (SELECT camera_id FROM cameras)`,
  ).run();

  const stale = db
    .prepare(
      `SELECT email FROM participants
       WHERE camera_id IS NULL
         AND email NOT IN (
           SELECT email FROM assignment_history
           WHERE status = 'open' AND unassigned_at_utc IS NULL
         )`,
    )
    .all() as Array<{ email: string }>;
  for (const row of stale) {
    if (isPermanentHolderEmail(row.email)) continue;
    db.prepare(`DELETE FROM weekly_scores WHERE lower(email) = lower(?)`).run(row.email);
    db.prepare(`DELETE FROM daily_activity WHERE lower(email) = lower(?)`).run(row.email);
    db.prepare(`DELETE FROM participants WHERE lower(email) = lower(?)`).run(row.email);
  }
  return extraIds.length;
}

export async function syncFleetOwnership(
  actor = "evidence-sync",
): Promise<EvidenceSyncResult> {
  const polledAt = nowISO();
  const result: EvidenceSyncResult = {
    mode: ENV.fleetMode,
    polledAt,
    devicesSeen: 0,
    fieldcamDevices: 0,
    opened: 0,
    closed: 0,
    unchanged: 0,
    unresolvedOwners: 0,
    prunedCameras: 0,
    errors: [],
  };

  if (!ENV.fleetEnabled) {
    result.mode = "disabled";
    return result;
  }

  let devices: FleetDevice[] = [];
  try {
    if (ENV.fleetMode === "mock") {
      devices = mockFleetDevices();
    } else if (ENV.fleetMode === "live") {
      if (!evidenceConfigured()) {
        throw new Error(
          "FLEET_MODE=live but base URL / agency / client credentials are missing",
        );
      }
      const agency = await fetchEvidenceAgency();
      result.agencyName = agency.name;
      result.agencyDomain = agency.domain;
      if (agency.id && agency.id.toLowerCase() !== ENV.fleetAgencyId.toLowerCase()) {
        throw new Error(
          `Fleet agency mismatch: configured ${ENV.fleetAgencyId} but API returned ${agency.id} (${agency.name || "unnamed"})`,
        );
      }
      const domain = String(agency.domain || "").toLowerCase();
      if (domain && !domain.includes("demo-agency")) {
        throw new Error(
          `Fleet agency domain is ${agency.domain}, expected fleet.northline.example`,
        );
      }
      devices = await fetchFleetDevices();
    } else {
      result.mode = "disabled";
      return result;
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    setMeta("fleet_last_sync", polledAt);
    setMeta("fleet_last_result", JSON.stringify(result));
    audit(actor, "evidence.sync.error", { newValue: result });
    return result;
  }

  result.devicesSeen = devices.length;
  const allowed = new Set(ENV.fleetDeviceModels);
  const fieldcam: FleetDevice[] = [];
  const skippedModels: Record<string, number> = {};
  for (const device of devices) {
    if (modelMatches(device.model, allowed)) {
      fieldcam.push(device);
      continue;
    }
    const key = String(device.model || "").trim() || "(no model)";
    skippedModels[key] = (skippedModels[key] || 0) + 1;
  }
  result.fieldcamDevices = fieldcam.length;
  if (Object.keys(skippedModels).length) result.skippedModels = skippedModels;

  const db = getDb();
  const ownerCache = new Map<string, string | null>();
  const now = polledAt;

  const openRows = db
    .prepare(
      `SELECT assignment_id, camera_id, email, assigned_at_utc
       FROM assignment_history
       WHERE status = 'open' AND unassigned_at_utc IS NULL
         AND source IN ('fleet')`,
    )
    .all() as Array<{
    assignment_id: string;
    camera_id: string;
    email: string;
    assigned_at_utc: string;
  }>;
  const openByCamera = new Map(openRows.map((r) => [r.camera_id, r]));

  const upsertCamera = db.prepare(
    `INSERT INTO cameras (camera_id, label, created_at) VALUES (?, ?, ?)
     ON CONFLICT(camera_id) DO UPDATE SET label = COALESCE(excluded.label, cameras.label)`,
  );
  const closeAssign = db.prepare(
    `UPDATE assignment_history
     SET unassigned_at_utc = ?, status = 'closed'
     WHERE assignment_id = ?`,
  );
  const openAssign = db.prepare(
    `INSERT INTO assignment_history (
      assignment_id, camera_id, email, assigned_at_utc, unassigned_at_utc,
      source, status, import_batch_id, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'fleet', 'open', NULL, ?)
    ON CONFLICT(assignment_id) DO UPDATE SET
      camera_id = excluded.camera_id,
      email = excluded.email,
      assigned_at_utc = excluded.assigned_at_utc,
      unassigned_at_utc = NULL,
      source = 'fleet',
      status = 'open'`,
  );
  const setParticipantCamera = db.prepare(
    `UPDATE participants SET camera_id = ?, updated_at = ? WHERE email = ?`,
  );

  const tx = db.transaction(() => {
    for (const device of fieldcam) {
      upsertCamera.run(device.cameraId, device.label || null, now);
    }
  });
  tx();

  for (const device of fieldcam) {
    try {
      const email = await resolveOwnerEmail(device, ownerCache);
      const current = openByCamera.get(device.cameraId);

      if (!email) {
        if (device.owner?.id) result.unresolvedOwners += 1;
        if (current) {
          closeAssign.run(now, current.assignment_id);
          db.prepare(
            `UPDATE participants SET camera_id = NULL, updated_at = ? WHERE camera_id = ?`,
          ).run(now, device.cameraId);
          result.closed += 1;
          openByCamera.delete(device.cameraId);
          audit(actor, "evidence.assignment.close", {
            entityType: "assignment",
            entityId: current.assignment_id,
            oldValue: current,
            newValue: { cameraId: device.cameraId, reason: "no_owner" },
          });
        } else {
          result.unchanged += 1;
        }
        continue;
      }

      if (current && current.email.toLowerCase() === email) {
        ensureParticipant(email, {
        viaAssignment: true,
          cameraId: device.cameraId,
          accountUserId: device.owner?.id || null,
        });
        setParticipantCamera.run(device.cameraId, now, email);
        result.unchanged += 1;
        continue;
      }

      if (current) {
        closeAssign.run(now, current.assignment_id);
        result.closed += 1;
        audit(actor, "evidence.assignment.close", {
          entityType: "assignment",
          entityId: current.assignment_id,
          oldValue: current,
          newValue: { cameraId: device.cameraId, nextEmail: email },
        });
      }

      const apiAssigned =
        device.owner?.assignedAtUtc && !Number.isNaN(Date.parse(device.owner.assignedAtUtc))
          ? new Date(device.owner.assignedAtUtc).toISOString()
          : null;
      // Without API assigned_at, open at the 2-week attribution window so recent Splunk
      // activity can map to the current Fleet owner (cold-start). Owner *changes*
      // still get `now` via apiAssigned when Evidence provides it; otherwise now.
      const assignedAt = apiAssigned || (current ? now : attributionWindowStartUtc(new Date(now)));
      const id = assignmentId(device.cameraId, email, assignedAt);
      openAssign.run(id, device.cameraId, email, assignedAt, now);
      ensureParticipant(email, {
        viaAssignment: true,
        cameraId: device.cameraId,
        accountUserId: device.owner?.id || null,
      });
      // ensure prior holder no longer shows this camera
      db.prepare(
        `UPDATE participants SET camera_id = NULL, updated_at = ?
         WHERE camera_id = ? AND lower(email) != lower(?)`,
      ).run(now, device.cameraId, email);
      setParticipantCamera.run(device.cameraId, now, email);
      result.opened += 1;
      openByCamera.set(device.cameraId, {
        assignment_id: id,
        camera_id: device.cameraId,
        email,
        assigned_at_utc: assignedAt,
      });
      audit(actor, "evidence.assignment.open", {
        entityType: "assignment",
        entityId: id,
        newValue: { cameraId: device.cameraId, email, assignedAt },
      });

      // Close provisional QR rows for this camera when Evidence confirms
      db.prepare(
        `UPDATE assignment_history
         SET unassigned_at_utc = ?, status = 'closed'
         WHERE camera_id = ? AND source = 'QR' AND status = 'open' AND unassigned_at_utc IS NULL`,
      ).run(now, device.cameraId);
    } catch (err) {
      result.errors.push(
        `${device.cameraId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const backfilled = backfillOpenAssignmentStarts(actor);
  if (backfilled > 0) {
    (result as EvidenceSyncResult & { backfilledStarts?: number }).backfilledStarts = backfilled;
  }

  if (fieldcam.length) {
    result.prunedCameras = pruneCamerasNotInAgency(fieldcam.map((d) => d.cameraId), now);
  }

  setMeta("fleet_last_sync", polledAt);
  setMeta("fleet_last_result", JSON.stringify(result));
  audit(actor, "evidence.sync", { newValue: result });
  return result;
}

/** Manual test helper: force a mock owner change without live API. */
export function applyManualOwnership(
  actor: string,
  cameraId: string,
  email: string | null,
): EvidenceSyncResult {
  const db = getDb();
  const now = nowISO();
  db.prepare(
    `INSERT INTO cameras (camera_id, label, created_at) VALUES (?, ?, ?)
     ON CONFLICT(camera_id) DO NOTHING`,
  ).run(cameraId, null, now);

  const current = db
    .prepare(
      `SELECT assignment_id, camera_id, email, assigned_at_utc
       FROM assignment_history
       WHERE camera_id = ? AND status = 'open' AND unassigned_at_utc IS NULL
         AND source IN ('fleet')
       ORDER BY assigned_at_utc DESC LIMIT 1`,
    )
    .get(cameraId) as
    | { assignment_id: string; camera_id: string; email: string; assigned_at_utc: string }
    | undefined;

  let opened = 0;
  let closed = 0;
  let unchanged = 0;

  if (!email) {
    if (current) {
      db.prepare(
        `UPDATE assignment_history SET unassigned_at_utc = ?, status = 'closed' WHERE assignment_id = ?`,
      ).run(now, current.assignment_id);
      db.prepare(
        `UPDATE participants SET camera_id = NULL, updated_at = ? WHERE camera_id = ?`,
      ).run(now, cameraId);
      closed = 1;
    } else unchanged = 1;
  } else if (current && current.email.toLowerCase() === email.toLowerCase()) {
    unchanged = 1;
  } else {
    if (current) {
      db.prepare(
        `UPDATE assignment_history SET unassigned_at_utc = ?, status = 'closed' WHERE assignment_id = ?`,
      ).run(now, current.assignment_id);
      closed = 1;
    }
    const id = uuid();
    db.prepare(
      `INSERT INTO assignment_history (
        assignment_id, camera_id, email, assigned_at_utc, unassigned_at_utc,
        source, status, import_batch_id, created_at
      ) VALUES (?, ?, ?, ?, NULL, 'fleet', 'open', NULL, ?)`,
    ).run(id, cameraId, email.toLowerCase(), now, now);
    db.prepare(
      `UPDATE participants SET camera_id = NULL, updated_at = ? WHERE camera_id = ? AND lower(email) != lower(?)`,
    ).run(now, cameraId, email);
    db.prepare(`UPDATE participants SET camera_id = ?, updated_at = ? WHERE email = ?`).run(
      cameraId,
      now,
      email.toLowerCase(),
    );
    opened = 1;
  }

  const result: EvidenceSyncResult = {
    mode: "mock",
    polledAt: now,
    devicesSeen: 1,
    fieldcamDevices: 1,
    opened,
    closed,
    unchanged,
    unresolvedOwners: 0,
    prunedCameras: 0,
    errors: [],
  };
  setMeta("fleet_last_sync", now);
  setMeta("fleet_last_result", JSON.stringify(result));
  audit(actor, "fleet.manual_ownership", {
    entityType: "camera",
    entityId: cameraId,
    newValue: { email, ...result },
  });
  return result;
}
