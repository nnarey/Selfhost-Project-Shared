/**
 * Progress toward a fixed target.
 *
 * A meter, not a chart: this is one ratio against one limit, which is the case where a chart adds
 * nothing a bar and a number don't already say.
 *
 * The fill is a single hue rather than a severity ramp (accent -> warning -> danger). Severity
 * ramps are for meters where filling up is bad — a quota, a disk. Here filling up is the goal, so
 * colouring low progress as "danger" would editorialise a program that has barely started.
 */

/* Both validated against the card surface for lightness, chroma and 3:1 contrast. They are CSS
   variables rather than literals so the meter follows the theme. */
const FILL = "var(--color-series)";
const TRACK = "var(--color-series-track)";

export interface GoalMeterProps {
  label: string;
  current: number;
  goal: number;
  /** Formats both the value and the goal. */
  format: (n: number) => string;
  /** Most recent complete week's contribution, used for the pace line. Omit to hide it. */
  perWeek?: number | null;
  unit: string;
}

export default function GoalMeter({
  label,
  current,
  goal,
  format,
  perWeek,
  unit,
}: GoalMeterProps) {
  const pct = goal > 0 ? Math.min(100, (current / goal) * 100) : 0;
  const remaining = Math.max(0, goal - current);
  const weeksLeft = perWeek && perWeek > 0 ? remaining / perWeek : null;

  return (
    <div className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface-2)] p-5">
      <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">{label}</p>

      <div className="mt-2 flex items-baseline gap-2">
        {/* Hero-scale value uses proportional figures — tabular-nums looks loose at this size. */}
        <span className="text-4xl font-bold text-[var(--color-text)]">{format(current)}</span>
        <span className="text-sm text-[var(--color-text-muted)]">of {format(goal)} {unit}</span>
      </div>

      <div
        className="mt-3 h-3 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: TRACK }}
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={
          [`${label}: ${format(current)} of ${format(goal)}`, unit].filter(Boolean).join(" ") +
          `, ${pct.toFixed(1)} percent`
        }
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          // A goal this early reads as an empty bar; keep a sliver visible so "started" and
          // "nothing yet" stay distinguishable.
          style={{ width: `${current > 0 ? Math.max(pct, 0.8) : 0}%`, backgroundColor: FILL }}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold" style={{ color: FILL }}>
          {pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%
        </span>
        <span className="text-[var(--color-text-muted)]">
          {[format(remaining), unit].filter(Boolean).join(" ")} to go
        </span>
      </div>

      {perWeek != null && perWeek > 0 && (
        <p className="mt-3 border-t border-[var(--color-border-soft)] pt-2 text-[11px] text-[var(--color-text-faint)]">
          Last full week added <span className="text-[var(--color-text-muted)]">{format(perWeek)}</span>.
          {weeksLeft != null && (
            <> At that rate, about{" "}
              <span className="text-[var(--color-text-muted)]">
                {weeksLeft < 1 ? "under a week" : `${Math.round(weeksLeft)} more week${Math.round(weeksLeft) === 1 ? "" : "s"}`}
              </span>.
            </>
          )}
        </p>
      )}
    </div>
  );
}
