/**
 * End-to-end smoke against a running server (or starts inline import if SERVER_URL unset).
 *
 *   npm run smoke
 *   SERVER_URL=http://localhost:8787 npm run smoke
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../../fixtures");
const base = (process.env.SERVER_URL || "").replace(/\/$/, "");

async function viaHttp() {
  // Ensure fixtures exist for current week
  await import("./generateFixtures.js");

  const loginRes = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@northline.example", password: process.env.ADMIN_PASSWORD || "Password" }),
  });
  const login = (await loginRes.json()) as { token?: string; error?: string };
  if (!login.token) throw new Error(`Login failed: ${login.error || loginRes.status}`);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${login.token}`,
  };

  const beginRes = await fetch(`${base}/api/admin/import/begin`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      exportTimeUtc: new Date().toISOString(),
      exportTimezone: "America/Phoenix",
    }),
  });
  const begin = (await beginRes.json()) as { batchId: string };
  const splunkCsv = fs.readFileSync(path.join(fixturesDir, "activity_events.csv"), "utf8");
  const fleetCsv = fs.readFileSync(path.join(fixturesDir, "assignments.csv"), "utf8");

  await fetch(`${base}/api/admin/import/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({ batchId: begin.batchId, splunkCsv, fleetCsv }),
  });
  const previewRes = await fetch(`${base}/api/admin/import/preview`, {
    method: "POST",
    headers,
    body: JSON.stringify({ batchId: begin.batchId }),
  });
  const preview = await previewRes.json();
  const commitRes = await fetch(`${base}/api/admin/import/commit`, {
    method: "POST",
    headers,
    body: JSON.stringify({ batchId: begin.batchId }),
  });
  const commit = await commitRes.json();
  const boardRes = await fetch(`${base}/api/leaderboard`);
  const board = (await boardRes.json()) as {
    entries: Array<{ rank: number; name: string; totalPoints: number; cameraId: string | null }>;
    freshness: unknown;
  };

  const evidenceStatusRes = await fetch(`${base}/api/admin/fleet/status`, { headers });
  const evidenceStatus = await evidenceStatusRes.json();
  const evidenceSyncRes = await fetch(`${base}/api/admin/fleet/sync`, {
    method: "POST",
    headers,
    body: "{}",
  });
  const evidenceSync = await evidenceSyncRes.json();

  // Splunk-only import path (no Fleet CSV) after Fleet assignments exist
  const begin2Res = await fetch(`${base}/api/admin/import/begin`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      exportTimeUtc: new Date().toISOString(),
      exportTimezone: "America/Phoenix",
    }),
  });
  const begin2 = (await begin2Res.json()) as { batchId: string };
  await fetch(`${base}/api/admin/import/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({ batchId: begin2.batchId, splunkCsv, fleetCsv: "" }),
  });
  const preview2Res = await fetch(`${base}/api/admin/import/preview`, {
    method: "POST",
    headers,
    body: JSON.stringify({ batchId: begin2.batchId }),
  });
  const preview2 = await preview2Res.json();

  console.log(
    JSON.stringify(
      {
        mode: "http",
        preview,
        commitScores: (commit as { scores?: unknown }).scores,
        top: board.entries.slice(0, 5),
        freshness: board.freshness,
        evidenceStatus,
        evidenceSync,
        splunkOnlyPreview: preview2,
      },
      null,
      2,
    ),
  );

  if (!board.entries.length) throw new Error("Leaderboard empty after import");
  if (board.entries[0].totalPoints <= 0) throw new Error("Top score was not positive");

  const qRes = await fetch(`${base}/api/admin/quarantine`, { headers });
  const quarantine = (await qRes.json()) as { items?: unknown[] };
  const draftRes = await fetch(`${base}/api/admin/scoring/draft`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "smoke-draft" }),
  });
  const draft = (await draftRes.json()) as { profileId: string; version: number };
  const previewScoreRes = await fetch(`${base}/api/admin/scoring/preview`, {
    method: "POST",
    headers,
    body: JSON.stringify({ profileId: draft.profileId, version: draft.version }),
  });
  const previewScore = await previewScoreRes.json();
  const intakeRes = await fetch(`${base}/api/admin/reports/intake`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      dryRun: true,
      reports: [
        {
          email: "alice@northline.example",
          slackMessageUrl: "https://example.slack.com/archives/C000/p000",
          reportedAtUtc: new Date().toISOString(),
        },
      ],
    }),
  });
  const intake = await intakeRes.json();
  const pendingRes = await fetch(`${base}/api/admin/reminders/pending`, { headers });
  const pending = await pendingRes.json();

  console.log(
    JSON.stringify(
      {
        quarantineCount: quarantine.items?.length ?? 0,
        scoringPreviewOk: Boolean((previewScore as { ok?: boolean }).ok !== false),
        reportsDryRun: intake,
        pendingNudges: pending,
      },
      null,
      2,
    ),
  );
  console.log("SMOKE OK");
}

async function viaInline() {
  await import("./importFixtures.js");
  const { syncFleetOwnership, applyManualOwnership } = await import("../fleet/sync.js");
  const { inferMapping, applyMapping, normalizeTimestamp } = await import("../import/mapping.js");
  const manual = applyManualOwnership("smoke", "FC-7727X", "alice.chen@northline.example");
  const sync = await syncFleetOwnership("smoke");
  const headers = [
    "Event Time",
    "Camera ID",
    "Event Type",
    "Stable Event ID",
    "Duration (seconds)",
    "Purpose",
    "Status",
  ];
  const mapping = inferMapping(headers, "splunk");
  const mapped = applyMapping(
    {
      "Event Time": "1786401108",
      "Camera ID": "FC-7727X",
      "Event Type": "recording",
      "Stable Event ID": "abc",
      "Duration (seconds)": "239",
      Purpose: "PURPOSE_STANDARD",
      Status: "success",
    },
    mapping,
  );
  if (!mapped.event_time_utc.startsWith("2026-")) {
    throw new Error(`Expected unix Event Time normalization, got ${mapped.event_time_utc}`);
  }
  if (normalizeTimestamp("1786401108") !== mapped.event_time_utc) {
    throw new Error("normalizeTimestamp mismatch");
  }
  console.log(
    JSON.stringify(
      { manual, sync, splunkMappingFields: mapping.map((m) => m.canonicalField), mapped },
      null,
      2,
    ),
  );
  console.log("SMOKE OK (inline import + evidence mock)");
}

if (base) {
  await viaHttp();
} else {
  await viaInline();
}
