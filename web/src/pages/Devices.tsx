import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import StatTile from "../components/StatTile";
import { useAuth } from "../context/AuthContext";
import { formatCheckoutDuration, formatLastUsedLabel } from "../data/devices";
import {
  fetchLocalDevices,
  isLocalApiConfigured,
  type LocalDeviceRow,
  type LocalDevicesResponse,
} from "../data/localApi";
import { readSnapshotDevices } from "../data/leaderboardSnapshot";
import type { DeviceAvailability } from "../data/types";

function AvailabilityPill({ status }: { status: DeviceAvailability }) {
  if (status === "Available") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-pitch)]/15 px-2 py-0.5 text-xs font-medium text-[var(--color-pitch)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-pitch)]" /> Available
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-text-faint)]/20 px-2 py-0.5 text-xs font-medium text-[var(--color-text-muted)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-text-faint)]" /> Checked out
    </span>
  );
}

function displayName(row: LocalDeviceRow): string {
  if (row.holderName?.trim()) return row.holderName.trim();
  if (row.holderEmail) return row.holderEmail.split("@")[0] || row.holderEmail;
  return "—";
}

export default function Devices() {
  const { session } = useAuth();
  const [data, setData] = useState<LocalDevicesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"All" | DeviceAvailability>("All");

  const load = useCallback(async () => {
    const staticBoard = import.meta.env.VITE_STATIC_LEADERBOARD === "true";
    if (!staticBoard && !isLocalApiConfigured()) {
      setLoadError("Local API is not configured (set VITE_LOCAL_API_URL).");
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      setData(staticBoard ? await readSnapshotDevices() : await fetchLocalDevices());
    } catch (err) {
      setData(null);
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    if (import.meta.env.VITE_STATIC_LEADERBOARD === "true") return;
    const id = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  const myCameras = useMemo(() => {
    if (!session || !data) return [] as LocalDeviceRow[];
    const email = session.email.toLowerCase();
    return data.devices.filter(
      (d) => d.status === "Checked out" && d.holderEmail?.toLowerCase() === email,
    );
  }, [session, data]);

  const rows = useMemo(() => {
    const list = [...(data?.devices ?? [])];
    list.sort((a, b) => {
      if (a.status !== b.status) return a.status === "Available" ? -1 : 1;
      return a.cameraId.localeCompare(b.cameraId);
    });
    return list;
  }, [data]);

  const filtered = rows.filter((r) => statusFilter === "All" || r.status === statusFilter);
  const summary = data?.summary;
  const totalAvailable = summary?.available ?? 0;
  const totalCheckedOut = summary?.checkedOut ?? 0;

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Devices"
        description="Checkout status comes from the latest Fleet assignment import. This page is view-only."
      />

      <Card className="mb-6 p-4">
        {loading && !data ? (
          <p className="text-sm text-[var(--color-text-muted)]">Loading inventory…</p>
        ) : loadError ? (
          <p className="text-sm text-[var(--color-danger)]">
            Couldn’t load devices from the local API: {loadError}
          </p>
        ) : !session ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            Open{" "}
            <Link to="/sign-up" className="font-semibold text-[var(--color-accent)] underline">
              Sign up
            </Link>{" "}
            if you do not have a roster row yet. Inventory below is still visible.
          </p>
        ) : myCameras.length > 0 ? (
          <p className="text-sm text-[var(--color-text)]">
            Signed in as {session.email}. Assignment import shows{" "}
            <span className="font-semibold text-[var(--color-accent)]">{myCameras.length}</span>{" "}
            camera{myCameras.length === 1 ? "" : "s"} with you:{" "}
            {myCameras.map((c) => c.cameraId).join(", ")}.
          </p>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">
            Signed in as {session.email}. No open assignment on this roster from the Fleet import.
          </p>
        )}
      </Card>

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-2">
        <StatTile label="Available" value={totalAvailable} accent hint="No open assignment" />
        <StatTile label="Checked out" value={totalCheckedOut} hint="Open Fleet assignment" />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {(["All", "Available", "Checked out"] as const).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setStatusFilter(status)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              statusFilter === status
                ? "bg-[var(--color-surface-2)] text-[var(--color-accent)]"
                : "border border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
            }`}
          >
            {status === "All" ? "All statuses" : status}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
        >
          Refresh
        </button>
      </div>

      <Card className="overflow-x-auto">
        {loading && !data ? (
          <p className="px-4 py-8 text-center text-sm text-[var(--color-text-faint)]">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[var(--color-text-faint)]">
            No devices match these filters.
          </p>
        ) : (
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
                <th className="px-4 py-2 font-medium">Serial</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">With</th>
                <th className="px-2 py-2 font-medium">Out for</th>
                <th className="px-4 py-2 font-medium">Last used</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const isMine =
                  Boolean(session) &&
                  row.holderEmail?.toLowerCase() === session?.email.toLowerCase();
                const checkedOutRow = row.status === "Checked out";
                return (
                  <tr key={row.cameraId} className="border-t border-[var(--color-border-soft)]">
                    <td className="px-4 py-2.5 font-mono text-xs text-[var(--color-text)]">
                      {row.cameraId}
                    </td>
                    <td className="px-2 py-2.5">
                      <AvailabilityPill status={row.status} />
                    </td>
                    <td className="px-2 py-2.5 text-[var(--color-text-muted)]">
                      {checkedOutRow ? displayName(row) : "—"}
                      {isMine ? (
                        <span className="ml-1 text-[10px] text-[var(--color-accent)]">(you)</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2.5 text-[var(--color-text-muted)]">
                      {checkedOutRow && row.checkoutAtUtc
                        ? formatCheckoutDuration(row.checkoutAtUtc)
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--color-text-muted)]">
                      {checkedOutRow ? formatLastUsedLabel(row.lastUsedDate ?? undefined) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
