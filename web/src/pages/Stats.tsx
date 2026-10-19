import { useCallback, useEffect, useRef, useState } from "react";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import StatTile from "../components/StatTile";
import GoalMeter from "../components/GoalMeter";
import DeviceFailures from "../components/DeviceFailures";
import ReliabilityTile from "../components/ReliabilityTile";
import UploadTransports from "../components/UploadTransports";
import RuntimeEstimate from "../components/RuntimeEstimate";
import { RELIABILITY_SCORECARD } from "../config/reliability";
import { PROGRAM_GOALS } from "../config/scoring.config";
import {
  DEFAULT_STATS_WINDOW,
  STATS_WINDOWS,
  statsWindow,
  type StatsWindowKey,
} from "../config/statsWindows";
import { isWeekInProgress, weekLabel } from "../config/weeks";
import { apiErrorMessage } from "../config/harbor";
import {
  fetchLocalStats,
  fetchLocalWeeklyStats,
  isLocalApiConfigured,
  type LocalOverallStats,
  type LocalStatTrend,
  type LocalWeeklyStatsRow,
} from "../data/localApi";
import { readSnapshotStats, readSnapshotWeekly } from "../data/leaderboardSnapshot";

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${minutes}m ${remainder}s`;
}

function phoenixStamp(iso: string, withTime = true): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Phoenix",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric" as const, minute: "2-digit" as const } : {}),
  }).format(d);
}

/**
 * The span the numbers cover, in words.
 *
 * Wall-clock times matter at 24 hours ("9:01 AM – 9:01 AM") and are noise across two weeks, so
 * anything wider than a day reads as dates. All-time with no activity yet has no start to name.
 */
function windowRange(stats: LocalOverallStats): string {
  const w = stats.window;
  if (!w) return "24 hours ending at the last snapshot";
  const withTime = w.hours != null && w.hours <= 24;
  const until = phoenixStamp(w.untilUtc, withTime);
  if (!w.sinceUtc) return `All program activity, through ${until} Phoenix`;
  return `${phoenixStamp(w.sinceUtc, withTime)} – ${until} Phoenix`;
}

function freshnessLabel(stats: LocalOverallStats): string {
  const f = stats.freshness;
  if (!f?.hasImport) return "No Splunk snapshot imported yet";
  if (f.ageHours == null) return "Snapshot age unknown";
  const stale = f.staleForReminders ? " (stale)" : "";
  return `Export ${f.ageHours}h ago${stale}`;
}

export default function Stats() {
  const [stats, setStats] = useState<LocalOverallStats | null>(null);
  const [weeks, setWeeks] = useState<LocalWeeklyStatsRow[]>([]);
  const [windowKey, setWindowKey] = useState<StatsWindowKey>(DEFAULT_STATS_WINDOW);
  const [showTable, setShowTable] = useState(false);
  const [showAllMetrics, setShowAllMetrics] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Switching windows fires a fetch per click, and they can land out of order. Only the newest
  // request is allowed to write state, so a slow 14-day response cannot overwrite a later 24h one.
  const latestRequest = useRef(0);

  const load = useCallback(async (key: StatsWindowKey) => {
    const request = ++latestRequest.current;
    const isStale = () => latestRequest.current !== request;
    setLoading(true);
    setError(null);
    const staticBoard = import.meta.env.VITE_STATIC_LEADERBOARD === "true";
    if (!staticBoard && !isLocalApiConfigured()) {
      setError("Local API is not configured.");
      setStats(null);
      setLoading(false);
      return;
    }
    try {
      const [overall, weekly] = await Promise.all(
        staticBoard
          ? [readSnapshotStats(key), readSnapshotWeekly()]
          : [fetchLocalStats(key), fetchLocalWeeklyStats()],
      );
      if (isStale()) return;
      setStats(overall);
      setWeeks(weekly);
    } catch (err) {
      if (isStale()) return;
      setError(
        staticBoard ? (err instanceof Error ? err.message : String(err)) : apiErrorMessage(err),
      );
      setStats(null);
      setWeeks([]);
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(windowKey);
  }, [load, windowKey]);

  const current = stats?.current;
  // Prefer the window the server actually resolved; fall back to the local spec before the first
  // response lands, and while an error leaves the page with no payload.
  const win = stats?.window ?? statsWindow(windowKey);
  const isAllTime = win.prior === null;

  return (
    <div>
      <PageHeader
        eyebrow={isAllTime ? "Program to date" : "Last snapshot"}
        title="Overall Statistics"
        description={
          stats
            ? `${windowRange(stats)}. ${freshnessLabel(stats)}. Counts completed qualifying recordings.`
            : "Program activity over a window you choose, ending at the last Splunk snapshot."
        }
        action={
          <button
            type="button"
            onClick={() => void load(windowKey)}
            disabled={loading}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {STATS_WINDOWS.map((w) => (
          <button
            key={w.key}
            type="button"
            onClick={() => setWindowKey(w.key)}
            aria-pressed={windowKey === w.key}
            className={
              windowKey === w.key
                ? "rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-bold text-[#e8edf4]"
                : "rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
            }
          >
            {w.label}
          </button>
        ))}
      </div>

      {error && (
        <Card className="mb-4 border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10">
          <p className="text-sm font-medium text-[var(--color-danger)]">Could not load statistics</p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--color-danger)]">
            {error}
          </p>
        </Card>
      )}

      {loading && !stats && !error && (
        <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
      )}

      {stats && current && current.empty && (
        <Card className="mb-4">
          <p className="text-sm text-[var(--color-text-muted)]">
            {isAllTime
              ? "No activity on record yet — nothing has been imported from Splunk."
              : `Nothing in ${win.phrase} ending at the last snapshot (quiet spell, or the dump missed those events). Try a wider window.`}
          </p>
        </Card>
      )}

      {stats && current && <WindowGrid stats={stats} />}

      {stats && <GoalProgress
          stats={stats}
          weeks={weeks}
          showTable={showTable}
          onToggleTable={setShowTable}
          showAllMetrics={showAllMetrics}
          setShowAllMetrics={setShowAllMetrics}
        />}
    </div>
  );
}

function asDelta(
  trend?: LocalStatTrend,
  extra?: { unit?: string; format?: "count" | "durationSeconds" | "hours"; tone?: LocalStatTrend["tone"] },
) {
  if (!trend) return undefined;
  return {
    delta: trend.delta,
    direction: trend.direction,
    tone: extra?.tone ?? trend.tone,
    unit: extra?.unit,
    format: extra?.format,
  };
}

/**
 * Volume over the selected window.
 *
 * All-time has no earlier span to compare against, so the trend chips are dropped entirely rather
 * than shown as "no prior" on all nine tiles — nine identical disclaimers say less than none.
 */
function WindowGrid({ stats }: { stats: LocalOverallStats }) {
  const cur = stats.current!;
  const trends = stats.volumeTrends ?? {};
  const comparison = stats.window?.prior ?? null;
  const priorEmpty = Boolean(stats.previous?.empty);
  const min = cur.minThresholdSeconds || stats.minThresholdSeconds;
  // One `delta`/`comparison` pair for every tile: either every chip compares, or none does.
  const chip = comparison
    ? (key: string, extra?: Parameters<typeof asDelta>[1]) => ({
        delta: asDelta(trends[key], extra),
        priorEmpty,
        comparison,
      })
    : () => ({});

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <StatTile
        label="Recordings"
        value={cur.totalRecordings.toLocaleString()}
        accent
        hint="Completed qualifying recordings"
        {...chip("totalRecordings")}
      />
      <StatTile
        label={`Recordings ≥ ${min}s`}
        value={cur.recordingsOverThreshold.toLocaleString()}
        hint={`${cur.recordingsUnderThreshold.toLocaleString()} shorter than ${min}s`}
        {...chip("recordingsOverThreshold")}
      />
      <StatTile
        label="Average recording length"
        value={formatDuration(cur.avgDurationSeconds)}
        {...chip("avgDurationSeconds", { format: "durationSeconds", tone: "neutral" })}
      />
      <StatTile
        label="Recording time"
        value={`${cur.totalDurationHours.toLocaleString()} hrs`}
        {...chip("totalDurationHours", { format: "hours" })}
      />
      <StatTile
        label="Participants with activity"
        value={cur.distinctParticipants.toLocaleString()}
        {...chip("distinctParticipants")}
      />
      <StatTile
        label="Cameras used"
        value={cur.distinctCameras.toLocaleString()}
        {...chip("distinctCameras")}
      />
      <StatTile label="Uploads" value={cur.totalUploads.toLocaleString()} {...chip("totalUploads")} />
      <StatTile
        label="Livestream sessions"
        value={cur.totalLivestreams.toLocaleString()}
        {...chip("totalLivestreams")}
      />
      <StatTile
        label="Approved reports"
        value={cur.totalReports.toLocaleString()}
        hint="Posted in #fieldcam-selfhost and approved"
        {...chip("totalReports")}
      />
    </div>
  );
}

const fmtCount = (n: number) => Math.round(n).toLocaleString();
const fmtHours = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}h`;

function GoalProgress({
  stats,
  weeks,
  showTable,
  onToggleTable,
  showAllMetrics,
  setShowAllMetrics,
}: {
  stats: LocalOverallStats;
  weeks: LocalWeeklyStatsRow[];
  showTable: boolean;
  onToggleTable: (v: boolean) => void;
  showAllMetrics: boolean;
  setShowAllMetrics: (v: boolean) => void;
}) {
  const complete = weeks.filter((w) => !isWeekInProgress(w.weekStart));
  const lastFull = complete.length ? complete[complete.length - 1] : null;
  const win = stats.window ?? statsWindow(DEFAULT_STATS_WINDOW);
  const windowLabel = win.short;
  const windowPhrase = win.phrase;
  const comparisonLabel = win.prior;
  const currentRel = new Map((stats.current?.reliability ?? []).map((m) => [m.key, m]));
  const allTimeRel = new Map((stats.reliability ?? []).map((m) => [m.key, m]));
  const hasData = (key: string) =>
    (currentRel.get(key)?.total ?? 0) > 0 || (allTimeRel.get(key)?.total ?? 0) > 0;
  const visible = showAllMetrics
    ? RELIABILITY_SCORECARD
    : RELIABILITY_SCORECARD.filter((x) => hasData(x.key));
  const hidden = RELIABILITY_SCORECARD.length - visible.length;
  const tiers = [
    ["maintain", "Maintain", "Committed targets."],
    ["raise", "Raise the bar", "Agreed; logging to support them is due Q2 2026."],
  ] as const;

  return (
    <section className="mt-8">
      <div className="mb-3">
        <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">Program totals</p>
        <h2 className="text-lg font-bold text-[var(--color-text)]">All-time</h2>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          {stats.totalRecordings.toLocaleString()} recordings · {stats.totalDurationHours.toLocaleString()} hrs ·{" "}
          {stats.distinctParticipants.toLocaleString()} people · {stats.distinctCameras.toLocaleString()} cameras ·{" "}
          {stats.totalUploads.toLocaleString()} uploads · {stats.totalLivestreams.toLocaleString()} livestreams ·{" "}
          {stats.totalReports.toLocaleString()} reports
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">Program targets</p>
          <h2 className="text-lg font-bold text-[var(--color-text)]">Progress to target</h2>
        </div>
        {weeks.length > 0 && (
          <button
            type="button"
            onClick={() => onToggleTable(!showTable)}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            {showTable ? "Hide weekly detail" : "Weekly detail"}
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <GoalMeter
          label="Recordings"
          current={stats.totalRecordings}
          goal={PROGRAM_GOALS.recordings}
          format={fmtCount}
          unit="recordings"
          perWeek={lastFull?.recordings ?? null}
        />
        <GoalMeter
          label="Recording hours"
          current={stats.totalDurationHours}
          goal={PROGRAM_GOALS.recordingHours}
          format={fmtHours}
          unit=""
          perWeek={lastFull?.recordingHours ?? null}
        />
      </div>

      {lastFull && lastFull.participants > 0 && stats.distinctParticipants > 0 && (
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          Those projections hold participation at{" "}
          <span className="text-[var(--color-text)]">{lastFull.participants}</span> active{" "}
          {lastFull.participants === 1 ? "person" : "people"}, about{" "}
          <span className="text-[var(--color-text)]">
            {(lastFull.recordingHours / lastFull.participants).toFixed(1)}h
          </span>{" "}
          each per week. More people recording moves these far more than each person recording more.
        </p>
      )}

      <div className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">Reliability</p>
            <h3 className="text-base font-bold text-[var(--color-text)]">
              Success rates ({windowLabel})
            </h3>
          </div>
          {(hidden > 0 || showAllMetrics) && (
            <button
              type="button"
              onClick={() => setShowAllMetrics(!showAllMetrics)}
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              {showAllMetrics
                ? "Show measured only"
                : `Show all targets (${hidden} not measured yet)`}
            </button>
          )}
        </div>
        {tiers.map(([tier, heading, note]) => {
          const specs = visible.filter((x) => x.tier === tier);
          if (!specs.length) return null;
          return (
            <div key={tier} className="mt-4">
              {showAllMetrics && (
                <p className="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">
                  {heading} <span className="text-[var(--color-text-faint)]">: {note}</span>
                </p>
              )}
              <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {specs.map((spec) => (
                  <ReliabilityTile
                    key={spec.key}
                    spec={spec}
                    current={currentRel.get(spec.key)}
                    allTime={allTimeRel.get(spec.key)}
                    windowLabel={windowLabel}
                    windowPhrase={windowPhrase}
                    comparisonLabel={comparisonLabel}
                    showCi={showAllMetrics}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {stats.runtime && <RuntimeEstimate runtime={stats.runtime} windowPhrase={windowPhrase} />}

      {stats.uploadTransports && stats.uploadTransports.length > 1 && (
        <UploadTransports rows={stats.uploadTransports} windowPhrase={windowPhrase} />
      )}

      {stats.deviceFailures && stats.deviceFailures.length > 0 && (
        <DeviceFailures
          rows={stats.deviceFailures}
          windowPhrase={windowPhrase}
          // Fleet rate over the same window the rows cover, so "worse than fleet" compares like
          // with like. Falls back to all-time only if the window has no upload metric at all.
          fleetUploadRate={
            currentRel.get("upload")?.rate ??
            (stats.reliability ?? []).find((m) => m.key === "upload")?.rate ??
            null
          }
        />
      )}

      {showTable && weeks.length > 0 && (
        <Card className="mt-4 overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border-soft)] text-left">
                {["Week", "Recordings", "Hours", "Active people", "Uploads", "Reports"].map((h) => (
                  <th
                    key={h}
                    className={`px-4 py-2 text-xs uppercase tracking-wide text-[var(--color-text-faint)] ${h === "Week" ? "" : "text-right"}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w.weekStart} className="border-b border-[var(--color-border-soft)] last:border-0">
                  <td className="px-4 py-2 text-[var(--color-text)]">
                    {weekLabel(w.weekStart)}
                    {isWeekInProgress(w.weekStart) && (
                      <span className="ml-2 text-[11px] text-[var(--color-text-faint)]"> still running</span>
                    )}
                  </td>
                  {[w.recordings, w.recordingHours, w.participants, w.uploads, w.reports].map((v, i) => (
                    <td key={i} className="px-4 py-2 text-right tabular-nums text-[var(--color-text-muted)]">
                      {i === 1 ? fmtHours(v) : fmtCount(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
