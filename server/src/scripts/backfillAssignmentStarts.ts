import { backfillOpenAssignmentStarts } from "../fleet/sync.js";
import { getDb } from "../db.js";

const n = backfillOpenAssignmentStarts("repair");
const row = getDb()
  .prepare(
    `SELECT min(assigned_at_utc) AS minAt, max(assigned_at_utc) AS maxAt, count(*) AS c
     FROM assignment_history
     WHERE status = 'open' AND source = 'fleet'`,
  )
  .get();
console.log(JSON.stringify({ backfilled: n, openStats: row }, null, 2));
