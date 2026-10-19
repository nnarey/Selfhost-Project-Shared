/**
 * Harbor restarts a container when /health takes longer than 5 seconds.
 * The snapshot import runs in a child process. This boots the real server
 * against a throwaway database: a damaged file with real camera assignments,
 * health during that import, scores afterwards, a second boot, and SIGTERM.
 *
 * Refuses to write server/data/fieldcam.sqlite. It only reads that file for roster rows.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { ENV } from "../../env.js";
import { closeDb, getDb } from "../../db.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, "../../..");
const REPO_ROOT = path.resolve(SERVER_ROOT, "..");
const LIVE_DB = path.join(SERVER_ROOT, "data", "fieldcam.sqlite");
const NODE = process.env.BOOT_TEST_NODE || process.execPath;
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

let pass = 0;
let fail = 0;
const ok_ = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  <- ${detail}`}`);
  cond ? pass++ : fail++;
};

function assertThrowaway(dbPath: string): void {
  const resolved = path.resolve(dbPath);
  if (resolved === path.resolve(LIVE_DB)) {
    console.error(`refusing to write the live database: ${resolved}`);
    process.exit(2);
  }
}

function copyRoster(into: Database.Database): { assignments: number; participants: number } {
  const live = new Database(LIVE_DB, { readonly: true, fileMustExist: true });
  const counts = { assignments: 0, participants: 0 };
  const copy = into.transaction(() => {
    for (const table of ["participants", "cameras", "assignment_history"] as const) {
      const rows = live.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const stmt = into.prepare(
        `INSERT OR REPLACE INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      );
      for (const row of rows) stmt.run(cols.map((c) => row[c] ?? null));
      if (table === "assignment_history") counts.assignments = rows.length;
      if (table === "participants") counts.participants = rows.length;
    }
  });
  copy();
  live.close();
  return counts;
}

/** Damage a padding page so quick_check fails and the roster tables are still readable. */
function corruptPadPage(dbPath: string): void {
  const probe = new Database(dbPath, { readonly: true });
  const keep = new Set(
    (
      probe
        .prepare(
          `SELECT pageno AS n FROM dbstat WHERE name IN ('participants', 'cameras', 'assignment_history', 'sqlite_schema')`,
        )
        .all() as Array<{ n: number }>
    ).map((r) => r.n),
  );
  const pad = probe.prepare(`SELECT DISTINCT pageno AS n FROM dbstat WHERE name = 'boot_pad'`).all() as Array<{
    n: number;
  }>;
  probe.close();
  const target = pad.find((r) => !keep.has(r.n));
  if (!target) throw new Error("no padding page to corrupt");
  const buf = fs.readFileSync(dbPath);
  const start = target.n * 4096;
  buf.fill(0xa5, start, start + 4096);
  fs.writeFileSync(dbPath, buf);
}

function prepareDamagedDatabase(dbPath: string): void {
  assertThrowaway(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.rmSync(dbPath + suffix);
  }
  const db = getDb();
  const copied = copyRoster(db);
  if (copied.assignments < 1) throw new Error("live database has no assignments to copy");
  db.exec(`CREATE TABLE IF NOT EXISTS boot_pad (id INTEGER PRIMARY KEY, blob BLOB)`);
  const insert = db.prepare(`INSERT INTO boot_pad (blob) VALUES (?)`);
  const chunk = Buffer.alloc(8000, 7);
  for (let i = 0; i < 40; i++) insert.run(chunk);
  db.pragma("wal_checkpoint(TRUNCATE)");
  closeDb();
  corruptPadPage(dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.rmSync(dbPath + suffix);
  }
  console.log(`prepared damaged database with ${copied.assignments} assignments`);
}

function startServer(port: number, dbPath: string, logPath: string): ChildProcess {
  const log = fs.openSync(logPath, "w");
  const child = spawn(NODE, [TSX, path.join(SERVER_ROOT, "src", "index.ts")], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      SPLUNK_SNAPSHOT_PATH: path.join(REPO_ROOT, "data", "splunk-activity.csv"),
      FLEET_ENABLED: "false",
      FLEET_MODE: "off",
      HARBOR_TRUST_IDENTITY: "true",
      WEB_DIST: path.join(REPO_ROOT, "web", "dist"),
      COMPETITION_START: "2026-08-31",
    },
    stdio: ["ignore", log, log],
    detached: true,
  });
  child.unref();
  return child;
}

async function stopServer(child: ChildProcess): Promise<number> {
  const started = Date.now();
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(-1), 5000);
    child.once("exit", (status) => {
      clearTimeout(timer);
      resolve(status ?? 0);
    });
  });
  return Date.now() - started < 0 ? code : code;
}

async function timed(url: string): Promise<{ status: number; ms: number; body: string }> {
  const t = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const body = await res.text();
  return { status: res.status, ms: performance.now() - t, body };
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 15000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const hit = await timed(`http://127.0.0.1:${port}/health`);
      if (hit.status === 200 && hit.body.includes('"ok"')) return;
      last = `${hit.status} ${hit.body}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`health never came up: ${last}`);
}

async function sampleWhileStarting(port: number): Promise<{ maxMs: number; samples: number; saw503: boolean }> {
  let maxMs = 0;
  let samples = 0;
  let saw503 = false;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const health = await timed(`http://127.0.0.1:${port}/health`);
    samples++;
    maxMs = Math.max(maxMs, health.ms);
    if (health.status !== 200) throw new Error(`health ${health.status} during boot`);
    const api = await timed(`http://127.0.0.1:${port}/api/leaderboard?track=permanent`);
    if (api.status === 200) return { maxMs, samples, saw503 };
    if (api.status === 503) saw503 = true;
    else throw new Error(`leaderboard ${api.status} during boot: ${api.body.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("leaderboard stayed on starting");
}

async function topScore(port: number): Promise<{ name: string; totalPoints: number; count: number }> {
  const hit = await timed(`http://127.0.0.1:${port}/api/leaderboard?track=permanent`);
  if (hit.status !== 200) throw new Error(`leaderboard ${hit.status}: ${hit.body.slice(0, 200)}`);
  const body = JSON.parse(hit.body) as {
    entries: Array<{ name: string; totalPoints: number }>;
  };
  const top = body.entries.find((e) => e.totalPoints > 0);
  if (!top) throw new Error("no scored permanent row");
  return { name: top.name, totalPoints: top.totalPoints, count: body.entries.length };
}

async function bootCase(
  label: string,
  port: number,
  dbPath: string,
  logPath: string,
  expectStarting: boolean,
): Promise<string> {
  console.log(`\n=== ${label} ===`);
  const child = startServer(port, dbPath, logPath);
  try {
    await waitForHealth(port);
    const during = await sampleWhileStarting(port);
    ok_(`${label}: health answered during import`, during.samples >= 1, `samples=${during.samples}`);
    if (expectStarting) ok_(`${label}: saw starting on the leaderboard`, during.saw503);
    ok_(
      `${label}: health stayed under 2s (Harbor allows 5s)`,
      during.maxMs < 2000,
      `${Math.round(during.maxMs)}ms`,
    );
    for (let i = 0; i < 8; i++) {
      const health = await timed(`http://127.0.0.1:${port}/health`);
      if (health.ms > during.maxMs) during.maxMs = health.ms;
      if (health.status !== 200) throw new Error(`health ${health.status} after ready`);
    }
    ok_(
      `${label}: health stayed under 2s after the board was ready`,
      during.maxMs < 2000,
      `${Math.round(during.maxMs)}ms`,
    );
    const top = await topScore(port);
    ok_(`${label}: permanent board has points`, top.totalPoints > 1000, `${top.name} ${top.totalPoints}`);
    console.log(`  top ${top.name} ${top.totalPoints} (${top.count} rows)`);
    const stopMs = await (async () => {
      const t = Date.now();
      const code = await stopServer(child);
      return { code, ms: Date.now() - t };
    })();
    ok_(`${label}: SIGTERM stopped the server within 4s`, stopMs.ms < 4000 && stopMs.code !== -1, `${stopMs.ms}ms code=${stopMs.code}`);
  } catch (err) {
    ok_(`${label}: boot completed`, false, err instanceof Error ? err.message : String(err));
    await stopServer(child);
  }
  return fs.readFileSync(logPath, "utf8");
}

async function main(): Promise<void> {
  const dbPath = ENV.databasePath;
  assertThrowaway(dbPath);
  const dir = path.dirname(dbPath);
  const corruptCopy = path.join(dir, "corrupt-copy.sqlite");
  prepareDamagedDatabase(dbPath);
  fs.copyFileSync(dbPath, corruptCopy);

  const firstLog = await bootCase("damaged boot", 8798, dbPath, path.join(dir, "boot1.log"), true);
  ok_("set the damaged file aside", firstLog.includes("Set aside malformed database"), firstLog.slice(0, 500));
  const kept = /Kept (\d+) assignments/.exec(firstLog);
  ok_("copied assignments out of the damaged file", !!kept && Number(kept[1]) > 0, kept?.[0] ?? "missing");
  const replayed = /Replayed \d+ missed snapshot\(s\)[^\n]*accepted=(\d+)/.exec(firstLog);
  const rolling = /Splunk snapshot imported[^\n]*accepted=(\d+)/.exec(firstLog);
  const acceptedCount = Math.max(Number(replayed?.[1] ?? 0), Number(rolling?.[1] ?? 0));
  ok_(
    "imported activity rows",
    acceptedCount > 1000,
    replayed?.[0] ?? rolling?.[0] ?? "missing",
  );
  ok_(
    "kept the damaged file",
    fs.readdirSync(dir).some((n) => n.includes(".malformed-")),
  );
  const checkDb = new Database(dbPath, { readonly: true });
  const check = checkDb.prepare(`PRAGMA quick_check`).get() as { quick_check: string };
  checkDb.close();
  ok_("rebuilt database passes quick_check", check.quick_check === "ok", check.quick_check);

  const secondLog = await bootCase("second boot", 8798, dbPath, path.join(dir, "boot2.log"), false);
  ok_("second boot did not set the database aside again", !secondLog.includes("setting it aside"));

  console.log("\n=== stop during import ===");
  const interruptDb = path.join(dir, "interrupt.sqlite");
  fs.copyFileSync(corruptCopy, interruptDb);
  const interruptLog = path.join(dir, "interrupt.log");
  const child = startServer(8797, interruptDb, interruptLog);
  try {
    await waitForHealth(8797);
    const early = await timed("http://127.0.0.1:8797/api/leaderboard?track=permanent");
    ok_("interrupt: leaderboard is starting while import runs", early.status === 503, String(early.status));
    const t = Date.now();
    const code = await stopServer(child);
    const ms = Date.now() - t;
    ok_("interrupt: SIGTERM during import exits within 4s", ms < 4000 && code !== -1, `${ms}ms code=${code}`);
    await new Promise((r) => setTimeout(r, 300));
    const left = fs.readFileSync(interruptLog, "utf8");
    ok_("interrupt: health had started", left.includes("FieldCam listening"));
  } catch (err) {
    ok_("interrupt: completed", false, err instanceof Error ? err.message : String(err));
    await stopServer(child);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
