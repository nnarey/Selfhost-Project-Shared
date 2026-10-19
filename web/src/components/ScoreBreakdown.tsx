import type { ScoreBreakdown as ScoreBreakdownType } from "../data/types";

function Line({ label, value, muted = false }: { label: string; value: number; muted?: boolean }) {
  if (value === 0 && muted) return null;
  const sign = value > 0 ? "+" : "";
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className={value < 0 ? "text-[var(--color-danger)]" : "text-[var(--color-text)]"}>
        {sign}
        {value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </span>
    </div>
  );
}

/** Compact, expandable "how was this calculated?" breakdown — used everywhere a score appears. */
export default function ScoreBreakdown({
  breakdown,
  label = "Score breakdown",
}: {
  breakdown: ScoreBreakdownType;
  label?: string;
}) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-[11px] font-medium text-[var(--color-text-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)]">
        {label}
      </summary>
      <div className="mt-2 w-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3">
        <Line label={`Recordings (${breakdown.totals.recordings})`} value={breakdown.recordingPoints} />
        <Line label={`Hours (${breakdown.totals.hours.toFixed(1)}h)`} value={breakdown.hourPoints} />
        <Line label={`Uploads (${breakdown.totals.uploads})`} value={breakdown.uploadPoints} />
        <Line label={`Livestreams (${breakdown.totals.livestreams})`} value={breakdown.livestreamPoints} />
        <Line label={`Reports (${breakdown.totals.reports})`} value={breakdown.reportPoints} />
        <Line label={`Streak bonus (${breakdown.streakDays}d)`} value={breakdown.streakBonus} muted />
        <Line label={`Inactive penalty (${breakdown.inactiveDays}d)`} value={breakdown.inactivePenalty} muted />
        <div className="mt-1.5 flex items-center justify-between border-t border-[var(--color-border-soft)] pt-1.5 text-xs font-semibold">
          <span className="text-[var(--color-text)]">Total</span>
          <span className={breakdown.total < 0 ? "text-[var(--color-danger)]" : "text-[var(--color-accent)]"}>
            {breakdown.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
        </div>
      </div>
    </details>
  );
}
