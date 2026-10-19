import { getDb } from "./db.js";

const HEADER =
  "assignment_id,camera_id,email,assigned_at_utc,unassigned_at_utc,source,status";

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Canonical assignment + inventory CSV — upload this on Harbor with Splunk. */
export function exportAssignmentCsv(): { csv: string; filename: string; rows: number } {
  const db = getDb();
  const rows = db
    .prepare(
      // Scoped to current inventory: the Fleet sync prunes `cameras` when hardware leaves the
      // agency or turns out not to be a camera at all (docks come back on the same device list).
      // Exporting that history anyway would re-create the camera row on import, because every
      // assignment row upserts its camera — the device would reappear on Harbor as available stock.
      `SELECT assignment_id, camera_id, email, assigned_at_utc, unassigned_at_utc, source, status
       FROM assignment_history
       WHERE source IN ('fleet')
         AND camera_id IN (SELECT camera_id FROM cameras)
       ORDER BY assigned_at_utc ASC, camera_id ASC`,
    )
    .all() as Array<{
    assignment_id: string;
    camera_id: string;
    email: string;
    assigned_at_utc: string;
    unassigned_at_utc: string | null;
    source: string;
    status: string;
  }>;

  const listed = new Set(rows.map((r) => r.camera_id));
  const extraCameras = db
    .prepare(
      `SELECT camera_id FROM cameras
       WHERE camera_id NOT IN (SELECT DISTINCT camera_id FROM assignment_history WHERE source IN ('fleet'))
       ORDER BY camera_id ASC`,
    )
    .all() as Array<{ camera_id: string }>;

  const lines = [
    HEADER,
    ...rows.map((r) =>
      [
        r.assignment_id,
        r.camera_id,
        r.email,
        r.assigned_at_utc,
        r.unassigned_at_utc || "",
        r.source,
        r.status,
      ]
        .map((v) => csvCell(String(v)))
        .join(","),
    ),
    ...extraCameras
      .filter((c) => !listed.has(c.camera_id))
      .map((c) => ["", c.camera_id, "", "", "", "fleet", "available"].map((v) => csvCell(v)).join(",")),
  ];
  const day = new Date().toISOString().slice(0, 10);
  return {
    csv: `${lines.join("\n")}\n`,
    filename: `fieldcam-assignments-${day}.csv`,
    rows: rows.length + extraCameras.filter((c) => !listed.has(c.camera_id)).length,
  };
}
