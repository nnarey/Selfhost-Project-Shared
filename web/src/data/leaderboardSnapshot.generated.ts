import type {
  LocalDevicesResponse,
  LocalLeaderboardResponse,
  LocalOverallStats,
  LocalRosterSummary,
  LocalSeasonStatus,
  LocalWeeklyStatsRow,
} from "./localApi";

/** Placeholder. `build:static-leaderboard` fills this in for the static bundle, then restores it. */
export const LEADERBOARD_SNAPSHOT: {
  capturedAt: string;
  boards: Record<string, LocalLeaderboardResponse>;
  roster: LocalRosterSummary;
  devices: LocalDevicesResponse;
  season: LocalSeasonStatus;
  stats: Record<string, LocalOverallStats>;
  weekly: LocalWeeklyStatsRow[];
} | null = null;
