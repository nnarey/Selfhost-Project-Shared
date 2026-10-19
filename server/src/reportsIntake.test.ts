import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "fieldcam-reports-intake-"));
process.env.DATABASE_PATH = path.join(dir, "test.sqlite");

const { getDb } = await import("./db.js");
const { intakeReports, reportsFromCsv } = await import("./reports.js");

function seedPerson(email = "alice@northline.example") {
  const now = "2026-08-28T12:00:00.000Z";
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO participants (
        email, name, hub, signup_status, enrolled_at, status, created_at, updated_at
      ) VALUES (?, 'Alice Chen', 'Phoenix', 'approved', ?, 'Active', ?, ?)`,
    )
    .run(email, now, now, now);
}

test("dry-run counts a new URL; live insert; second intake skips the duplicate", () => {
  seedPerson();
  const reports = [
    {
      email: "alice@northline.example",
      slackMessageUrl: "https://northline.slack.com/archives/C000FIELD00/p111",
      text: "Battery stuck at 33%",
      reportedAtUtc: "2026-08-26T18:16:43.000Z",
    },
  ];

  const dry = intakeReports("cara@northline.example", { reports, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldInsert, 1);
  assert.equal(dry.inserted, 0);
  assert.equal(dry.skippedDuplicate, 0);
  // Scoped to this URL: all tests share one temp DB, so a table-wide count would break as soon
  // as any earlier test inserted a row.
  assert.equal(
    (
      getDb()
        .prepare(`SELECT count(*) AS c FROM reports WHERE slack_message_url = ?`)
        .get(reports[0].slackMessageUrl) as { c: number }
    ).c,
    0,
  );

  const first = intakeReports("cara@northline.example", { reports, dryRun: false });
  assert.equal(first.inserted, 1);
  assert.equal(first.skippedDuplicate, 0);

  const second = intakeReports("cara@northline.example", { reports, dryRun: false });
  assert.equal(second.inserted, 0);
  assert.equal(second.skippedDuplicate, 1);
});

test("mixed file inserts only the new URL", () => {
  seedPerson();
  const existing = "https://issues.northline.example/browse/FC-13677";
  intakeReports("cara@northline.example", {
    dryRun: false,
    reports: [
      {
        email: "alice@northline.example",
        slackMessageUrl: existing,
        text: "already in",
        reportedAtUtc: "2026-08-26T11:16:43.000Z",
      },
    ],
  });

  const mixed = intakeReports("cara@northline.example", {
    dryRun: false,
    reports: [
      {
        email: "alice@northline.example",
        slackMessageUrl: existing,
        text: "already in",
        reportedAtUtc: "2026-08-26T11:16:43.000Z",
      },
      {
        email: "alice@northline.example",
        slackMessageUrl: "https://issues.northline.example/browse/FC-13764",
        text: "new finding",
        reportedAtUtc: "2026-08-28T18:07:19.000Z",
      },
    ],
  });
  assert.equal(mixed.inserted, 1);
  assert.equal(mixed.skippedDuplicate, 1);
});

test("date-only reportedAt becomes midday UTC", () => {
  seedPerson();
  const result = intakeReports("cara@northline.example", {
    dryRun: false,
    reports: [
      {
        email: "alice@northline.example",
        slackMessageUrl: "https://docs.google.com/spreadsheets/d/x/edit?issue=1#gid=0",
        text: "Loose in dock",
        reportedAt: "2026-08-25",
      },
    ],
  });
  assert.equal(result.inserted, 1);
  const row = getDb()
    .prepare(`SELECT reported_at_utc AS reportedAtUtc FROM reports WHERE slack_message_url = ?`)
    .get("https://docs.google.com/spreadsheets/d/x/edit?issue=1#gid=0") as {
    reportedAtUtc: string;
  };
  assert.equal(row.reportedAtUtc, "2026-08-25T12:00:00.000Z");
});

test("CSV parse maps headers; missing slackMessageUrl is skipped", () => {
  seedPerson();
  const parsed = reportsFromCsv(
    [
      "email,text,slackMessageUrl,reportedAt",
      "alice@northline.example,Has a url,https://example.com/a,2026-08-26",
      "alice@northline.example,No url,,2026-08-26",
    ].join("\n"),
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].slackMessageUrl, "");

  const result = intakeReports("cara@northline.example", { reports: parsed, dryRun: false });
  assert.equal(result.inserted, 1);
  assert.equal(result.skippedNoUrl, 1);
  assert.equal(
    (getDb().prepare(`SELECT count(*) AS c FROM reports WHERE slack_message_url = 'https://example.com/a'`).get() as { c: number }).c,
    1,
  );
});

test("a URL repeated inside one batch: dry-run predicts exactly what the live run inserts", () => {
  seedPerson();
  const url = "https://northline.slack.com/archives/C000FIELD00/p999";
  const batch = [
    { email: "alice@northline.example", slackMessageUrl: url, text: "first" },
    { email: "alice@northline.example", slackMessageUrl: url, text: "same link again" },
  ];

  const dry = intakeReports("cara@northline.example", { reports: batch, dryRun: true });
  const live = intakeReports("cara@northline.example", { reports: batch, dryRun: false });

  // The dry run is the operator's confirmation gate, so it must not promise more than it delivers.
  assert.equal(dry.wouldInsert, live.inserted);
  assert.equal(dry.skippedDuplicate, 1);
  assert.equal(live.inserted, 1);
  assert.equal(live.skippedDuplicate, 1);
});

test("a row that throws is reported, not fatal — the rest of the batch still lands", () => {
  seedPerson();
  seedPerson("bob@northline.example");
  const result = intakeReports("cara@northline.example", {
    dryRun: false,
    reports: [
      { email: "alice@northline.example", slackMessageUrl: "https://x/good-1", reportedAtUtc: "2026-08-26T12:00:00.000Z" },
      { email: "bob@northline.example", slackMessageUrl: "https://x/bad-date", reportedAtUtc: "NOT-A-DATE" },
      { email: "alice@northline.example", slackMessageUrl: "https://x/good-2", reportedAtUtc: "2026-08-26T12:00:00.000Z" },
    ],
  });

  // Previously the throw escaped intakeReports: earlier rows were already committed, later ones
  // were not, and the caller got no result at all.
  assert.equal(result.inserted, 2);
  assert.equal(result.failed, 1);
  const failedRow = result.rows.find((r) => r.action === "failed");
  assert.ok(failedRow?.error, "failed row should carry the reason");

  // Every row is accounted for in exactly one bucket.
  assert.equal(
    result.inserted +
      result.failed +
      result.skippedDuplicate +
      result.skippedNoUrl +
      result.skippedUnknownEmail,
    result.total,
  );
});

test("a failed row does not consume its link — a later row with the same link still gets a try", () => {
  seedPerson();
  const url = "https://northline.slack.com/archives/C000FIELD00/p777";
  const result = intakeReports("cara@northline.example", {
    dryRun: false,
    reports: [
      // Fails on the date, so this link was never actually written.
      { email: "alice@northline.example", slackMessageUrl: url, reportedAtUtc: "NOT-A-DATE" },
      // Same link, valid date. Must be attempted, not written off as a duplicate of a row
      // that never landed.
      { email: "alice@northline.example", slackMessageUrl: url, reportedAtUtc: "2026-08-26T12:00:00.000Z" },
    ],
  });

  assert.equal(result.failed, 1);
  assert.equal(result.inserted, 1);
  assert.equal(result.skippedDuplicate, 0);
});

test("reportsFromCsv accepts snake_case and `link` aliases", () => {
  const rows = reportsFromCsv(
    "email,report_text,slack_message_url,reported_at_utc\n" +
      "alice@northline.example,Body text,https://x/alias-1,2026-08-26T18:00:00.000Z\n",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "Body text");
  assert.equal(rows[0].slackMessageUrl, "https://x/alias-1");
  assert.equal(rows[0].reportedAtUtc, "2026-08-26T18:00:00.000Z");

  const viaLink = reportsFromCsv("email,link,date\nalice@northline.example,https://x/alias-2,2026-08-26\n");
  assert.equal(viaLink[0].slackMessageUrl, "https://x/alias-2");
  assert.equal(viaLink[0].reportedAt, "2026-08-26");
});

test("no date at all still credits the report, dated now", () => {
  seedPerson();
  const before = Date.now();
  intakeReports("cara@northline.example", {
    dryRun: false,
    reports: [{ email: "alice@northline.example", slackMessageUrl: "https://x/no-date" }],
  });
  const row = getDb()
    .prepare(`SELECT reported_at_utc, week_start FROM reports WHERE slack_message_url = ?`)
    .get("https://x/no-date") as { reported_at_utc: string; week_start: string };
  assert.ok(row.week_start, "must land in a week so it can score");
  assert.ok(Date.parse(row.reported_at_utc) >= before - 1000);
});

test("the csv input path is equivalent to passing reports directly", () => {
  seedPerson();
  const csv =
    "email,text,slackMessageUrl,reportedAtUtc\n" +
    "alice@northline.example,From CSV,https://x/csv-1,2026-08-26T12:00:00.000Z\n" +
    "nobody@northline.example,Off roster,https://x/csv-2,2026-08-26T12:00:00.000Z\n";
  const result = intakeReports("cara@northline.example", { csv, dryRun: false });
  assert.equal(result.total, 2);
  assert.equal(result.inserted, 1);
  assert.equal(result.skippedUnknownEmail, 1);
});
