import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ENV } from "../env.js";
import { getDb } from "../db.js";
import { beginImport, uploadImportFiles, previewImport, commitImport } from "./pipeline.js";

const ACTOR = "gha-snapshot";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function alreadyImported(hash: string, retryIfQuarantine: boolean): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT accepted_count FROM import_batches
       WHERE status = 'committed' AND splunk_hash = ?
       ORDER BY committed_at DESC
       LIMIT 1`,
    )
    .get(hash) as { accepted_count: number | null } | undefined;
  if (!row) return false;
  if (!retryIfQuarantine) return true;
  // Same CSV with leftover quarantine must re-run after assignments land;
  // otherwise Harbor Stats stays empty forever after the first boot.
  const leftover = db.prepare(`SELECT count(*) AS c FROM quarantined_activity`).get() as { c: number };
  if (leftover.c > 0) return false;
  // The one-time checkout wipe deletes those quarantine rows before replay.
  // A batch that scored nothing still has to run again once assignments exist.
  return Number(row.accepted_count) > 0;
}

function dataRowCount(csv: string): number {
  const lines = csv.split(/\r?\n/).filter((ln) => ln.trim().length > 0);
  return Math.max(0, lines.length - 1);
}

export function snapshotCsvPath(): string {
  return ENV.splunkSnapshotPath;
}

/**
 * Import the GHA-committed Splunk CSV into the local/EFS database.
 * Never talks to Splunk. No-op when the file is missing or already imported.
 */
export function importCommittedSplunkSnapshot(
  csvPath = snapshotCsvPath(),
  opts: { retryIfQuarantine?: boolean } = {},
): {
  skipped: boolean;
  reason?: string;
  batchId?: string;
  acceptedActivity?: number;
  quarantinedActivity?: number;
  csvRows?: number;
} {
  if (!fs.existsSync(csvPath)) {
    return { skipped: true, reason: "missing" };
  }
  const splunkCsv = fs.readFileSync(csvPath, "utf8");
  if (!splunkCsv.trim() || dataRowCount(splunkCsv) < 1) {
    return { skipped: true, reason: "empty" };
  }
  const hash = sha256(splunkCsv);
  if (alreadyImported(hash, opts.retryIfQuarantine !== false)) {
    return { skipped: true, reason: "unchanged" };
  }

  // Archived snapshots carry their meta as a sibling named after the CSV (2026-09-14.csv →
  // 2026-09-14.json); the rolling export uses the shared splunk-export-meta.json. Try the
  // specific one first so a replay gets its own export time rather than today's.
  const sibling = csvPath.replace(/\.csv$/i, ".json");
  const metaPath = fs.existsSync(sibling)
    ? sibling
    : path.join(path.dirname(csvPath), "splunk-export-meta.json");
  let exportTimeUtc = new Date().toISOString();
  let exportWindowHours: number | undefined;
  try {
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
        latestTime?: string;
        windowHours?: number;
      };
      if (meta.latestTime) exportTimeUtc = new Date(meta.latestTime).toISOString();
      // A wide backfill declares its span here so the import lookback can stretch to match.
      if (Number.isFinite(meta.windowHours) && (meta.windowHours ?? 0) > 0) {
        exportWindowHours = Number(meta.windowHours);
      }
    }
  } catch {
    // keep now
  }

  const csvRows = dataRowCount(splunkCsv);
  const begin = beginImport(ACTOR, {
    exportTimeUtc,
    exportTimezone: "America/Phoenix",
    exportWindowHours,
  });
  uploadImportFiles(ACTOR, begin.batchId, { splunkCsv });
  const preview = previewImport(ACTOR, begin.batchId);
  const commit = commitImport(ACTOR, begin.batchId);
  return {
    skipped: false,
    batchId: commit.batchId,
    acceptedActivity: preview.acceptedActivity,
    quarantinedActivity: preview.quarantinedActivity,
    csvRows,
  };
}


/**
 * Replay every archived snapshot the database has not seen, oldest first.
 *
 * The rolling data/splunk-activity.csv is overwritten every morning by the GitHub Action, and the
 * server only imports at boot — so a day with no restart used to be lost for good. The ETL now
 * keeps a dated copy under data/snapshots/, and this walks them in order at boot.
 *
 * Safe to run every time: importCommittedSplunkSnapshot hashes the file and skips anything already
 * committed, and events upsert by event_id, so overlapping windows converge rather than duplicate.
 */
export function importMissedSnapshots(
  dir = path.join(path.dirname(snapshotCsvPath()), "snapshots"),
  opts: { retryIfQuarantine?: boolean; afterDay?: string } = {},
): {
  scanned: number;
  imported: number;
  accepted: number;
  days: string[];
} {
  if (!fs.existsSync(dir)) return { scanned: 0, imported: 0, accepted: 0, days: [] };
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f))
    .sort(); // ISO names sort chronologically, and order matters for assignment attribution.

  let imported = 0;
  let accepted = 0;
  const days: string[] = [];
  for (const f of files) {
    const day = f.replace(/\.csv$/, "");
    if (opts.afterDay && day <= opts.afterDay) continue;
    try {
      const r = importCommittedSplunkSnapshot(path.join(dir, f), {
        retryIfQuarantine: opts.retryIfQuarantine === true,
      });
      if (r.skipped) continue;
      imported += 1;
      accepted += r.acceptedActivity || 0;
      days.push(day);
    } catch (err) {
      // One bad archived day must not stop the others, or a single corrupt file blocks catch-up
      // forever. Report and continue.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Snapshot replay failed for ${f}: ${message}`);
    }
  }
  return { scanned: files.length, imported, accepted, days };
}
