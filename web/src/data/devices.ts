import { getLastRecordingDate } from "./scoring";
import type { ActivityRecord, Device, DeviceAvailability, Hub, Participant } from "./types";
import { HUBS } from "./types";

/** Desk / pickup label for a hub (one location per city). */
export function hubDeskLocation(hub: Hub): string {
  return hub === "Seattle" ? "Hub A" : "Black Box";
}

/** Demo inventory — 20 cameras per hub. */
export function buildDeviceInventory(): Device[] {
  const make = (hub: Hub, startSerial: number, count: number): Device[] =>
    Array.from({ length: count }, (_, i) => ({
      serial: `FC-${startSerial + i}`,
      hub,
      deskLocation: hubDeskLocation(hub),
    }));

  return [...make("Phoenix", 20001, 20), ...make("Seattle", 21001, 20)];
}

export interface DeviceRow {
  device: Device;
  status: DeviceAvailability;
  /** Display name of the person who has it checked out, if any. */
  checkedOutTo?: string;
  /** Email of the holder, for self-service return matching. */
  checkedOutToEmail?: string;
  /** ISO timestamp when the current holder checked this device out. */
  checkoutDate?: string;
  /** YYYY-MM-DD of the holder's last logged recording, if any. */
  lastUsedDate?: string;
}

/** Human-readable duration since checkout (e.g. "2d 5h", "3h", "12m"). */
export function formatCheckoutDuration(
  checkoutDateISO: string,
  now: Date = new Date(),
): string {
  const start = new Date(checkoutDateISO).getTime();
  if (Number.isNaN(start)) return "—";
  const ms = Math.max(0, now.getTime() - start);
  const totalMinutes = Math.floor(ms / (1000 * 60));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Format a YYYY-MM-DD activity day for the Availability table. */
export function formatLastUsedLabel(lastUsedDate: string | undefined): string {
  if (!lastUsedDate) return "No activity";
  const d = new Date(`${lastUsedDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return lastUsedDate;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Join inventory with live checkouts (+ holder activity) to get availability per device. */
export function computeDeviceAvailability(
  devices: Device[],
  participants: Participant[],
  activity: ActivityRecord[] = [],
): DeviceRow[] {
  const holderBySerial = new Map<string, Participant>();
  for (const p of participants) {
    if (p.serial) holderBySerial.set(p.serial.trim().toUpperCase(), p);
  }

  const activityByEmail = new Map<string, ActivityRecord[]>();
  for (const r of activity) {
    const list = activityByEmail.get(r.email) ?? [];
    list.push(r);
    activityByEmail.set(r.email, list);
  }

  return devices.map((device) => {
    const holder = holderBySerial.get(device.serial.trim().toUpperCase());
    if (holder) {
      const records = activityByEmail.get(holder.email) ?? [];
      return {
        device,
        status: "Checked out" as const,
        checkedOutTo: holder.name,
        checkedOutToEmail: holder.email,
        checkoutDate: holder.checkoutDate || undefined,
        lastUsedDate: getLastRecordingDate(records),
      };
    }
    return { device, status: "Available" as const };
  });
}

export function summarizeByHub(rows: DeviceRow[]): Record<
  Hub,
  { total: number; available: number; checkedOut: number; rows: DeviceRow[] }
> {
  const empty = (): { total: number; available: number; checkedOut: number; rows: DeviceRow[] } => ({
    total: 0,
    available: 0,
    checkedOut: 0,
    rows: [],
  });
  const summary: Record<Hub, ReturnType<typeof empty>> = {
    Phoenix: empty(),
    Seattle: empty(),
  };

  for (const row of rows) {
    const bucket = summary[row.device.hub];
    bucket.total += 1;
    bucket.rows.push(row);
    if (row.status === "Available") bucket.available += 1;
    else bucket.checkedOut += 1;
  }

  for (const hub of HUBS) {
    summary[hub].rows.sort((a, b) => {
      if (a.status !== b.status) return a.status === "Available" ? -1 : 1;
      return a.device.serial.localeCompare(b.device.serial);
    });
  }

  return summary;
}
