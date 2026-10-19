import type { LocalTransportRow } from "../data/localApi";

/**
 * Upload success by network path.
 *
 * A blended upload rate averages two paths that behave differently, so the single figure hides
 * which one is failing. Two rows and their intervals answer that directly — a chart would add
 * nothing to two numbers.
 */
export default function UploadTransports({
  rows,
  windowPhrase,
}: {
  rows: LocalTransportRow[];
  /** Mid-sentence name of the window the rows cover, e.g. "the last 7 days". */
  windowPhrase: string;
}) {
  if (rows.length < 2) return null;

  // Worst path first: the point of the split is to find the one that needs attention.
  const ordered = [...rows].sort((a, b) => (a.rate ?? 100) - (b.rate ?? 100));
  const best = Math.max(...rows.map((r) => r.rate ?? 0));

  return (
    <div className="mt-6">
      <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">By network path</p>
      <h3 className="text-base font-bold text-[var(--color-text)]">Upload success by transport</h3>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        How uploads fare depending on the path they take off the camera, over {windowPhrase}.
      </p>

      <div className="mt-3 overflow-x-auto rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface-2)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border-soft)] text-left">
              {["Transport", "Uploads", "Failed", "Success rate"].map((h, i) => (
                <th
                  key={h}
                  className={`px-4 py-2 text-xs uppercase tracking-wide text-[var(--color-text-faint)] ${i === 0 ? "" : "text-right"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((r) => {
              // Flag the laggard only when its interval clears the best path's rate, so a thin
              // sample is not presented as a finding.
              const behind =
                r.ci95Upper !== null && r.rate !== null && r.rate < best && r.ci95Upper < best;
              return (
                <tr key={r.transport || "unknown"} className="border-b border-[var(--color-border-soft)] last:border-0">
                  <td className="px-4 py-2 font-medium text-[var(--color-text)]">
                    {r.label}
                    {behind && (
                      <span className="ml-2 text-[11px] font-semibold" style={{ color: "#fab219" }}>
                        {" "}▲ worse path
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--color-text-muted)]">
                    {r.total.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--color-text)]">
                    {r.failures.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--color-text-muted)]">
                    {r.rate === null ? "—" : `${r.rate}%`}
                    {r.ci95Lower !== null && (
                      <span className="ml-1 text-[11px] text-[var(--color-text-faint)]">
                        ({r.ci95Lower}–{r.ci95Upper})
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
