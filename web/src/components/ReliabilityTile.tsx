import {
  RELIABILITY_STATUS,
  statusFor,
  type ReliabilitySpec,
} from "../config/reliability";
import type { LocalReliabilityMetric, LocalStatTrend } from "../data/localApi";

const TONE_COLOR: Record<string, string> = {
  better: "#0ca30c",
  worse: "#d03b3b",
  neutral: "var(--color-text-faint)",
};

/** Null when there is nothing to compare against — the all-time window has no earlier span. */
function trendLine(
  trend: LocalStatTrend | undefined,
  comparison: string | null,
): { text: string; color: string } | null {
  if (!trend || !comparison) return null;
  if (trend.direction === "unknown") {
    return { text: `no ${comparison} rate`, color: TONE_COLOR.neutral };
  }
  if (trend.direction === "flat" || trend.delta === 0) {
    return { text: `same vs ${comparison}`, color: TONE_COLOR.neutral };
  }
  const n = trend.delta ?? 0;
  const sign = n > 0 ? "+" : "";
  const glyph = trend.direction === "up" ? "▲" : "▼";
  const word = trend.tone === "better" ? "better" : "worse";
  return {
    text: `${glyph} ${sign}${n}pp ${word} vs ${comparison}`,
    color: TONE_COLOR[trend.tone] ?? TONE_COLOR.neutral,
  };
}

/**
 * One row of the reliability scorecard.
 *
 * The selected window's rate is the headline (what happened over the span being read). All-time and
 * the committed target sit underneath so the scorecard is still readable. Wilson CI is optional: it
 * is precise but noisy on a first scan.
 *
 * When the selected window *is* all-time the two figures are the same number, so the all-time
 * subline is dropped rather than printed twice.
 */
export default function ReliabilityTile({
  spec,
  current,
  allTime,
  windowLabel,
  windowPhrase,
  comparisonLabel,
  showCi = false,
}: {
  spec: ReliabilitySpec;
  /** Metric over the selected window. */
  current?: LocalReliabilityMetric;
  allTime?: LocalReliabilityMetric;
  /** Compact name of the selected window, e.g. "last 7 days". Sits beside the target. */
  windowLabel: string;
  /** Mid-sentence name of the same window, e.g. "the last 7 days". */
  windowPhrase: string;
  /** Inline name of the comparison span, or null when there is none (all-time). */
  comparisonLabel: string | null;
  showCi?: boolean;
}) {
  const measuredWindow = current && current.total > 0 && current.rate !== null;
  const measuredAll = allTime && allTime.total > 0;
  const isAllTimeWindow = comparisonLabel === null;
  const s = measuredWindow
    ? RELIABILITY_STATUS[statusFor(current.rate, spec.target ?? 100, current.ci95Upper)]
    : measuredAll
      ? RELIABILITY_STATUS[statusFor(allTime.rate, spec.target ?? 100, allTime.ci95Upper)]
      : RELIABILITY_STATUS.unknown;
  const trend = trendLine(current?.trend, comparisonLabel);

  return (
    <div className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface-2)] p-4">
      <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">{spec.label}</p>

      <div className="mt-1 flex items-baseline gap-2">
        <span
          className={`text-2xl font-bold ${measuredWindow ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]"}`}
        >
          {measuredWindow ? `${current.rate}%` : "–"}
        </span>
        {spec.target != null ? (
          <span className="text-[11px] text-[var(--color-text-faint)]">
            {windowLabel} · target {spec.target}%
          </span>
        ) : (
          <span className="text-[11px] text-[var(--color-text-faint)]">
            target to be defined{spec.due ? ` · ${spec.due}` : ""}
          </span>
        )}
      </div>

      <p className="mt-1 text-[11px] font-medium" style={{ color: s.fg }}>
        {s.glyph}{" "}
        {measuredWindow
          ? s.word
          : spec.tier === "raise"
            ? "metric not defined yet"
            : measuredAll
              ? `nothing in ${windowPhrase}`
              : "not measured yet"}
      </p>

      {(measuredAll || measuredWindow) && (
        <p className="mt-1 text-[11px] text-[var(--color-text-faint)]">
          {measuredAll && !isAllTimeWindow && <>All-time {allTime.rate}%</>}
          {measuredWindow && (
            <>
              {measuredAll && !isAllTimeWindow ? " · " : ""}
              {current.successes.toLocaleString()} of {current.total.toLocaleString()} in{" "}
              {windowPhrase}
            </>
          )}
        </p>
      )}

      {trend && (
        <p className="mt-1 text-[11px] font-medium" style={{ color: trend.color }}>
          {trend.text}
        </p>
      )}

      {showCi && measuredWindow && current.ci95Lower !== null && (
        <p className="mt-2 border-t border-[var(--color-border-soft)] pt-2 text-[11px] text-[var(--color-text-faint)]">
          95% CI {current.ci95Lower}–{current.ci95Upper}%
        </p>
      )}
    </div>
  );
}
