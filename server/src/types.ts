export type SignupStatus = "pending" | "approved" | "rejected";
export type AssignmentSource = "fleet" | "QR";
export type AssignmentStatus = "open" | "closed" | "provisional" | "returned";
export type EventType = "recording" | "upload" | "livestream";
export type ProfileStatus = "draft" | "scheduled" | "active" | "retired";
export type NudgeStatus = "pending" | "queued" | "sent" | "failed" | "cancelled";
export type ImportBatchStatus = "begun" | "uploaded" | "previewed" | "committed" | "failed";

export type MetricKey =
  | "recording_event_count"
  | "recording_count"
  | "short_recording_count"
  | "recording_hours"
  | "upload_count"
  | "livestream_count"
  | "mobile_action_count"
  | "pov_recording_count"
  | "approved_report_count"
  | "active_day_streak"
  | "inactive_day_count"
  | "challenge_bonus"
  | "manual_adjustment";

export const ALLOWLISTED_METRICS: MetricKey[] = [
  "recording_event_count",
  "recording_count",
  "short_recording_count",
  "recording_hours",
  "upload_count",
  "livestream_count",
  "mobile_action_count",
  "pov_recording_count",
  "approved_report_count",
  "active_day_streak",
  "inactive_day_count",
  "challenge_bonus",
  "manual_adjustment",
];

export interface ScoringRule {
  metricKey: MetricKey;
  label: string;
  aggregation: string;
  pointsPerUnit: number;
  minimum: number | null;
  cap: number | null;
  enabled: boolean;
  displayOrder: number;
  paramsJson: string;
}

export interface ScoringProfile {
  profileId: string;
  version: number;
  name: string;
  status: ProfileStatus;
  effectiveWeekStart: string | null;
  timezone: string;
  tieBreakersJson: string;
  createdAt: string;
  createdBy: string;
  approvedAt: string | null;
  approvedBy: string | null;
  notes: string | null;
}

export interface ScoreMetricBreakdown {
  metricKey: MetricKey;
  label: string;
  raw: number;
  points: number;
  enabled: boolean;
  displayOrder: number;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  cameraId: string | null;
  cameraIds?: string[];
  emailHash: string;
  photoUrl?: string | null;
  totalPoints: number;
  breakdown: ScoreMetricBreakdown[];
}

export interface ColumnMapping {
  sourceColumn: string;
  canonicalField: string;
}

export interface MappingProfile {
  id: string;
  name: string;
  sourceKind: "splunk" | "fleet";
  version: number;
  mappings: ColumnMapping[];
}
