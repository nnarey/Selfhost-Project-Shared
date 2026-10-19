import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ENV } from "./env.js";
import {
  ensureDefaultScoringProfile,
  ensureRecordingEventCountRule,
  ensureShortRecordingRule,
  ensurePovRecordingRule,
  ensureMobileActionRule,
} from "./scoring/defaults.js";

let db: Database.Database | null = null;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS participants (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hub TEXT NOT NULL DEFAULT 'Phoenix',
  signup_status TEXT NOT NULL DEFAULT 'approved',
  account_user_id TEXT,
  camera_id TEXT,
  photo_url TEXT,
  enrolled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',
  last_slack_nudge_at TEXT,
  snooze_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cameras (
  camera_id TEXT PRIMARY KEY,
  label TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assignment_history (
  assignment_id TEXT PRIMARY KEY,
  camera_id TEXT NOT NULL,
  email TEXT NOT NULL,
  assigned_at_utc TEXT NOT NULL,
  unassigned_at_utc TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  import_batch_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assign_camera_time
  ON assignment_history(camera_id, assigned_at_utc);

CREATE TABLE IF NOT EXISTS activity_events (
  event_id TEXT PRIMARY KEY,
  event_time_utc TEXT NOT NULL,
  camera_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  duration_seconds REAL,
  purpose TEXT,
  status TEXT,
  email TEXT,
  week_start TEXT,
  import_batch_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_week ON activity_events(week_start, email);

CREATE TABLE IF NOT EXISTS daily_activity (
  email TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  week_start TEXT NOT NULL,
  recordings INTEGER NOT NULL DEFAULT 0,
  hours REAL NOT NULL DEFAULT 0,
  uploads INTEGER NOT NULL DEFAULT 0,
  livestreams INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, activity_date)
);

CREATE TABLE IF NOT EXISTS weekly_scores (
  email TEXT NOT NULL,
  week_start TEXT NOT NULL,
  scoring_profile_id TEXT NOT NULL,
  scoring_profile_version INTEGER NOT NULL,
  total_points REAL NOT NULL,
  rank INTEGER,
  camera_id TEXT,
  metrics_json TEXT NOT NULL,
  recomputed_at TEXT NOT NULL,
  PRIMARY KEY (email, week_start)
);

CREATE TABLE IF NOT EXISTS weekly_snapshots (
  week_start TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  scoring_profile_id TEXT NOT NULL,
  scoring_profile_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (week_start, revision)
);

CREATE TABLE IF NOT EXISTS scoring_profiles (
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  effective_week_start TEXT,
  timezone TEXT NOT NULL,
  tie_breakers_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  notes TEXT,
  PRIMARY KEY (profile_id, version)
);

CREATE TABLE IF NOT EXISTS scoring_rules (
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  metric_key TEXT NOT NULL,
  label TEXT NOT NULL,
  aggregation TEXT NOT NULL,
  points_per_unit REAL NOT NULL,
  minimum REAL,
  cap REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (profile_id, profile_version, metric_key)
);

CREATE TABLE IF NOT EXISTS reports (
  report_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  reported_at_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  approved_at_utc TEXT,
  approved_by TEXT,
  slack_message_url TEXT,
  week_start TEXT,
  report_text TEXT,
  -- Provenance, so the list doubles as a history: who filed it and who ruled on it. decided_* is
  -- written for rejections too, which approved_* is not, so a reject no longer loses its trail.
  created_at TEXT,
  created_by TEXT,
  decided_at_utc TEXT,
  decided_by TEXT
);

CREATE TABLE IF NOT EXISTS pending_nudges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  camera_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  queued_at TEXT,
  sent_at TEXT,
  error TEXT,
  week_start TEXT
);

CREATE TABLE IF NOT EXISTS import_batches (
  batch_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  export_time_utc TEXT,
  export_timezone TEXT,
  uploader TEXT,
  splunk_hash TEXT,
  fleet_hash TEXT,
  mapping_splunk_id TEXT,
  mapping_fleet_id TEXT,
  accepted_count INTEGER DEFAULT 0,
  rejected_count INTEGER DEFAULT 0,
  quarantined_count INTEGER DEFAULT 0,
  preview_json TEXT,
  created_at TEXT NOT NULL,
  committed_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS import_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  row_number INTEGER,
  stable_id TEXT,
  severity TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quarantined_activity (
  event_id TEXT PRIMARY KEY,
  event_time_utc TEXT NOT NULL,
  camera_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  duration_seconds REAL,
  purpose TEXT,
  status TEXT,
  batch_id TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_staging (
  batch_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (batch_id, source_kind, row_index)
);

CREATE TABLE IF NOT EXISTS mapping_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  mappings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenge_awards (
  award_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  camera_id TEXT,
  week_start TEXT NOT NULL,
  points REAL NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  awarded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_challenge_awards_week
  ON challenge_awards(week_start, email);

CREATE TABLE IF NOT EXISTS score_adjustments (
  adjustment_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  week_start TEXT NOT NULL,
  delta_points REAL NOT NULL,
  reason TEXT NOT NULL,
  set_to REAL,
  awarded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_score_adjustments_week
  ON score_adjustments(week_start, email);

-- People an admin has removed. Several code paths re-create participants automatically (the
-- permanent-holder roster seed, activity/assignment backfill), which otherwise undoes a removal on
-- the very next leaderboard load. A tombstone here suppresses those paths until the person is
-- registered against a camera in the agency again, which clears it.
CREATE TABLE IF NOT EXISTS removed_participants (
  email TEXT PRIMARY KEY,
  reason TEXT,
  removed_by TEXT NOT NULL,
  removed_at TEXT NOT NULL
);

-- Admin override moving one person's score on one camera to the other board. Default routing is
-- unchanged (by permanent-holder roster); a row here only exists for a deliberate exception, e.g.
-- a permanent holder who spent a period on a checkout camera.
CREATE TABLE IF NOT EXISTS leaderboard_track_overrides (
  email TEXT NOT NULL,
  camera_id TEXT NOT NULL,
  track TEXT NOT NULL,
  reason TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (email, camera_id)
);
`;

function isMalformedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes("malformed");
}

function openDatabase(dbPath: string): Database.Database {
  const opened = new Database(dbPath);
  try {
    opened.pragma("foreign_keys = ON");
    // Wait instead of failing the leaderboard when a deploy or import still holds the file.
    opened.pragma("busy_timeout = 30000");
    opened.pragma("journal_mode = WAL");
    return opened;
  } catch (err) {
    opened.close();
    throw err;
  }
}

/** Read pages, not just the header. A damaged file often opens and only fails on the next query. */
function assertReadable(database: Database.Database): void {
  const rows = database.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
  const bad = rows.map((r) => r.quick_check).filter((line) => line !== "ok");
  if (bad.length) {
    const first = bad.join("\n").split("\n").find((line) => line.trim() && line.trim() !== "*** in database main ***");
    throw new Error(`database disk image is malformed: ${(first || "quick_check failed").slice(0, 180)}`);
  }
}

/** Rows the Splunk CSV does not contain. Activity is rebuilt from snapshots, not copied. */
const PRESERVE_TABLES = [
  "participants",
  "cameras",
  "assignment_history",
  "reports",
  "score_adjustments",
  "challenge_awards",
  "leaderboard_track_overrides",
  "removed_participants",
  // One-time boot resets are keyed here. A rebuilt database must keep them, or the
  // checkout wipe runs again and deletes the assignments just copied off the damaged file.
  "sync_meta",
] as const;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Read roster and assignment rows while the damaged file can still answer a query. */
function readPreservedRows(dbPath: string): Record<string, Array<Record<string, unknown>>> {
  const saved: Record<string, Array<Record<string, unknown>>> = {};
  let opened: Database.Database | null = null;
  try {
    opened = new Database(dbPath, { readonly: true, fileMustExist: true });
    for (const table of PRESERVE_TABLES) {
      try {
        const exists = opened
          .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(table);
        if (!exists) continue;
        saved[table] = opened.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Array<
          Record<string, unknown>
        >;
      } catch {
        // This table lives on a damaged page. The aside file still holds it.
      }
    }
  } catch {
    // The file will not open. The renamed original is the only copy.
  } finally {
    opened?.close();
  }
  return saved;
}

export function assignmentCount(database: Database.Database = getDb()): number {
  return (database.prepare(`SELECT count(*) AS c FROM assignment_history`).get() as { c: number }).c;
}

export function activityCount(database: Database.Database = getDb()): number {
  return (database.prepare(`SELECT count(*) AS c FROM activity_events`).get() as { c: number }).c;
}

export function quarantineCount(database: Database.Database = getDb()): number {
  return (database.prepare(`SELECT count(*) AS c FROM quarantined_activity`).get() as { c: number }).c;
}

/** Copy assignments off a set-aside file when the live database lost them. */
export function restoreRosterFromAside(dbPath: string): number {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  if (!fs.existsSync(dir)) return 0;
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.malformed-`))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of candidates) {
    const saved = readPreservedRows(file);
    const found = saved.assignment_history?.length || 0;
    if (!found) continue;
    const written = writePreservedRows(getDb(), {
      participants: saved.participants || [],
      cameras: saved.cameras || [],
      assignment_history: saved.assignment_history || [],
    });
    console.log(`Restored ${written.assignment_history || 0} assignments from ${file}`);
    return written.assignment_history || 0;
  }
  return 0;
}

/** Roster shipped in the image. Used when the set-aside file cannot be read. */
export function restoreRosterFromFile(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    participants?: Array<Record<string, unknown>>;
    cameras?: Array<Record<string, unknown>>;
    assignment_history?: Array<Record<string, unknown>>;
    reports?: Array<Record<string, unknown>>;
  };
  if (!parsed.assignment_history?.length) return 0;
  const written = writePreservedRows(getDb(), {
    participants: parsed.participants || [],
    cameras: parsed.cameras || [],
    assignment_history: parsed.assignment_history,
    reports: parsed.reports || [],
  });
  console.log(`Restored ${written.assignment_history || 0} assignments from ${filePath}`);
  return written.assignment_history || 0;
}

function writePreservedRows(
  database: Database.Database,
  saved: Record<string, Array<Record<string, unknown>>>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const insertAll = database.transaction(() => {
    for (const table of PRESERVE_TABLES) {
      const rows = saved[table];
      if (!rows?.length) continue;
      const cols = Object.keys(rows[0]);
      const stmt = database.prepare(
        `INSERT OR REPLACE INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols
          .map(() => "?")
          .join(", ")})`,
      );
      for (const row of rows) stmt.run(cols.map((col) => row[col] ?? null));
      counts[table] = rows.length;
    }
  });
  insertAll();
  return counts;
}

/**
 * Move a malformed database off the live path without deleting it, and return the
 * roster rows a new file needs so Splunk events are not all quarantined.
 */
function setAsideMalformedDatabase(dbPath: string): {
  aside: string;
  saved: Record<string, Array<Record<string, unknown>>>;
} {
  const saved = readPreservedRows(dbPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = `${dbPath}.malformed-${stamp}`;
  fs.renameSync(dbPath, aside);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.renameSync(dbPath + suffix, aside + suffix);
  }
  console.log(`Set aside malformed database at ${aside}`);
  return { aside, saved };
}

function openAndPrepare(dbPath: string): Database.Database {
  const opened = openDatabase(dbPath);
  try {
    prepareDatabase(opened);
    assertReadable(opened);
    return opened;
  } catch (err) {
    opened.close();
    throw err;
  }
}

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(ENV.databasePath), { recursive: true });
  try {
    db = openAndPrepare(ENV.databasePath);
  } catch (err) {
    db = null;
    if (!isMalformedError(err) || !fs.existsSync(ENV.databasePath)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const summary = message.split("\n")[0].slice(0, 300);
    console.error(`Database is malformed, setting it aside before import: ${summary}`);
    const laid = setAsideMalformedDatabase(ENV.databasePath);
    db = openAndPrepare(ENV.databasePath);
    const preserved = writePreservedRows(db, laid.saved);
    console.log(
      `Kept ${preserved.assignment_history || 0} assignments and ${preserved.participants || 0} participants from the damaged database`,
    );
  }
  return db;
}

function prepareDatabase(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA);
  // Lightweight migrations for existing SQLite files
  // Overrides were briefly keyed by email alone; they are now per (person, camera). The table only
  // ever holds deliberate admin exceptions, so recreating it is cheaper than a column dance.
  const overrideCols = database.prepare(`PRAGMA table_info(leaderboard_track_overrides)`).all() as Array<{
    name: string;
  }>;
  if (overrideCols.length && !overrideCols.some((c) => c.name === "camera_id")) {
    database.exec(`
      DROP TABLE leaderboard_track_overrides;
      CREATE TABLE leaderboard_track_overrides (
        email TEXT NOT NULL,
        camera_id TEXT NOT NULL,
        track TEXT NOT NULL,
        reason TEXT,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (email, camera_id)
      );
    `);
  }
  // Superseded by per-(person, camera) overrides; drop it so stale serials cannot affect routing.
  database.exec(`DROP TABLE IF EXISTS permanent_cameras`);

  const reportCols = database.prepare(`PRAGMA table_info(reports)`).all() as Array<{ name: string }>;
  if (!reportCols.some((c) => c.name === "report_text")) {
    database.exec(`ALTER TABLE reports ADD COLUMN report_text TEXT`);
  }
  for (const col of ["created_at", "created_by", "decided_at_utc", "decided_by"]) {
    if (!reportCols.some((c) => c.name === col)) {
      database.exec(`ALTER TABLE reports ADD COLUMN ${col} TEXT`);
    }
  }
  const participantCols = database.prepare(`PRAGMA table_info(participants)`).all() as Array<{
    name: string;
  }>;
  if (!participantCols.some((c) => c.name === "photo_url")) {
    database.exec(`ALTER TABLE participants ADD COLUMN photo_url TEXT`);
  }
  if (!participantCols.some((c) => c.name === "password_hash")) {
    database.exec(`ALTER TABLE participants ADD COLUMN password_hash TEXT`);
  }
  if (!participantCols.some((c) => c.name === "registration_json")) {
    database.exec(`ALTER TABLE participants ADD COLUMN registration_json TEXT`);
  }
  // What triggered each recording (POV_ATTACH, _BUTTON, …). Needed to score
  // POV usage; rows imported before this column existed stay NULL and score no POV bonus.
  const activityCols = database.prepare(`PRAGMA table_info(activity_events)`).all() as Array<{
    name: string;
  }>;
  if (!activityCols.some((c) => c.name === "recording_source")) {
    database.exec(`ALTER TABLE activity_events ADD COLUMN recording_source TEXT`);
  }
  // Network path an upload took. Rows imported before this stay NULL and group as "unknown".
  if (!activityCols.some((c) => c.name === "upload_transport")) {
    database.exec(`ALTER TABLE activity_events ADD COLUMN upload_transport TEXT`);
  }
  // Median power draw (mW) reported per DVR state by PowerStateChanged. Only `power`
  // rows carry it; everything else stays NULL. Feeds the Runtime section on Stats.
  if (!activityCols.some((c) => c.name === "avg_power_mw")) {
    database.exec(`ALTER TABLE activity_events ADD COLUMN avg_power_mw REAL`);
  }
  // Camera config at the time of a power sample. Power draw depends on it, so a median across
  // mixed configs is meaningless — see PRD_SHIFT_RESOLUTION in the engine.
  if (!activityCols.some((c) => c.name === "recording_resolution")) {
    database.exec(`ALTER TABLE activity_events ADD COLUMN recording_resolution TEXT`);
  }
  // How many hours of history an export covers. The routine daily pull is 24h, but a backfill can
  // be far wider, and the import lookback has to stretch to match or every old row is rejected.
  const batchCols = database.prepare(`PRAGMA table_info(import_batches)`).all() as Array<{ name: string }>;
  if (!batchCols.some((c) => c.name === "export_window_hours")) {
    database.exec(`ALTER TABLE import_batches ADD COLUMN export_window_hours REAL`);
  }
  migrateWeeklyScoresPerCamera(database);
  migrateDefaultScoringProfileId(database);
  ensureDefaultScoringProfile(database);
  ensureRecordingEventCountRule(database);
  ensureShortRecordingRule(database);
  ensurePovRecordingRule(database);
  ensureMobileActionRule(database);
  ensureChallengeBonusRule(database);
  ensureManualAdjustmentRule(database);
  resetScoresIfCompetitionStartChanged(database);
}

function migrateDefaultScoringProfileId(database: Database.Database): void {
  const oldId = "pilot-default";
  const newId = "default";
  const oldRow = database
    .prepare(`SELECT profile_id FROM scoring_profiles WHERE profile_id = ?`)
    .get(oldId) as { profile_id: string } | undefined;
  const newRow = database
    .prepare(`SELECT profile_id FROM scoring_profiles WHERE profile_id = ?`)
    .get(newId) as { profile_id: string } | undefined;
  if (!oldRow || newRow) return;
  database.prepare(`UPDATE scoring_rules SET profile_id = ? WHERE profile_id = ?`).run(newId, oldId);
  database
    .prepare(`UPDATE scoring_profiles SET profile_id = ?, name = 'Default' WHERE profile_id = ?`)
    .run(newId, oldId);
  database
    .prepare(`UPDATE weekly_scores SET scoring_profile_id = ? WHERE scoring_profile_id = ?`)
    .run(newId, oldId);
  database
    .prepare(`UPDATE weekly_snapshots SET scoring_profile_id = ? WHERE scoring_profile_id = ?`)
    .run(newId, oldId);
}

function resetScoresIfCompetitionStartChanged(database: Database.Database): void {
  const current = ENV.competitionStartDate;
  const row = database.prepare(`SELECT value FROM sync_meta WHERE key = 'competition_start'`).get() as
    | { value: string }
    | undefined;
  if (row?.value === current) return;
  database.prepare(`DELETE FROM weekly_scores`).run();
  database.prepare(`DELETE FROM daily_activity`).run();
  database.prepare(`DELETE FROM weekly_snapshots`).run();
  database.prepare(`DELETE FROM score_adjustments`).run();
  database
    .prepare(
      `INSERT INTO sync_meta(key, value) VALUES('competition_start', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(current);
}

function ensureChallengeBonusRule(database: Database.Database): void {
  const profiles = database
    .prepare(`SELECT profile_id, version FROM scoring_profiles`)
    .all() as Array<{ profile_id: string; version: number }>;
  const insert = database.prepare(
    `INSERT OR IGNORE INTO scoring_rules (
      profile_id, profile_version, metric_key, label, aggregation,
      points_per_unit, minimum, cap, enabled, display_order, params_json
    ) VALUES (?, ?, 'challenge_bonus', 'Challenge bonus', 'sum_challenge_bonus', 1, NULL, NULL, 1, 8, '{}')`,
  );
  for (const p of profiles) {
    insert.run(p.profile_id, p.version);
  }
}

function ensureManualAdjustmentRule(database: Database.Database): void {
  const profiles = database
    .prepare(`SELECT profile_id, version FROM scoring_profiles`)
    .all() as Array<{ profile_id: string; version: number }>;
  const insert = database.prepare(
    `INSERT OR IGNORE INTO scoring_rules (
      profile_id, profile_version, metric_key, label, aggregation,
      points_per_unit, minimum, cap, enabled, display_order, params_json
    ) VALUES (?, ?, 'manual_adjustment', 'Admin adjustment', 'sum_manual_adjustment', 1, NULL, NULL, 1, 9, '{}')`,
  );
  for (const p of profiles) {
    insert.run(p.profile_id, p.version);
  }
}

/** Allow one leaderboard row per person+camera in a week. */
function migrateWeeklyScoresPerCamera(database: Database.Database): void {
  const row = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'weekly_scores'`)
    .get() as { sql?: string } | undefined;
  const sql = row?.sql || "";
  if (sql.includes("PRIMARY KEY (email, week_start, camera_id)")) return;

  database.exec(`
    CREATE TABLE weekly_scores_v2 (
      email TEXT NOT NULL,
      week_start TEXT NOT NULL,
      scoring_profile_id TEXT NOT NULL,
      scoring_profile_version INTEGER NOT NULL,
      total_points REAL NOT NULL,
      rank INTEGER,
      camera_id TEXT NOT NULL DEFAULT '',
      metrics_json TEXT NOT NULL,
      recomputed_at TEXT NOT NULL,
      PRIMARY KEY (email, week_start, camera_id)
    );
    INSERT INTO weekly_scores_v2 (
      email, week_start, scoring_profile_id, scoring_profile_version,
      total_points, rank, camera_id, metrics_json, recomputed_at
    )
    SELECT
      email, week_start, scoring_profile_id, scoring_profile_version,
      total_points, rank, COALESCE(camera_id, ''), metrics_json, recomputed_at
    FROM weekly_scores;
    DROP TABLE weekly_scores;
    ALTER TABLE weekly_scores_v2 RENAME TO weekly_scores;
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Rename the live database off its path. The bytes stay on disk. The next getDb() starts a new file. */
export function setAsideLiveDatabase(dbPath: string): string {
  if (db) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // A damaged file may refuse a checkpoint. Renaming it still keeps the bytes.
    }
    db.close();
    db = null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = `${dbPath}.aside-${stamp}`;
  if (fs.existsSync(dbPath)) fs.renameSync(dbPath, aside);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.renameSync(dbPath + suffix, aside + suffix);
  }
  console.log(`Set aside database at ${aside}`);
  return aside;
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function audit(
  actor: string,
  action: string,
  opts: {
    entityType?: string;
    entityId?: string;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string;
  } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, old_value, new_value, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      actor,
      action,
      opts.entityType ?? null,
      opts.entityId ?? null,
      opts.oldValue != null ? JSON.stringify(opts.oldValue) : null,
      opts.newValue != null ? JSON.stringify(opts.newValue) : null,
      opts.reason ?? null,
      nowISO(),
    );
}
