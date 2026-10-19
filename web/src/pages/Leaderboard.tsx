import { useCallback, useEffect, useMemo, useState } from "react";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import ParticipantName from "../components/ParticipantName";
import {
  fetchLocalLeaderboard,
  isLocalApiConfigured,
  resolveLocalPhotoUrl,
  type LocalLeaderboardEntry,
  type LocalLeaderboardResponse,
} from "../data/localApi";
import { readSnapshotBoard } from "../data/leaderboardSnapshot";
import { apiErrorMessage, isHarborPermanentOnly } from "../config/harbor";
import type { LeaderboardTrack } from "../config/permanentHolders";

export default function Leaderboard() {
  const [local, setLocal] = useState<LocalLeaderboardResponse | null>(null);
  const [weekStart, setWeekStart] = useState<string | undefined>(undefined);
  const permanentOnly = isHarborPermanentOnly();
  const [track, setTrack] = useState<LeaderboardTrack>(permanentOnly ? "permanent" : "overall");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setWarning(null);
    const staticBoard = import.meta.env.VITE_STATIC_LEADERBOARD === "true";
    if (!staticBoard && !isLocalApiConfigured()) {
      setError("Local API is not configured.");
      setLocal(null);
      setLoading(false);
      return;
    }
    try {
      const board = staticBoard
        ? await readSnapshotBoard(track, track === "overall" ? undefined : weekStart)
        : await fetchLocalLeaderboard(track === "overall" ? undefined : weekStart, track);
      setLocal(board);
      setWarning(boardWarning(board, track));
    } catch (err) {
      setError(
        staticBoard ? (err instanceof Error ? err.message : String(err)) : apiErrorMessage(err),
      );
      setLocal(null);
    } finally {
      setLoading(false);
    }
  }, [weekStart, track]);

  useEffect(() => {
    void load();
  }, [load]);

  const metricColumns = useMemo(() => {
    if (!local) return [];
    return local.scoringProfile.metrics;
  }, [local]);

  return (
    <div>
      <PageHeader
        eyebrow={track === "overall" ? "All-time standings" : "Biweekly competition"}
        title="Leaderboard"
        description={
          track === "overall"
            ? permanentOnly
              ? "Permanent testers only. All cameras, every window, one row per person."
              : "Everyone, all cameras, every window. Same scoring as the camera boards, added together per person."
            : track === "permanent"
              ? "Permanent-camera holders only. Two-week periods, ranked separately so assigned FieldCams are not competing with shared checkouts."
              : "Checkout pool only. Two-week periods. People with permanently assigned cameras are on the other tab."
        }
        action={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {!permanentOnly && (
        <button
          type="button"
          onClick={() => setTrack("checkout")}
          className={
            track === "checkout"
              ? "rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-bold text-[#e8edf4]"
              : "rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
          }
        >
          Checkout cameras
        </button>
        )}
        <button
          type="button"
          onClick={() => setTrack("permanent")}
          className={
            track === "permanent"
              ? "rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-bold text-[#e8edf4]"
              : "rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
          }
        >
          Permanent cameras
        </button>
        <button
          type="button"
          onClick={() => setTrack("overall")}
          className={
            track === "overall"
              ? "rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-bold text-[#e8edf4]"
              : "rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
          }
        >
          Overall
        </button>
      </div>

      {local && (
        <div className="mb-3 space-y-2">
          <p className="text-xs text-[var(--color-text-muted)]">
            {track === "overall"
              ? "All-time · "
              : `${formatPeriodRange(local.weekStart, local.weekEnd)} · `}
            Profile {local.scoringProfile.name} ({local.scoringProfile.profileId}@
            {local.scoringProfile.version})
            {local.freshness.hasImport
              ? ` · Export ${local.freshness.ageHours ?? "?"}h ago`
              : " · No import yet"}
          </p>
          {track !== "overall" && (local.availableWeeks?.length ?? 0) > 1 && (
            <div className="flex flex-wrap gap-2">
              {local.availableWeeks!.map((ws) => {
                const active = ws === local.weekStart;
                return (
                  <button
                    key={ws}
                    type="button"
                    onClick={() => setWeekStart(ws)}
                    className={
                      active
                        ? "rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-bold text-[#e8edf4]"
                        : "rounded-md border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
                    }
                  >
                    {formatPeriodStartLabel(ws)}
                    {ws === local.openWeekStart ? " (open)" : ""}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {warning && (
        <Card className="mb-4 border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10">
          <p className="text-sm text-[var(--color-text)]">{warning}</p>
        </Card>
      )}

      {error && (
        <Card className="mb-4 border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10">
          <p className="text-sm font-medium text-[var(--color-danger)]">Could not load leaderboard</p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--color-danger)]">
            {error}
          </p>
        </Card>
      )}

      {/* Checkout sums a person's cameras into one row, so a single Camera cell would be
          misleading there. Only the permanent board is genuinely one row per camera. */}
      {local && (
        <LocalTable
          entries={track === "overall" ? collapseToOneRowPerPerson(local.entries) : local.entries}
          metrics={metricColumns}
          loading={loading}
          showCamera={track === "permanent"}
        />
      )}
    </div>
  );
}

function boardWarning(board: LocalLeaderboardResponse, track: LeaderboardTrack): string | null {
  if (!board.freshness.hasImport) {
    return "No activity has been recorded against the board yet — everyone is showing zero.";
  }
  if (track !== "overall" && board.openWeekStart && board.weekStart !== board.openWeekStart) {
    return "Showing the last completed period. Use the period buttons to switch to the open competition.";
  }
  if (board.freshness.staleForReminders) {
    return `Activity export is ${board.freshness.ageHours}h old (>24h). Reminder queue is blocked until a fresh import.`;
  }
  return null;
}

function formatPeriodRange(startISO: string, endISO: string): string {
  const start = new Date(startISO);
  const endInclusive = new Date(new Date(endISO).getTime() - 12 * 60 * 60 * 1000);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${start.toLocaleDateString(undefined, opts)} – ${endInclusive.toLocaleDateString(undefined, {
    ...opts,
    year: "numeric",
  })}`;
}

function formatPeriodStartLabel(startISO: string): string {
  const start = new Date(startISO);
  const endInclusive = new Date(start.getTime() + 13 * 24 * 60 * 60 * 1000);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${start.toLocaleDateString(undefined, opts)} – ${endInclusive.toLocaleDateString(undefined, opts)}`;
}

/** One leaderboard row per person — sums cameras/weeks that share an email. */
function collapseToOneRowPerPerson(entries: LocalLeaderboardEntry[]): LocalLeaderboardEntry[] {
  const byPerson = new Map<string, LocalLeaderboardEntry>();
  for (const entry of entries) {
    const key = entry.emailHash || entry.name.toLowerCase();
    const existing = byPerson.get(key);
    if (!existing) {
      byPerson.set(key, {
        ...entry,
        cameraId: null,
        cameraIds: [],
        breakdown: entry.breakdown.map((b) => ({ ...b })),
      });
      continue;
    }
    existing.totalPoints += entry.totalPoints;
    for (const b of entry.breakdown) {
      const prev = existing.breakdown.find((x) => x.metricKey === b.metricKey);
      if (!prev) {
        existing.breakdown.push({ ...b });
        continue;
      }
      prev.raw =
        b.metricKey === "active_day_streak" ? Math.max(prev.raw, b.raw) : prev.raw + b.raw;
      prev.points += b.points;
    }
  }

  return [...byPerson.values()]
    .sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      return a.name.localeCompare(b.name);
    })
    .map((row, idx) => ({
      ...row,
      rank: idx + 1,
      totalPoints: Math.round(row.totalPoints * 1000) / 1000,
    }));
}

function LocalTable({
  entries,
  metrics,
  loading,
  showCamera = true,
}: {
  entries: LocalLeaderboardEntry[];
  metrics: Array<{ metricKey: string; label: string }>;
  loading: boolean;
  showCamera?: boolean;
}) {
  if (loading && !entries.length) {
    return <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>;
  }
  if (!entries.length) {
    return <p className="text-sm text-[var(--color-text-muted)]">No participants yet.</p>;
  }

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[720px] text-left text-base">
        <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
          <tr>
            <th className="px-5 py-4">Rank</th>
            <th className="px-5 py-4">Name</th>
            {showCamera && <th className="px-5 py-4">Camera</th>}
            <th className="px-5 py-4">Total</th>
            {metrics.map((m) => (
              <th key={m.metricKey} className="px-5 py-4">
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((row) => {
            const byKey = new Map(row.breakdown.map((b) => [b.metricKey, b]));
            return (
              <tr
                key={`${row.emailHash}-${row.cameraId || "none"}`}
                className="border-t border-[var(--color-border-soft)]"
              >
                <td className="px-5 py-5 text-lg font-semibold text-[var(--color-accent)]">
                  {row.rank}
                </td>
                <td className="px-5 py-5 font-medium">
                  <ParticipantName
                    name={row.name}
                    photoUrl={resolveLocalPhotoUrl(row.photoUrl)}
                    seed={row.emailHash}
                    size="xl"
                    nameClassName="text-base font-semibold text-[var(--color-text)]"
                  />
                </td>
                {showCamera && (
                  <td className="px-5 py-5 font-mono text-sm text-[var(--color-text-muted)]">
                    <CameraList cameraIds={row.cameraIds} cameraId={row.cameraId} />
                  </td>
                )}
                <td className="px-5 py-5 text-lg font-semibold">
                  {formatPoints(row.totalPoints)}
                </td>
                {metrics.map((m) => (
                  <td key={m.metricKey} className="px-5 py-5 text-[var(--color-text-muted)]">
                    {formatMetric(m.metricKey, byKey.get(m.metricKey)?.raw ?? 0)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function CameraList({
  cameraIds,
  cameraId,
}: {
  cameraIds?: string[];
  cameraId: string | null;
}) {
  const ids =
    cameraIds && cameraIds.length > 0
      ? cameraIds
      : cameraId
        ? cameraId.split(/,\s*/).filter(Boolean)
        : [];
  if (!ids.length) return <>{"—"}</>;
  return (
    <div className="flex flex-col gap-1">
      {ids.map((id) => (
        <div key={id}>{id}</div>
      ))}
    </div>
  );
}

function formatPoints(n: number): string {
  return (Math.round(n * 100) / 100).toLocaleString();
}

/** Leaderboard metric columns are units (counts / hours / days), not points. */
function formatMetric(metricKey: string, raw: number): string {
  const rounded = metricKey === "recording_hours" ? Math.round(raw * 100) / 100 : Math.round(raw * 1000) / 1000;
  if (metricKey === "recording_hours") {
    return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (Math.abs(rounded - Math.round(rounded)) < 0.0005) {
    return Math.round(rounded).toLocaleString();
  }
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
