/**
 * Bake the current local leaderboard into a static static site zip.
 * No API calls ship in the page. Requires the local API on :8787.
 *
 *   node scripts/buildStaticLeaderboard.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedPath = path.join(webRoot, "src/data/leaderboardSnapshot.generated.ts");
const api = (process.env.LEADERBOARD_API || "http://127.0.0.1:8787").replace(/\/$/, "");
const original = fs.readFileSync(generatedPath, "utf8");

function boardKey(track, weekStart) {
  return weekStart ? `${track}|${weekStart}` : track;
}

async function getJson(path) {
  const res = await fetch(`${api}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return res.json();
}

async function getBoard(track, weekStart) {
  const params = new URLSearchParams({ track });
  if (weekStart) params.set("weekStart", weekStart);
  return getJson(`/api/leaderboard?${params}`);
}

function run(command, args, env, cwd = webRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

try {
  const health = await fetch(`${api}/health`);
  if (!health.ok) throw new Error(`API health check failed (${health.status})`);

  const boards = {};
  for (const track of ["overall", "permanent", "checkout"]) {
    const board = await getBoard(track);
    boards[boardKey(track)] = board;
    if (track === "overall") continue;
    for (const week of board.availableWeeks || []) {
      boards[boardKey(track, week)] = await getBoard(track, week);
    }
  }

  const [roster, devices, season, weeklyBody] = await Promise.all([
    getJson("/api/roster/summary"),
    getJson("/api/devices"),
    getJson("/api/season"),
    getJson("/api/stats/weekly"),
  ]);
  const stats = {};
  for (const key of ["24h", "7d", "14d", "all"]) {
    stats[key] = await getJson(`/api/stats?window=${key}`);
  }

  const capturedAt = new Date().toISOString();
  const snapshot = {
    capturedAt,
    boards,
    roster,
    devices,
    season,
    stats,
    weekly: weeklyBody.weeks ?? [],
  };
  const source =
    `import type { LocalDevicesResponse, LocalLeaderboardResponse, LocalOverallStats, LocalRosterSummary, LocalSeasonStatus, LocalWeeklyStatsRow } from "./localApi";\n\n` +
    `export const LEADERBOARD_SNAPSHOT = ${JSON.stringify(snapshot)} as {\n` +
    `  capturedAt: string;\n` +
    `  boards: Record<string, LocalLeaderboardResponse>;\n` +
    `  roster: LocalRosterSummary;\n` +
    `  devices: LocalDevicesResponse;\n` +
    `  season: LocalSeasonStatus;\n` +
    `  stats: Record<string, LocalOverallStats>;\n` +
    `  weekly: LocalWeeklyStatsRow[];\n` +
    `};\n`;
  fs.writeFileSync(generatedPath, source);
  console.log(
    `Snapshot ${capturedAt}: ${Object.keys(boards).length} views, ` +
      `${boards.overall?.entries?.length ?? 0} overall rows`,
  );

  const env = {
    ...process.env,
    VITE_STATIC_LEADERBOARD: "true",
    VITE_APPS_SCRIPT_URL: "",
    VITE_LOCAL_API_URL: "",
    VITE_HARBOR_PERMANENT_ONLY: "",
  };
  await run(process.execPath, ["node_modules/typescript/bin/tsc", "-b", "--pretty", "false"], env);
  await run(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--mode", "static-leaderboard"],
    env,
  );

  fs.copyFileSync(
    path.join(webRoot, "public/favicon-fieldcam.svg"),
    path.join(webRoot, "dist/favicon.svg"),
  );
  fs.rmSync(path.join(webRoot, "dist/favicon-fieldcam.svg"), { force: true });

  const indexPath = path.join(webRoot, "dist/index.html");
  const html = fs.readFileSync(indexPath, "utf8");
  if (!html.includes('name="robots"')) {
    fs.writeFileSync(
      indexPath,
      html.replace("<head>", '<head>\n    <meta name="robots" content="noindex, nofollow" />'),
    );
  }

  const zipPath = path.join(webRoot, "static-leaderboard.zip");
  fs.rmSync(zipPath, { force: true });
  await run("zip", ["-r", "-X", zipPath, "."], env, path.join(webRoot, "dist"));
  console.log(`Wrote ${zipPath}`);
} finally {
  fs.writeFileSync(generatedPath, original);
}
