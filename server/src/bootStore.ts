import fs from "node:fs";
import path from "node:path";
import { ENV } from "./env.js";
import {
  activityCount,
  assignmentCount,
  closeDb,
  getDb,
  quarantineCount,
  restoreRosterFromAside,
  restoreRosterFromFile,
  setAsideLiveDatabase,
} from "./db.js";
import { ensureAdminParticipants } from "./config/adminEmails.js";
import { syncParticipantHandlesFromEmail } from "./participants.js";
import {
  purgeCheckoutInventoryOnce,
  purgeDemoData,
  purgeNonPermanentParticipantsOnce,
} from "./seed.js";
import { importCommittedSplunkSnapshot, importMissedSnapshots } from "./import/snapshot.js";
import { ensureDefaultMappingProfiles } from "./import/mapping.js";
import { importJiraTriageFile } from "./jira/snapshot.js";

const ALL_TIME_RESET_VALUE = "2026-10-05-all-time-csv";
const ALL_TIME_RESET_KEY = "all_time_database_reset";
/** Days on or before the all-time export are already inside that file. */
const ALL_TIME_DAY = "2026-10-02";

function rosterPath(): string {
  return path.join(path.dirname(ENV.splunkSnapshotPath), "roster.json");
}

function ensureRoster(): boolean {
  if (assignmentCount() > 0) return false;
  if (restoreRosterFromAside(ENV.databasePath) > 0) return true;
  return restoreRosterFromFile(rosterPath()) > 0;
}

function allTimeResetDone(): boolean {
  try {
    const row = getDb()
      .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
      .get(ALL_TIME_RESET_KEY) as { value: string } | undefined;
    return row?.value === ALL_TIME_RESET_VALUE;
  } catch {
    // An unreadable file is not a finished reset. The caller sets it aside.
    closeDb();
    return false;
  }
}

function rememberAllTimeReset(): void {
  getDb()
    .prepare(
      `INSERT INTO sync_meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(ALL_TIME_RESET_KEY, ALL_TIME_RESET_VALUE);
}

/**
 * Harbor keeps its SQLite file across deploys. This boot sets that file aside and
 * scores a new one from the all-time snapshot. Later boots leave the new file
 * in place and only import days after 2026-10-02.
 */
function replaceDatabaseWithAllTime(): boolean {
  if (ENV.allTimeReset !== ALL_TIME_RESET_VALUE) return false;
  if (allTimeResetDone()) return false;
  const csvPath = path.join(path.dirname(ENV.splunkSnapshotPath), "snapshots", `${ALL_TIME_DAY}.csv`);
  if (!fs.existsSync(csvPath)) {
    console.error(`All-time snapshot missing, leaving the database in place: ${csvPath}`);
    return false;
  }
  console.log(`Replacing the database with ${csvPath}`);
  setAsideLiveDatabase(ENV.databasePath);
  getDb();
  ensureDefaultMappingProfiles();
  if (ENV.webDist && ENV.harborTrustIdentity && !ENV.fleetEnabled) {
    purgeCheckoutInventoryOnce("boot");
    purgeNonPermanentParticipantsOnce("boot");
  }
  restoreRosterFromFile(rosterPath());
  const snap = importCommittedSplunkSnapshot(csvPath);
  rememberAllTimeReset();
  console.log(
    `All-time database imported csvRows=${snap.csvRows ?? 0} accepted=${snap.acceptedActivity ?? 0} quarantined=${snap.quarantinedActivity ?? 0} skipped=${snap.skipped ?? false}`,
  );
  return true;
}

/** Open the database and import committed snapshots. Synchronous SQLite; do not call this on the HTTP thread. */
export function initDataStore(): void {
  const replaced = replaceDatabaseWithAllTime();
  getDb();
  ensureDefaultMappingProfiles();
  // Harbor strips the synthetic Northline roster so it cannot mix with a live Fleet import.
  // The laptop copy is that roster: wiping it on every boot leaves the leaderboard at zero.
  if (ENV.webDist) purgeDemoData("boot");
  if (ENV.webDist && ENV.harborTrustIdentity && !ENV.fleetEnabled) {
    purgeCheckoutInventoryOnce("boot");
    purgeNonPermanentParticipantsOnce("boot");
  }
  ensureAdminParticipants();
  syncParticipantHandlesFromEmail();
  // A previous boot deleted every assignment and then committed the Splunk files as quarantined.
  // Those hashes are skipped forever unless we put the roster back and replay them.
  const restored = ensureRoster();
  const retryHistory = restored || (activityCount() === 0 && quarantineCount() > 0);
  if (retryHistory) {
    console.log("Replaying snapshots so quarantined events can be scored");
  }
  // Separate from the rolling import below: a replay failure reported as "Splunk snapshot import
  // failed" sends whoever reads the log looking in the wrong place. Catching up is also optional —
  // if it fails, today's file should still import.
  try {
    const missed = importMissedSnapshots(undefined, {
      retryIfQuarantine: retryHistory,
      afterDay: replaced || allTimeResetDone() ? ALL_TIME_DAY : undefined,
    });
    if (missed.imported > 0) {
      console.log(
        `Replayed ${missed.imported} missed snapshot(s) (${missed.days.join(", ")}), accepted=${missed.accepted}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Archived snapshot replay failed (continuing to today's import): ${message}`);
  }
  try {
    const snap = importCommittedSplunkSnapshot();
    if (snap.skipped) {
      console.log(`Splunk snapshot import skipped (${snap.reason})`);
    } else {
      console.log(
        `Splunk snapshot imported batch=${snap.batchId} csvRows=${snap.csvRows} accepted=${snap.acceptedActivity} quarantined=${snap.quarantinedActivity}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Splunk snapshot import failed (serving last DB state): ${message}`);
  }
  try {
    const jiraTriage = importJiraTriageFile();
    if (jiraTriage.skipped) {
      console.log(`Jira triage snapshot skipped (${jiraTriage.reason})`);
    } else {
      console.log(
        `Jira triage snapshot: credited=${jiraTriage.credited} moved=${jiraTriage.moved} rejected=${jiraTriage.rejected} unchanged=${jiraTriage.unchanged}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Jira triage snapshot import failed: ${message}`);
  }
}
