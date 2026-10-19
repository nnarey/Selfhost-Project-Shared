import { audit, getDb, nowISO } from "../db.js";
import { ENV } from "../env.js";
import { phoenixMidnightUtcISO } from "../week.js";

/**
 * Kickoff for the real biweekly competition. Everything scored before this is preseason — test
 * data from people trying the app out — so the board is wiped once, automatically, the moment the
 * season opens.
 *
 * Phoenix midnight is the same instant as Pacific midnight while Pacific is on daylight time, and
 * it is the boundary the week/biweek maths already uses, so the countdown lands exactly on a period
 * edge rather than a few hours off it.
 */
const DEFAULT_SEASON_START_DATE = "2026-08-31";
const SEASON_STARTED_KEY = "season_started_at";

export function seasonStartUtcISO(): string {
  const raw = (ENV.seasonStartDate || DEFAULT_SEASON_START_DATE).trim();
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : DEFAULT_SEASON_START_DATE;
  return phoenixMidnightUtcISO(ymd, ENV.weekTimezone);
}

function seasonStartedAt(): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(SEASON_STARTED_KEY) as { value: string } | undefined;
  return row?.value || null;
}

export function getSeasonStatus(): {
  startsAtUtc: string;
  started: boolean;
  startedAtUtc: string | null;
} {
  const startsAtUtc = seasonStartUtcISO();
  const startedAtUtc = seasonStartedAt();
  return {
    startsAtUtc,
    started: Boolean(startedAtUtc) || Date.now() >= new Date(startsAtUtc).getTime(),
    startedAtUtc,
  };
}

/** Weeks starting before this are preseason and stay off the competition boards. Null until kickoff. */
export function competitionWeekFloorUtc(): string | null {
  return getSeasonStatus().started ? seasonStartUtcISO() : null;
}

/**
 * Open the season once, the first time anything runs at or after kickoff.
 *
 * Guarded by a marker so it cannot fire twice — this is called from the leaderboard read path as
 * well as boot, so the season opens on its own without needing a deploy or an admin to be watching
 * at midnight.
 *
 * Kickoff deletes nothing. It used to wipe scores, activity and reports, but the all-time overall
 * board is meant to keep counting across the whole program, and findings reported during preseason
 * are still real findings worth keeping on the record. Only the permanent and checkout boards
 * reset, and they do it by ignoring weeks that began before this marker (see
 * `competitionWeekFloorUtc`) rather than by deleting the rows underneath them. That matters because
 * the first competition period straddles kickoff — deleting was the old way to keep preseason
 * points out of it, and it took the overall board and the reports down with them.
 */
export function startSeasonIfDue(actor = "season"): { started: boolean; alreadyStarted: boolean } {
  if (seasonStartedAt()) return { started: false, alreadyStarted: true };
  if (Date.now() < new Date(seasonStartUtcISO()).getTime()) {
    return { started: false, alreadyStarted: false };
  }

  const startedAt = nowISO();
  const floor = seasonStartUtcISO();
  getDb()
    .prepare(
      `INSERT INTO sync_meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(SEASON_STARTED_KEY, startedAt);

  audit(actor, "season.start", {
    entityType: "weekly_scores",
    entityId: floor,
    newValue: { startedAt, competitionBoardsCountFrom: floor, deleted: "nothing" },
  });
  console.log(
    `Season started — permanent/checkout boards now count from ${floor}; overall and reports keep preseason history`,
  );

  return { started: true, alreadyStarted: false };
}
