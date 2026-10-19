import { ensureParticipantsFromEvidenceAndActivity } from "../participants.js";
import { recomputeWeekScores } from "../scoring/engine.js";
import { listLeaderboardWeeks, defaultLeaderboardWeek, getLeaderboard } from "../scoring/engine.js";

const created = ensureParticipantsFromEvidenceAndActivity();
const weeks = listLeaderboardWeeks();
for (const ws of weeks) {
  const r = recomputeWeekScores(ws);
  console.log("recomputed", ws, "count", r.count, "top", r.entries[0]?.name, r.entries[0]?.totalPoints);
}
console.log(JSON.stringify({ created, defaultWeek: defaultLeaderboardWeek(), weeks }, null, 2));
const board = getLeaderboard();
console.log("default board top 8:");
for (const e of board.entries.slice(0, 8)) {
  console.log(e.rank, e.name, e.cameraId, e.totalPoints);
}
