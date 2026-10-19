import { getDb } from "./db.js";

export type DeviceHub = "Phoenix" | "Seattle";

export interface DeviceInventoryRow {
  cameraId: string;
  label: string | null;
  hub: DeviceHub;
  status: "Available" | "Checked out";
  holderEmail: string | null;
  holderName: string | null;
  checkoutAtUtc: string | null;
  source: string | null;
  lastUsedDate: string | null;
}

function normalizeHub(raw: string | null | undefined): DeviceHub {
  return String(raw || "").toLowerCase() === "seattle" ? "Seattle" : "Phoenix";
}

/** Public inventory: cameras from the latest Fleet CSV + open assignment holder. */
export function listDeviceInventory(): {
  devices: DeviceInventoryRow[];
  summary: {
    total: number;
    available: number;
    checkedOut: number;
    byHub: Record<DeviceHub, { total: number; available: number; checkedOut: number }>;
  };
} {
  const db = getDb();

  const rows = db
    .prepare(
      `
      SELECT
        c.camera_id AS cameraId,
        c.label AS label,
        open.email AS holderEmail,
        open.assigned_at_utc AS checkoutAtUtc,
        open.source AS source,
        p.name AS holderName,
        p.hub AS holderHub,
        (
          SELECT p2.hub
          FROM assignment_history ah
          JOIN participants p2 ON lower(p2.email) = lower(ah.email)
          WHERE ah.camera_id = c.camera_id
          ORDER BY ah.assigned_at_utc DESC
          LIMIT 1
        ) AS lastHub,
        (
          SELECT max(d.activity_date)
          FROM daily_activity d
          WHERE open.email IS NOT NULL
            AND lower(d.email) = lower(open.email)
            AND d.recordings > 0
        ) AS lastUsedDate
      FROM cameras c
      LEFT JOIN (
        SELECT a.camera_id, a.email, a.assigned_at_utc, a.source
        FROM assignment_history a
        INNER JOIN (
          SELECT camera_id, max(assigned_at_utc) AS max_assigned
          FROM assignment_history
          WHERE status = 'open' AND unassigned_at_utc IS NULL
          GROUP BY camera_id
        ) latest
          ON latest.camera_id = a.camera_id
         AND latest.max_assigned = a.assigned_at_utc
        WHERE a.status = 'open' AND a.unassigned_at_utc IS NULL
      ) open ON open.camera_id = c.camera_id
      LEFT JOIN participants p ON open.email IS NOT NULL AND lower(p.email) = lower(open.email)
      ORDER BY c.camera_id ASC
      `,
    )
    .all() as Array<{
    cameraId: string;
    label: string | null;
    holderEmail: string | null;
    checkoutAtUtc: string | null;
    source: string | null;
    holderName: string | null;
    holderHub: string | null;
    lastHub: string | null;
    lastUsedDate: string | null;
  }>;

  const devices: DeviceInventoryRow[] = rows.map((r) => {
    const checkedOut = Boolean(r.holderEmail);
    return {
      cameraId: r.cameraId,
      label: r.label,
      hub: normalizeHub(r.holderHub || r.lastHub || "Phoenix"),
      status: checkedOut ? "Checked out" : "Available",
      holderEmail: r.holderEmail,
      holderName: r.holderName || (r.holderEmail ? r.holderEmail.split("@")[0] : null),
      checkoutAtUtc: r.checkoutAtUtc,
      source: r.source,
      lastUsedDate: r.lastUsedDate,
    };
  });

  const emptyHub = () => ({ total: 0, available: 0, checkedOut: 0 });
  const byHub: Record<DeviceHub, { total: number; available: number; checkedOut: number }> = {
    Phoenix: emptyHub(),
    Seattle: emptyHub(),
  };
  let available = 0;
  let checkedOut = 0;
  for (const d of devices) {
    byHub[d.hub].total += 1;
    if (d.status === "Available") {
      available += 1;
      byHub[d.hub].available += 1;
    } else {
      checkedOut += 1;
      byHub[d.hub].checkedOut += 1;
    }
  }

  return {
    devices,
    summary: { total: devices.length, available, checkedOut, byHub },
  };
}
