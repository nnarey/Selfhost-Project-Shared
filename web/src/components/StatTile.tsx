export type TrendTone = "better" | "worse" | "neutral";
export type TrendDirection = "up" | "down" | "flat" | "unknown";

export interface StatDelta {
  delta: number | null;
  direction: TrendDirection;
  tone: TrendTone;
  /** Hours vs minutes vs count: the chip prefixes with +/-. */
  unit?: string;
  /** How to print `delta`. Default is a count. Duration values are seconds. */
  format?: "count" | "durationSeconds" | "hours";
}

const TONE_COLOR: Record<TrendTone, string> = {
  better: "#0ca30c",
  worse: "#d03b3b",
  neutral: "var(--color-text-faint)",
};

function formatClock(seconds: number): string {
  const rounded = Math.round(Math.abs(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function trendChipText(delta: StatDelta, priorEmpty: boolean, comparison: string): string {
  if (delta.direction === "unknown") {
    return priorEmpty ? `no ${comparison}` : "no activity";
  }
  if (delta.direction === "flat" || delta.delta === 0) return `same as ${comparison}`;
  const n = delta.delta ?? 0;
  const glyph = delta.direction === "up" ? "▲" : "▼";
  const vs = `vs ${comparison}`;
  if (delta.format === "durationSeconds") {
    const word = n > 0 ? "longer" : "shorter";
    return `${glyph} ${formatClock(n)} ${word} ${vs}`;
  }
  if (delta.format === "hours") {
    const sign = n > 0 ? "+" : "";
    return `${glyph} ${sign}${n.toFixed(1)}h ${vs}`;
  }
  const sign = n > 0 ? "+" : "";
  const unit = delta.unit ?? "";
  return `${glyph} ${sign}${n}${unit} ${vs}`;
}

export default function StatTile({
  label,
  value,
  hint,
  accent = false,
  delta,
  priorEmpty = false,
  comparison = "prior snapshot",
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
  delta?: StatDelta;
  priorEmpty?: boolean;
  /** What the delta is measured against, e.g. "prior 7 days". Named in the chip text. */
  comparison?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface-2)] px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">{label}</p>
      <p
        className={`mt-1 text-xl font-bold ${accent ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}
      >
        {value}
      </p>
      {delta && (
        <p className="mt-0.5 text-[11px] font-medium" style={{ color: TONE_COLOR[delta.tone] }}>
          {trendChipText(delta, priorEmpty, comparison)}
        </p>
      )}
      {hint && <p className="mt-0.5 text-[11px] text-[var(--color-text-faint)]">{hint}</p>}
    </div>
  );
}
