import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../db.js";
import { seedDemoData } from "../seed.js";
import { ensureDefaultMappingProfiles } from "../import/mapping.js";
import { beginImport, uploadImportFiles, previewImport, commitImport } from "../import/pipeline.js";
import { getLeaderboard } from "../scoring/engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../../fixtures");

// Refresh fixtures to current week first
await import("./generateFixtures.js");

getDb();
ensureDefaultMappingProfiles();
seedDemoData("import-fixtures");

const splunkCsv = fs.readFileSync(path.join(fixturesDir, "activity_events.csv"), "utf8");
const fleetCsv = fs.readFileSync(path.join(fixturesDir, "assignments.csv"), "utf8");

const begin = beginImport("cli", {
  exportTimeUtc: new Date().toISOString(),
  exportTimezone: "America/Phoenix",
});
const upload = uploadImportFiles("cli", begin.batchId, { splunkCsv, fleetCsv });
const preview = previewImport("cli", begin.batchId);
const commit = commitImport("cli", begin.batchId);
const board = getLeaderboard();

console.log(
  JSON.stringify(
    {
      batchId: begin.batchId,
      upload: { splunkRows: upload.splunkRows, fleetRows: upload.fleetRows },
      preview: {
        acceptedActivity: preview.acceptedActivity,
        quarantinedActivity: preview.quarantinedActivity,
        acceptedAssignments: preview.acceptedAssignments,
        rejectedActivity: preview.rejectedActivity,
      },
      scores: commit.scores,
      top3: board.entries.slice(0, 3).map((e) => ({
        rank: e.rank,
        name: e.name,
        cameraId: e.cameraId,
        totalPoints: e.totalPoints,
      })),
      freshness: board.freshness,
    },
    null,
    2,
  ),
);

closeDb();
