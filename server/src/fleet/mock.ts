import { getDb } from "../db.js";
import type { FleetDevice } from "./types.js";

/**
 * Local mock ownership snapshot derived from open assignment_history / participant cameras.
 * Also used when FLEET_MODE=mock so sync logic can be tested without Partner API creds.
 */
export function mockFleetDevices(): FleetDevice[] {
  const db = getDb();
  const cameras = db
    .prepare(`SELECT camera_id, label FROM cameras ORDER BY camera_id`)
    .all() as Array<{ camera_id: string; label: string | null }>;

  const open = db
    .prepare(
      `SELECT camera_id, email, assigned_at_utc
       FROM assignment_history
       WHERE status = 'open' AND unassigned_at_utc IS NULL
         AND source IN ('fleet')`,
    )
    .all() as Array<{ camera_id: string; email: string; assigned_at_utc: string }>;
  const openByCamera = new Map(open.map((r) => [r.camera_id, r]));

  const participants = db
    .prepare(
      `SELECT email, camera_id FROM participants
       WHERE signup_status = 'approved' AND camera_id IS NOT NULL AND TRIM(camera_id) != ''`,
    )
    .all() as Array<{ email: string; camera_id: string }>;

  const devices: FleetDevice[] = [];
  const seen = new Set<string>();

  for (const cam of cameras) {
    seen.add(cam.camera_id);
    const o = openByCamera.get(cam.camera_id);
    devices.push({
      cameraId: cam.camera_id,
      model: "fieldcam_series",
      label: cam.label,
      owner: o
        ? { id: o.email, email: o.email, assignedAtUtc: o.assigned_at_utc }
        : null,
    });
  }

  for (const p of participants) {
    if (seen.has(p.camera_id)) continue;
    seen.add(p.camera_id);
    devices.push({
      cameraId: p.camera_id,
      model: "fieldcam_series",
      label: null,
      owner: { id: p.email, email: p.email, assignedAtUtc: new Date().toISOString() },
    });
  }

  // Deterministic extra mock device for demo handoffs when DB is empty of cameras
  if (devices.length === 0) {
    devices.push(
      {
        cameraId: "FC-7727X",
        model: "fieldcam_series",
        label: "Mock FieldCam 1",
        owner: { id: "alice.chen@northline.example", email: "alice.chen@northline.example", assignedAtUtc: new Date().toISOString() },
      },
      {
        cameraId: "FC-J8237",
        model: "fieldcam_series",
        label: "Mock FieldCam 2",
        owner: null,
      },
    );
  }

  return devices;
}
