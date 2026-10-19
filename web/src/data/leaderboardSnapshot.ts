import type {
  LocalDevicesResponse,
  LocalLeaderboardResponse,
  LocalOverallStats,
  LocalRosterSummary,
  LocalSeasonStatus,
  LocalWeeklyStatsRow,
} from "./localApi";
import type { StatsWindowKey } from "../config/statsWindows";

export function snapshotBoardKey(track: string, weekStart?: string): string {
  return weekStart ? `${track}|${weekStart}` : track;
}

async function loadSnapshot() {
  const { LEADERBOARD_SNAPSHOT } = await import("./leaderboardSnapshot.generated");
  if (!LEADERBOARD_SNAPSHOT) {
    throw new Error("This static page was built without a data snapshot.");
  }
  return LEADERBOARD_SNAPSHOT;
}

/** Read one baked leaderboard view. Only called from the static site build. */
export async function readSnapshotBoard(
  track: "permanent" | "checkout" | "overall",
  weekStart?: string,
): Promise<LocalLeaderboardResponse> {
  const snapshot = await loadSnapshot();
  const board = snapshot.boards[snapshotBoardKey(track, weekStart)];
  if (!board) {
    throw new Error("That leaderboard view is not in this snapshot.");
  }
  return board;
}

export async function readSnapshotRoster(): Promise<LocalRosterSummary> {
  return (await loadSnapshot()).roster;
}

export async function readSnapshotDevices(): Promise<LocalDevicesResponse> {
  return (await loadSnapshot()).devices;
}

export async function readSnapshotSeason(): Promise<LocalSeasonStatus> {
  return (await loadSnapshot()).season;
}

export async function readSnapshotStats(windowKey: StatsWindowKey): Promise<LocalOverallStats> {
  const stats = (await loadSnapshot()).stats[windowKey];
  if (!stats) throw new Error("That stats window is not in this snapshot.");
  return stats;
}

export async function readSnapshotWeekly(): Promise<LocalWeeklyStatsRow[]> {
  return (await loadSnapshot()).weekly;
}
