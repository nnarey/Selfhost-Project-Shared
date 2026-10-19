import type { LocalDeviceFailureRow } from "../data/localApi";

/**
 * Cameras with failed operations.
 *
 * A table rather than a chart: fifteen cameras is past the point where colour can tell classes
 * apart, and the useful comparison here is exact counts, not relative bar length.
 *
 * Ordered by failure count, because that is the question. The rate and its interval sit alongside
 * because count alone misleads in the other direction — the camera with the most failures may
 * simply be the busiest.
 *
 * Every column but the last covers the page's selected window. "Failed in 24h" keeps its own
 * 24-hour anchor at every window, which is what makes a wider span actionable: nine failures over
 * two weeks reads very differently depending on whether two of them were yesterday.
 */
export default function DeviceFailures({
  rows,
  fleetUploadRate,
  windowPhrase,
}: {
  rows: LocalDeviceFailureRow[];
  fleetUploadRate: number | null;
  /** Mid-sentence name of the window the counts cover, e.g. "the last 7 days". */
  windowPhrase: string;
}) {
  if (!rows.length) return null;

  /**
   * Worse than the fleet by more than sampling noise: the whole interval sits below the fleet
   * rate. A camera with four failures in thirteen uploads looks alarming at 69%, but its interval
   * runs to 87% — that is not evidence of a bad unit, it is thirteen uploads.
   */
  const notablyWorse = (r: LocalDeviceFailureRow) =>
    fleetUploadRate !== null &&
    r.ci95Upper !== null &&
    r.uploadTotal > 0 &&
    r.ci95Upper < fleetUploadRate;

  return (
    <div className="mt-6">
      <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">By camera</p>
      <h3 className="text-base font-bold text-[var(--color-text)]">Cameras with failed operations</h3>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Upload and recording failures per camera over {windowPhrase}, with whoever currently holds
        it. A camera marked{" "}
        <span className="font-semibold" style={{ color: "#fab219" }}>▲ worse than fleet</span> is
        below the fleet rate by more than sampling noise — the rest may simply be the busiest. The
        last column stays on its own 24-hour anchor, so a wide window still shows what failed
        yesterday.
      </p>

      <div className="mt-3 overflow-x-auto rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface-2)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border-soft)] text-left">
              {["Camera", "Held by", "Upload failures", "Uploads", "Upload success", "Recording failures", "Failed in 24h"].map(
                (h, i) => (
                  <th
                    key={h}
                    className={`px-4 py-2 text-xs uppercase tracking-wide text-[var(--color-text-faint)] ${i === 0 ? "" : "text-right"}`}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cameraId} className="border-b border-[var(--color-border-soft)] last:border-0">
                <td className="px-4 py-2 font-medium text-[var(--color-text)]">
                  {r.cameraId}
                  {notablyWorse(r) && (
                    <span className="ml-2 text-[11px] font-semibold" style={{ color: "#fab219" }}>{" "}
                      ▲ worse than fleet
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-[var(--color-text-muted)]">
                  {r.holderName ?? <span className="text-[var(--color-text-faint)]">unassigned</span>}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-[var(--color-text)]">
                  {r.uploadFailures}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-[var(--color-text-muted)]">
                  {r.uploadTotal}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-[var(--color-text-muted)]">
                  {r.uploadRate === null ? "—" : `${r.uploadRate}%`}
                  {r.ci95Lower !== null && (
                    <span className="ml-1 text-[11px] text-[var(--color-text-faint)]">
                      ({r.ci95Lower}–{r.ci95Upper})
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-[var(--color-text-muted)]">
                  {r.recordingFailures || "—"}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-[var(--color-text)]">
                  {((r.uploadFailuresLast24h ?? 0) + (r.recordingFailuresLast24h ?? 0)) > 0 ? (
                    <span className="font-medium" style={{ color: "#d03b3b" }}>
                      {(r.uploadFailuresLast24h ?? 0) + (r.recordingFailuresLast24h ?? 0)}
                    </span>
                  ) : (
                    <span className="text-[var(--color-text-faint)]">0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
