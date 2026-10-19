/**
 * Boot must set a malformed SQLite file aside and open a new one.
 *
 * Harbor's sqlite3 .recover exits with "SQL logic error", so the snapshot import never
 * ran. The damaged file is renamed, not deleted. Roster rows that can still be read
 * are copied so new Splunk events are not quarantined.
 *
 * Refuses to touch server/data/fieldcam.sqlite. Point DATABASE_PATH at a throwaway file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ENV } from "../../env.js";
import { closeDb, getDb } from "../../db.js";

const HERE = fileURLToPath(import.meta.url);
const REAL_DB = path.resolve(path.dirname(HERE), "../../../data/fieldcam.sqlite");

let pass = 0;
let fail = 0;
const ok_ = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  <- ${detail}`}`);
  cond ? pass++ : fail++;
};

function assertThrowaway(dbPath: string): void {
  const resolved = path.resolve(dbPath);
  if (resolved === REAL_DB || resolved.endsWith(`${path.sep}server${path.sep}data${path.sep}fieldcam.sqlite`)) {
    console.error(`refusing to run recovery test against the real database: ${resolved}`);
    process.exit(2);
  }
}

function checkpointAndClose(): void {
  const db = getDb();
  db.pragma("wal_checkpoint(TRUNCATE)");
  closeDb();
}

function dropWal(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.rmSync(dbPath + suffix);
  }
}

/** Damage one used page that does not hold the marker row. */
function corruptOtherPage(dbPath: string, markerEmail: string): void {
  const Database = (awaitImport()) as typeof import("better-sqlite3");
  const probe = new Database(dbPath, { readonly: true });
  const markerPages = new Set(
    (probe.prepare(`SELECT pageno AS n FROM dbstat WHERE name = 'participants'`).all() as Array<{ n: number }>).map(
      (r) => r.n,
    ),
  );
  const used = probe.prepare(`SELECT DISTINCT pageno AS n FROM dbstat WHERE pageno > 1 ORDER BY pageno`).all() as Array<{
    n: number;
  }>;
  probe.close();
  const target = used.find((r) => !markerPages.has(r.n));
  if (!target) throw new Error(`no page to corrupt without losing ${markerEmail}`);
  const pageSize = 4096;
  const buf = fs.readFileSync(dbPath);
  const start = target.n * pageSize;
  buf.fill(0xa5, start, start + pageSize);
  fs.writeFileSync(dbPath, buf);
}

function awaitImport(): typeof import("better-sqlite3") {
  // better-sqlite3 is CJS; the default import is the constructor.
  return (globalThis as { __better?: typeof import("better-sqlite3") }).__better!;
}

async function main(): Promise<void> {
  const mode = process.argv[2] || "all";
  if (mode === "later-read" || mode === "all") {
    if (mode === "all") {
      spawnCase("later-read");
      spawnCase("open-fails");
      return;
    }
    await laterRead();
  } else if (mode === "open-fails") {
    await openFails();
  } else {
    console.error(`unknown mode ${mode}`);
    process.exit(2);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function spawnCase(mode: string): void {
  const dir = fs.mkdtempSync(path.join("/tmp", "fieldcam-recover-"));
  const dbPath = path.join(dir, "fieldcam.sqlite");
  const tsx = path.resolve(path.dirname(HERE), "../../../node_modules/.bin/tsx");
  const result = spawnSync(tsx, [HERE, mode], {
    env: { ...process.env, DATABASE_PATH: dbPath, FLEET_ENABLED: "false", FLEET_MODE: "off" },
    encoding: "utf8",
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) {
    console.log(`  FAIL  ${mode} exited ${result.status}`);
    process.exitCode = 1;
  }
}

async function laterRead(): Promise<void> {
  const Database = (await import("better-sqlite3")).default;
  (globalThis as { __better?: typeof import("better-sqlite3") }).__better = Database as unknown as typeof import("better-sqlite3");
  const dbPath = ENV.databasePath;
  assertThrowaway(dbPath);
  console.log("\n=== file opens, then a later read is malformed ===");
  const db = getDb();
  const email = "recover-later@northline.example";
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO participants (email, name, enrolled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(email, "Recover Later", now, now, now);
  // Push the marker off the first data pages so the damaged page is not the row we check afterwards.
  db.exec(`CREATE TABLE IF NOT EXISTS recover_pad (id INTEGER PRIMARY KEY, blob BLOB)`);
  const insert = db.prepare(`INSERT INTO recover_pad (blob) VALUES (?)`);
  const chunk = Buffer.alloc(8000, 1);
  for (let i = 0; i < 30; i++) insert.run(chunk);
  checkpointAndClose();
  corruptOtherPage(dbPath, email);
  dropWal(dbPath);
  const logs: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
    origErr(...args);
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
    origLog(...args);
  };
  const again = getDb();
  console.error = origErr;
  console.log = origLog;
  const text = logs.join("\n");
  ok_("malformed file was set aside before import", text.includes("setting it aside before import"), text);
  ok_("broken original was kept", fs.readdirSync(path.dirname(dbPath)).some((n) => n.includes(".malformed-")));
  const row = again.prepare(`SELECT email FROM participants WHERE email = ?`).get(email) as { email: string } | undefined;
  ok_("marker row survived", row?.email === email, JSON.stringify(row));
  const check = again.prepare(`PRAGMA quick_check`).get() as { quick_check: string };
  ok_("rebuilt file passes quick_check", check.quick_check === "ok", check.quick_check);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

async function openFails(): Promise<void> {
  const dbPath = ENV.databasePath;
  assertThrowaway(dbPath);
  console.log("\n=== file is malformed as soon as it opens ===");
  getDb();
  checkpointAndClose();
  const buf = fs.readFileSync(dbPath);
  buf.fill(0xa5, 100, 4096);
  fs.writeFileSync(dbPath, buf);
  dropWal(dbPath);
  const logs: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
    origErr(...args);
  };
  const again = getDb();
  console.error = origErr;
  ok_("malformed file was set aside", logs.join("\n").includes("setting it aside before import"), logs.join("\n"));
  const tables = again.prepare(`SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'`).get() as { c: number };
  ok_("schema is readable after recovery", tables.c > 5, String(tables.c));
  const check = again.prepare(`PRAGMA quick_check`).get() as { quick_check: string };
  ok_("rebuilt file passes quick_check", check.quick_check === "ok", check.quick_check);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
