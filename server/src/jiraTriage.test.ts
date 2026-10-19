// ABOUTME: Credits a roster reporter only when a Jira bug moves from NEEDS TRIAGE to Triaged.
// ABOUTME: A Won't Fix that never passed through Triaged does not score, and a later Won't Fix keeps the points.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "fieldcam-jira-triage-"));
process.env.DATABASE_PATH = path.join(dir, "test.sqlite");
process.env.FLEET_ENABLED = "false";
process.env.FLEET_MODE = "off";

const { getDb } = await import("./db.js");
const { createReport } = await import("./reports.js");
const { applyJiraTriageSnapshot, buildJiraTriageSnapshot, syncJiraTriage } = await import("./jira/triage.js");
const { assertPublishable, importJiraTriageFile } = await import("./jira/snapshot.js");
const { jiraRestRoot } = await import("./jira/poller.js");
const { weekStartUtcISO } = await import("./week.js");

const SITE = "issues.northline.example";
const ACTOR = "jira-poller";
const TRIAGE_AT = "2026-09-10T17:00:00.000Z";

function seed(email: string) {
  const now = "2026-09-01T12:00:00.000Z";
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO participants (
        email, name, hub, signup_status, enrolled_at, status, created_at, updated_at
      ) VALUES (?, 'Tester', 'Phoenix', 'approved', ?, 'Active', ?, ?)`,
    )
    .run(email, now, now, now);
}

function browse(key: string): string {
  return `https://${SITE}/browse/${key}`;
}

function row(key: string) {
  return getDb()
    .prepare(
      `SELECT status, reported_at_utc, week_start FROM reports WHERE slack_message_url = ?`,
    )
    .get(browse(key)) as
    | { status: string; reported_at_utc: string; week_start: string }
    | undefined;
}

function count(key: string): number {
  const hit = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM reports WHERE slack_message_url = ?`)
    .get(browse(key)) as { n: number };
  return hit.n;
}

test("a triaged roster bug scores once at the transition, and a second sync does not add another", async () => {
  seed("reporter@northline.example");
  const search = async () => ({
    issues: [
      { key: "FC-100", summary: "OTA hang", reporterEmail: "reporter@northline.example" },
      { key: "FC-QE", summary: "QE only", reporterEmail: "qe@northline.example" },
    ],
  });
  const changelog = async (key: string) => {
    if (key === "FC-QE" || key === "FC-100") {
      return [
        { at: "2026-09-12T15:00:00.000Z", from: "Triaged", to: "Won't Fix" },
        { at: TRIAGE_AT, from: "NEEDS TRIAGE", to: "Triaged" },
      ];
    }
    return [];
  };

  await syncJiraTriage({ actor: ACTOR, site: SITE, search, changelog });
  const first = row("FC-100");
  assert.equal(first?.status, "approved");
  assert.equal(Date.parse(first?.reported_at_utc ?? ""), Date.parse(TRIAGE_AT));
  assert.equal(first?.week_start, weekStartUtcISO(TRIAGE_AT));
  assert.equal(count("FC-100"), 1);
  assert.equal(count("FC-QE"), 0);

  await syncJiraTriage({ actor: ACTOR, site: SITE, search, changelog });
  assert.equal(count("FC-100"), 1);
  assert.equal(row("FC-100")?.status, "approved");
});

test("a bug filed early moves to the triage week, and Won't Fix or still-untriaged rows stop scoring", async () => {
  seed("early@northline.example");
  createReport("admin", {
    email: "early@northline.example",
    text: "filed at create",
    slackMessageUrl: browse("FC-EARLY"),
    reportedAtUtc: "2026-09-01T15:00:00.000Z",
  });
  createReport("admin", {
    email: "early@northline.example",
    text: "wont fix",
    slackMessageUrl: browse("FC-WONT"),
    reportedAtUtc: "2026-09-01T15:00:00.000Z",
  });
  createReport("admin", {
    email: "early@northline.example",
    text: "needs triage",
    slackMessageUrl: browse("FC-NEED"),
    reportedAtUtc: "2026-09-01T15:00:00.000Z",
  });
  createReport("admin", {
    email: "early@northline.example",
    text: "slack finding",
    slackMessageUrl: "https://northline.slack.com/archives/C000FIELD00/p999",
    reportedAtUtc: "2026-09-01T15:00:00.000Z",
  });

  await syncJiraTriage({
    actor: ACTOR,
    site: SITE,
    search: async () => ({
      issues: [{ key: "FC-EARLY", summary: "real bug", reporterEmail: "early@northline.example" }],
    }),
    changelog: async () => [{ at: TRIAGE_AT, from: "NEEDS TRIAGE", to: "Triaged" }],
  });

  const early = row("FC-EARLY");
  assert.equal(early?.status, "approved");
  assert.equal(Date.parse(early?.reported_at_utc ?? ""), Date.parse(TRIAGE_AT));
  assert.equal(early?.week_start, weekStartUtcISO(TRIAGE_AT));
  assert.equal(row("FC-WONT")?.status, "rejected");
  assert.equal(row("FC-NEED")?.status, "rejected");
  const slack = getDb()
    .prepare(`SELECT status FROM reports WHERE slack_message_url = ?`)
    .get("https://northline.slack.com/archives/C000FIELD00/p999") as { status: string };
  assert.equal(slack.status, "approved");
});

test("a committed snapshot credits the triage week and leaves an uncertain bug alone", async () => {
  seed("snap@northline.example");
  for (const key of ["FC-KEEP", "FC-DROP", "FC-MAYBE"]) {
    createReport("admin", {
      email: "snap@northline.example",
      text: key,
      slackMessageUrl: browse(key),
      reportedAtUtc: "2026-09-01T15:00:00.000Z",
    });
  }

  const snapshot = await buildJiraTriageSnapshot({
    site: SITE,
    epic: "FC-100",
    search: async () => ({
      issues: [
        { key: "FC-KEEP", summary: "kept", reporterEmail: "snap@northline.example" },
        { key: "FC-HIDDEN", summary: "no email", reporterEmail: " " },
        { key: "FC-MAYBE", summary: "changelog down", reporterEmail: "snap@northline.example" },
      ],
    }),
    changelog: async (key: string) => {
      if (key === "FC-MAYBE") throw new Error("down");
      return [{ at: TRIAGE_AT, from: "NEEDS TRIAGE", to: "Triaged" }];
    },
  });

  assert.deepEqual(
    snapshot.issues.map((issue) => issue.key),
    ["FC-KEEP"],
  );
  assert.equal(snapshot.issues[0]?.triageAt, TRIAGE_AT);
  assert.deepEqual(snapshot.uncertain.sort(), ["FC-HIDDEN", "FC-MAYBE"]);

  applyJiraTriageSnapshot("gha-jira", snapshot);
  const kept = row("FC-KEEP");
  assert.equal(kept?.status, "approved");
  assert.equal(Date.parse(kept?.reported_at_utc ?? ""), Date.parse(TRIAGE_AT));
  assert.equal(kept?.week_start, weekStartUtcISO(TRIAGE_AT));
  assert.equal(row("FC-DROP")?.status, "rejected");
  assert.equal(row("FC-MAYBE")?.status, "approved");
});

test("an empty snapshot is not published and a missing file does not reject reports", () => {
  seed("file@northline.example");
  createReport("admin", {
    email: "file@northline.example",
    text: "already scored",
    slackMessageUrl: browse("FC-FILE"),
    reportedAtUtc: "2026-09-01T15:00:00.000Z",
  });

  assert.throws(() =>
    assertPublishable({ site: SITE, epic: "FC-100", issues: [], uncertain: [] }),
  );

  const missing = importJiraTriageFile(path.join(dir, "missing.json"));
  assert.equal(missing.skipped, true);
  assert.equal(row("FC-FILE")?.status, "approved");

  const emptyPath = path.join(dir, "empty.json");
  writeFileSync(
    emptyPath,
    JSON.stringify({ site: SITE, epic: "FC-100", issues: [], uncertain: [] }),
  );
  const empty = importJiraTriageFile(emptyPath);
  assert.equal(empty.skipped, true);
  assert.equal(empty.reason, "empty");
  assert.equal(row("FC-FILE")?.status, "approved");
});

test("a cloud id sends Jira calls to the API gateway", () => {
  assert.equal(
    jiraRestRoot("issues.northline.example", "00000000-0000-4000-8000-000000000001"),
    "https://api.atlassian.com/ex/jira/00000000-0000-4000-8000-000000000001",
  );
  assert.equal(jiraRestRoot("issues.northline.example", "  "), "https://issues.northline.example");
});
