/*
 * Import a hand-exported Splunk CSV.
 *
 * For the case where someone runs web/splunk-search.spl in the Splunk UI, exports the results and
 * wants them in the database — a backfill wider than the daily Action's 24h pull, most often.
 *
 * The span matters. The import lookback defaults to 36h, so a 14-day export would have everything
 * past the first day and a half silently rejected. --window-hours declares the span and the
 * lookback stretches to match. Get it wrong low and rows are dropped; the summary says how many.
 *
 *   npm run import:csv -- ./export.csv --window-hours=336
 *   npm run import:csv -- ./export.csv --window-hours=336 --dry-run
 *   npm run import:csv -- ./export.csv --window-hours=336 --timezone=UTC
 */
import fs from "node:fs";
import path from "node:path";
import { beginImport, uploadImportFiles, previewImport, commitImport } from "../import/pipeline.js";
import { ensureDefaultMappingProfiles } from "../import/mapping.js";
import { getDb } from "../db.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const csvPath = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const windowHours = Number(flag("window-hours") || 24);
// Labels the batch only; event times in the CSV carry their own offsets. Overridable so an export
// taken in another zone is recorded as what it was rather than silently stamped Phoenix.
const timezone = flag("timezone") || "America/Phoenix";

if (!csvPath) {
  console.error("usage: npm run import:csv -- <file.csv> [--window-hours=336] [--timezone=UTC] [--dry-run]");
  process.exit(2);
}
if (!fs.existsSync(csvPath)) {
  console.error(`No such file: ${csvPath}`);
  process.exit(2);
}
if (!Number.isFinite(windowHours) || windowHours <= 0) {
  console.error(`--window-hours must be a positive number, got ${flag("window-hours")}`);
  process.exit(2);
}

ensureDefaultMappingProfiles();
getDb();

const splunkCsv = fs.readFileSync(csvPath, "utf8");
const dataRows = splunkCsv.split(/\r?\n/).filter((l) => l.trim()).length - 1;
console.log(`${path.basename(csvPath)}: ${dataRows} data rows, declared span ${windowHours}h, tz ${timezone}`);

const batch = beginImport("cli-import", {
  // Anchor to now: a hand export is taken now and reaches backwards by windowHours.
  exportTimeUtc: new Date().toISOString(),
  exportTimezone: timezone,
  exportWindowHours: windowHours,
});
uploadImportFiles("cli-import", batch.batchId, { splunkCsv });
const preview = previewImport("cli-import", batch.batchId);

console.log(`  accepted    ${preview.acceptedActivity}`);
console.log(`  quarantined ${preview.quarantinedActivity}  (no assignment interval covers the event)`);
console.log(`  rejected    ${preview.rejectedActivity}`);
const warnings = (preview.errors || []).filter((e) => e.severity === "warning");
const byMessage = new Map<string, number>();
for (const w of warnings) byMessage.set(w.message, (byMessage.get(w.message) || 0) + 1);
for (const [msg, n] of [...byMessage].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  console.log(`  ${String(n).padStart(5)}  ${msg}`);
}

if (dryRun) {
  console.log("\ndry run — nothing written. Re-run without --dry-run to commit.");
  process.exit(0);
}
commitImport("cli-import", batch.batchId);
console.log(`\ncommitted batch ${batch.batchId}`);
