/**
 * The spans the Overall Statistics page can be read over.
 *
 * Mirrors `STATS_WINDOWS` in `server/src/scoring/engine.ts` — these `key`s are what `/api/stats`
 * accepts as `?window=`. Kept here rather than fetched so the picker still renders when the API is
 * down and the user needs to try a different span. The server echoes the key it resolved back in
 * `window.key`, and falls back to 24h on anything it does not recognise, so a drift between the
 * two lists degrades to "shows 24 hours" rather than an error.
 *
 * Rolling durations, not calendar weeks: "last 7 days" is the seven days ending at the last Splunk
 * snapshot, which is the same anchor the trend comparisons use.
 */
export type StatsWindowKey = "24h" | "7d" | "14d" | "all";

export interface StatsWindowOption {
  key: StatsWindowKey;
  /** Button text. */
  label: string;
  /** Compact form for labels and headings, e.g. "last 7 days". */
  short: string;
  /** Article-inclusive form for mid-sentence use, e.g. "the last 7 days". */
  phrase: string;
  /** Inline form for the comparison span. Null for all-time, which has nothing before it. */
  prior: string | null;
}

export const STATS_WINDOWS: StatsWindowOption[] = [
  { key: "24h", label: "24 hours", short: "last 24h", phrase: "the last 24 hours", prior: "prior 24h" },
  { key: "7d", label: "Last week", short: "last 7 days", phrase: "the last 7 days", prior: "prior 7 days" },
  {
    key: "14d",
    label: "Last 2 weeks",
    short: "last 14 days",
    phrase: "the last 14 days",
    prior: "prior 14 days",
  },
  { key: "all", label: "All time", short: "all time", phrase: "the whole program", prior: null },
];

export const DEFAULT_STATS_WINDOW: StatsWindowKey = "24h";

export function statsWindow(key: StatsWindowKey): StatsWindowOption {
  return STATS_WINDOWS.find((w) => w.key === key) ?? STATS_WINDOWS[0];
}
