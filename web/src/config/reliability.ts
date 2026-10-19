/**
 * The programme reliability scorecard: every target, and which ones we can measure yet.
 *
 * "Maintain" metrics carry a committed target and are computed from the daily Splunk CSV.
 * See SPLUNK-SEARCH-REQUIREMENTS.md.
 */
export interface ReliabilitySpec {
  key: string;
  label: string;
  /** Committed target, percent. Absent for metrics still being defined. */
  target?: number;
  tier: "maintain" | "raise";
  /** When the metric is expected to exist, for the ones still being defined. */
  due?: string;
}

export const RELIABILITY_SCORECARD: ReliabilitySpec[] = [
  // Each row is a success rate from the Splunk snapshot.
  { key: "recording", label: "Recording success", target: 99.99, tier: "maintain" },
  { key: "upload", label: "Fleet upload success", target: 99.0, tier: "maintain" },
  { key: "locationTime", label: "Location & time accuracy in Fleet", target: 99.0, tier: "maintain" },
  { key: "availability", label: "Camera availability & stability", target: 99.99, tier: "maintain" },
  {
    key: "battery",
    label: "Shifts without a low-battery alert",
    target: 99.0,
    tier: "maintain",
  },
  { key: "registration", label: "Registration success", target: 99.0, tier: "maintain" },
  { key: "connectivity", label: "Connection success on LTE and WiFi", target: 99.0, tier: "maintain" },
  { key: "videoQuality", label: "Video quality (frame drop, A/V sync)", target: 99.0, tier: "maintain" },
];

/** Status vocabulary for reliability tiles, and the rule that picks one. */

export const RELIABILITY_STATUS = {
  good: { fg: "#0ca30c", glyph: "●", word: "on target" },
  warning: { fg: "#fab219", glyph: "▲", word: "below target" },
  critical: { fg: "#d03b3b", glyph: "■", word: "well below target" },
  inconclusive: { fg: "var(--color-text-muted)", glyph: "~", word: "too few to say" },
  unknown: { fg: "var(--color-text-faint)", glyph: "–", word: "no data yet" },
} as const;

export type ReliabilityStatus = keyof typeof RELIABILITY_STATUS;

/**
 * Which status a rate earns against its target.
 *
 * Judged against the confidence interval, not the point estimate. One failure in 361 is 99.7%
 * against a 99.99% target, but the interval reaches 100 — the sample cannot separate the two, so
 * calling it a miss states more than the data supports.
 */
export function statusFor(
  rate: number | null,
  target: number,
  ci95Upper: number | null,
): ReliabilityStatus {
  if (rate === null) return "unknown";
  if (rate >= target) return "good";
  if (ci95Upper !== null && ci95Upper >= target) return "inconclusive";
  // A percentage point off a four-nines target is a very different thing from ten points off.
  return target - rate <= 1 ? "warning" : "critical";
}
