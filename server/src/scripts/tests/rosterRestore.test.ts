/**
 * A boot that imported Splunk rows before any camera assignment existed committed
 * those files as quarantined and then skipped them forever. Restoring the roster
 * must replay the snapshots and produce scored activity.
 *
 * Refuses to write server/data/fieldcam.sqlite.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV } from "../../env.js";
import { activityCount, assignmentCount, closeDb, getDb, quarantineCount } from "../../db.js";
import { importMissedSnapshots } from "../../import/snapshot.js";
import { initDataStore } from "../../bootStore.js";
import { getLeaderboard } from "../../scoring/engine.js";

const LIVE_DB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/fieldcam.sqlite");

function assertThrowaway(dbPath: string): void {
  if (path.resolve(dbPath) === LIVE_DB) {
    console.error(`refusing to write the live database: ${dbPath}`);
    process.exit(2);
  }
}

assertThrowaway(ENV.databasePath);
getDb();
const first = importMissedSnapshots();
console.log(
  `without roster: assignments=${assignmentCount()} activity=${activityCount()} quarantine=${quarantineCount()} imported=${first.imported} accepted=${first.accepted}`,
);
if (assignmentCount() !== 0) {
  console.error("expected the fresh database to have no assignments");
  process.exit(1);
}
if (quarantineCount() < 1 || activityCount() !== 0) {
  console.error("expected the first import to quarantine every row");
  process.exit(1);
}
closeDb();
initDataStore();
const assignments = assignmentCount();
const activity = activityCount();
console.log(`after restore: assignments=${assignments} activity=${activity} quarantine=${quarantineCount()}`);
if (assignments < 1 || activity < 1000) {
  console.error("roster restore did not score the quarantined snapshots");
  process.exit(1);
}
const board = getLeaderboard(undefined, "permanent");
const top = [...board.entries].sort((a, b) => b.totalPoints - a.totalPoints)[0];
console.log(
  `permanent ${board.weekStart}: ${top ? `${top.name} ${top.totalPoints} ${top.cameraId ?? ""}` : "no rows"}`,
);
if (!top || top.totalPoints < 1000) {
  console.error("permanent board did not score after roster restore");
  process.exit(1);
}
console.log("PASS roster restore replayed quarantined snapshots");
closeDb();
