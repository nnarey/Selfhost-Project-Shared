import type { LocalRuntimeEstimate } from "../data/localApi";

/**
 * Battery runtime, and the power draw it is derived from.
 *
 * Scoped to recording and buffering; livestreaming is deliberately excluded (see below).
 *
 * The power medians lead and the shift length follows, because the medians are the only things
 * actually measured — shift length is arithmetic on top of them, and FieldCam is an early sample, so the draw
 * will move with every firmware build. Showing the inputs makes it obvious *why* the estimate
 * moved rather than presenting a number that appears to change its mind.
 *
 * Livestreaming keeps a tile even though FieldCam emits no livestream telemetry. An empty tile is the
 * clearest available explanation of why the estimate excludes it.
 */
export default function RuntimeEstimate({
  runtime,
  windowPhrase,
}: {
  runtime: LocalRuntimeEstimate;
  /** Mid-sentence name of the selected window, e.g. "the last 7 days". */
  windowPhrase: string;
}) {
  const { states, shiftHours, shiftHoursLow, shiftHoursHigh, targetHours } = runtime;
  const pct = shiftHours === null ? 0 : Math.min(100, (shiftHours / targetHours) * 100);
  const meets = shiftHours !== null && shiftHours >= targetHours;
  // A range only means something when the two ends actually differ once rounded.
  const hasRange =
    shiftHoursLow !== null && shiftHoursHigh !== null && shiftHoursHigh - shiftHoursLow >= 0.1;

  return (
    <div className="mt-6">
      <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">Battery</p>
      <h3 className="text-base font-bold text-[var(--color-text)]">Runtime</h3>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Median power draw per camera state over {windowPhrase}, and the shift length it implies.
        Estimated from power draw rather than measured by running a battery flat.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {states.map((s) => (
          <div
            key={s.key}
            className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface-2)] p-3"
          >
            <p className="text-xs text-[var(--color-text-muted)]">{s.label}</p>
            <p className="mt-1 font-display text-xl text-[var(--color-text)] tabular-nums">
              {s.medianMw === null ? "—" : `${s.medianMw.toLocaleString()} mW`}
            </p>
            <p className="mt-0.5 text-[11px] text-[var(--color-text-faint)]">
              {s.samples > 0
                ? `median of ${s.samples.toLocaleString()} ${s.samples === 1 ? "sample" : "samples"} over ${windowPhrase}`
                : s.key === "livestreaming"
                  ? "No livestream telemetry — excluded from the estimate"
                  : runtime.allTimeSamples > 0
                    ? `None over ${windowPhrase} — widen the window`
                    : "Waiting on power data"}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface-2)] p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm text-[var(--color-text-muted)]">Estimated shift length</p>
          <p className="text-xs text-[var(--color-text-faint)]">Target {targetHours}h</p>
        </div>
        <p className="mt-1 font-display text-3xl tabular-nums" style={{ color: meets ? "#0ca30c" : "var(--color-text)" }}>
          {shiftHours === null ? "—" : `${shiftHours}h`}
          {hasRange && (
            <span className="ml-2 font-sans text-sm text-[var(--color-text-faint)]">
              ({shiftHoursLow}–{shiftHoursHigh}h)
            </span>
          )}
        </p>

        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--color-series-track)]">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${pct}%`, backgroundColor: meets ? "#0ca30c" : "var(--color-series)" }}
          />
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-text-faint)]">
          {runtime.batteryMah.toLocaleString()} mAh fresh · {runtime.nominalVolts}V nominal ·{" "}
          {runtime.recordingHours}h recording, remainder buffering · 720p · livestreaming excluded
        </p>
        {/* Power draw depends on camera config, so a median across configs measures nothing.
            Off-profile samples are excluded and counted here rather than silently folded in. */}
        {runtime.offProfileSamples > 0 && (
          <p className="mt-2 text-xs" style={{ color: "#fab219" }}>
            ▲ {runtime.offProfileSamples.toLocaleString()} sample
            {runtime.offProfileSamples === 1 ? "" : "s"} excluded — not on the 720p shift profile
            {runtime.offProfileConfigs.length > 0 && (
              <span className="text-[var(--color-text-faint)]">
                {" "}
                ({runtime.offProfileConfigs.map((c) => c.replace("VIDEO_QUALITY_", "")).join(", ")})
              </span>
            )}
          </p>
        )}
        {!runtime.computable && (
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            {runtime.allTimeSamples > 0 ? (
              <>
                Not enough power samples over {windowPhrase} — needs both buffering{" "}
                <span className="text-[var(--color-text)]">and</span> recording. There are{" "}
                <span className="text-[var(--color-text)]">
                  {runtime.allTimeSamples.toLocaleString()}
                </span>{" "}
                on-profile samples all-time; try a wider window.
              </>
            ) : (
              <>
                Needs buffering <span className="text-[var(--color-text)]">and</span> recording
                power before a shift length can be estimated. Add{" "}
                <code className="text-[11px] text-[var(--color-text)]">
                  PowerStateChanged
                </code>{" "}
                to the Splunk export to populate this.
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
