import { v4 as uuid } from "uuid";
import { parseCsv } from "./import/csv.js";
import { audit, getDb, nowISO } from "./db.js";
import { recomputeWeekScores } from "./scoring/engine.js";
import { weekStartUtcISO } from "./week.js";

export type IntakeReportInput = {
  email: string;
  slackMessageUrl?: string;
  reportedAtUtc?: string;
  reportedAt?: string;
  text?: string;
};

export type IntakeResult = {
  dryRun: boolean;
  total: number;
  wouldInsert: number;
  skippedDuplicate: number;
  skippedUnknownEmail: number;
  skippedNoUrl: number;
  inserted: number;
  /** Rows that threw on write (bad date, race, etc). The rest of the batch still lands. */
  failed: number;
  rows: Array<{ email: string; slackMessageUrl: string; action: string; error?: string }>;
};

function pickCsv(row: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim()) return String(row[key]).trim();
  }
  return "";
}

export function reportsFromCsv(text: string): IntakeReportInput[] {
  return parseCsv(text).map((row) => ({
    email: pickCsv(row, ["email"]),
    text: pickCsv(row, ["text", "report_text"]),
    slackMessageUrl: pickCsv(row, ["slackMessageUrl", "slack_message_url", "link"]),
    reportedAtUtc: pickCsv(row, ["reportedAtUtc", "reported_at_utc"]),
    reportedAt: pickCsv(row, ["reportedAt", "date"]),
  }));
}

function resolveReportedAtUtc(input: IntakeReportInput): string {
  const iso = (input.reportedAtUtc || "").trim();
  if (iso) return iso;
  const dateOnly = (input.reportedAt || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return `${dateOnly}T12:00:00.000Z`;
  return "";
}

function classifyIntakeRow(
  input: IntakeReportInput,
  seenInBatch: Set<string>,
): {
  email: string;
  url: string;
  action: "wouldInsert" | "insert" | "skippedNoUrl" | "skippedUnknownEmail" | "skippedDuplicate";
} {
  const email = (input.email || "").trim().toLowerCase();
  const url = (input.slackMessageUrl || "").trim();
  if (!url) return { email, url, action: "skippedNoUrl" };

  const db = getDb();
  const person = db
    .prepare(`SELECT email, signup_status FROM participants WHERE lower(email) = ?`)
    .get(email) as { email: string; signup_status: string } | undefined;
  if (!person || person.signup_status === "rejected") {
    return { email, url, action: "skippedUnknownEmail" };
  }

  const dupe = db
    .prepare(`SELECT report_id FROM reports WHERE slack_message_url = ?`)
    .get(url) as { report_id: string } | undefined;
  if (dupe) return { email, url, action: "skippedDuplicate" };

  // A live run writes each report as it goes, so the second copy of a URL repeated *within one
  // batch* is caught by the DB check above. A dry run writes nothing, so without this it would
  // count both and promise more inserts than the live run performs — and the dry run is what the
  // operator approves. Tracking the batch keeps the two paths in agreement.
  if (seenInBatch.has(url)) return { email, url, action: "skippedDuplicate" };
  return { email, url, action: "wouldInsert" };
}

export function intakeReports(
  actor: string,
  input: { reports?: IntakeReportInput[]; csv?: string; dryRun?: boolean },
): IntakeResult {
  const reports = input.reports ?? (input.csv ? reportsFromCsv(input.csv) : []);
  const dryRun = Boolean(input.dryRun);
  const result: IntakeResult = {
    dryRun,
    total: reports.length,
    wouldInsert: 0,
    skippedDuplicate: 0,
    skippedUnknownEmail: 0,
    skippedNoUrl: 0,
    inserted: 0,
    failed: 0,
    rows: [],
  };

  const seenInBatch = new Set<string>();
  const weeksTouched = new Set<string>();
  for (const raw of reports) {
    const classified = classifyIntakeRow(raw, seenInBatch);
    if (classified.action === "skippedNoUrl") {
      result.skippedNoUrl += 1;
      result.rows.push({ email: classified.email, slackMessageUrl: classified.url, action: "skippedNoUrl" });
      continue;
    }
    if (classified.action === "skippedUnknownEmail") {
      result.skippedUnknownEmail += 1;
      result.rows.push({
        email: classified.email,
        slackMessageUrl: classified.url,
        action: "skippedUnknownEmail",
      });
      continue;
    }
    if (classified.action === "skippedDuplicate") {
      result.skippedDuplicate += 1;
      result.rows.push({
        email: classified.email,
        slackMessageUrl: classified.url,
        action: "skippedDuplicate",
      });
      continue;
    }

    if (dryRun) {
      // Claimed here rather than at the top of the loop: a dry run writes nothing, so this Set is
      // the only thing that stops a link repeated within one batch from being counted twice.
      seenInBatch.add(classified.url);
      result.wouldInsert += 1;
      result.rows.push({
        email: classified.email,
        slackMessageUrl: classified.url,
        action: "wouldInsert",
      });
      continue;
    }

    // One bad row must not abandon the rest of the batch, and must not vanish. Previously a throw
    // here escaped the function entirely: earlier rows were already committed, later rows were
    // not, and the caller got an exception instead of a result — so the operator had no way to
    // tell what had landed. This mirrors the CSV importer, which commits valid rows and reports
    // invalid ones rather than failing the whole file.
    try {
      const created = createReport(
        actor,
        {
          email: classified.email,
          text: raw.text,
          slackMessageUrl: classified.url,
          reportedAtUtc: resolveReportedAtUtc(raw),
        },
        { deferRecompute: true },
      );
      seenInBatch.add(classified.url);
      weeksTouched.add(created.weekStart);
      result.inserted += 1;
      result.rows.push({ email: classified.email, slackMessageUrl: classified.url, action: "insert" });
    } catch (err) {
      result.failed += 1;
      result.rows.push({
        email: classified.email,
        slackMessageUrl: classified.url,
        action: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Deferred from each createReport: one pass per distinct week, not one per report.
  for (const week of weeksTouched) recomputeWeekScores(week);

  return result;
}

export function listReports(status?: string, limit = 100) {
  const db = getDb();
  if (status) {
    return db
      .prepare(
        `SELECT report_id as reportId, email, reported_at_utc as reportedAtUtc, status,
                approved_at_utc as approvedAtUtc, approved_by as approvedBy,
                slack_message_url as slackMessageUrl, week_start as weekStart,
                report_text as text, created_at as createdAt, created_by as createdBy,
                decided_at_utc as decidedAtUtc, decided_by as decidedBy
         FROM reports WHERE status = ? ORDER BY reported_at_utc DESC LIMIT ?`,
      )
      .all(status, limit);
  }
  return db
    .prepare(
      `SELECT report_id as reportId, email, reported_at_utc as reportedAtUtc, status,
              approved_at_utc as approvedAtUtc, approved_by as approvedBy,
              slack_message_url as slackMessageUrl, week_start as weekStart,
              report_text as text, created_at as createdAt, created_by as createdBy,
              decided_at_utc as decidedAtUtc, decided_by as decidedBy
       FROM reports ORDER BY reported_at_utc DESC LIMIT ?`,
    )
    .all(limit);
}

/**
 * Admin-authored report credited to one person.
 *
 * The admin adding it is the reviewer, so there is no pending queue: the row is written approved
 * and that period's scores recompute immediately.
 */
export function createReport(
  actor: string,
  input: {
    email: string;
    text?: string;
    slackMessageUrl?: string;
    reportedAtUtc?: string;
  },
  /**
   * `deferRecompute` lets a batch caller skip the per-report week recompute and do one pass at the
   * end. A 40-row intake was running 40 full recomputes (~100ms each) for an identical result.
   */
  opts: { deferRecompute?: boolean } = {},
): {
  reportId: string;
  email: string;
  status: "approved";
  reportedAtUtc: string;
  weekStart: string;
} {
  const email = (input.email || "").trim().toLowerCase();
  if (!email) throw new Error("Pick a person for this report");

  const db = getDb();
  const person = db
    .prepare(
      `SELECT email, signup_status FROM participants WHERE lower(email) = ?`,
    )
    .get(email) as { email: string; signup_status: string } | undefined;
  if (!person) throw new Error(`${email} is not on the roster`);
  if (person.signup_status === "rejected") {
    throw new Error(`${email} is a rejected registration and cannot be credited`);
  }

  const reportedAtUtc = (input.reportedAtUtc || "").trim() || nowISO();
  if (Number.isNaN(Date.parse(reportedAtUtc))) {
    throw new Error("Report date is not a valid date");
  }

  const url = (input.slackMessageUrl || "").trim();
  if (url) {
    const dupe = db
      .prepare(`SELECT report_id FROM reports WHERE slack_message_url = ?`)
      .get(url) as { report_id: string } | undefined;
    if (dupe) throw new Error("A report with that Slack link already exists");
  }

  const now = nowISO();
  const reportId = uuid();
  const weekStart = weekStartUtcISO(reportedAtUtc);

  db.prepare(
    `INSERT INTO reports (
      report_id, email, reported_at_utc, status, approved_at_utc, approved_by,
      slack_message_url, week_start, report_text, created_at, created_by,
      decided_at_utc, decided_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reportId,
    person.email,
    reportedAtUtc,
    "approved",
    now,
    actor,
    url || null,
    weekStart,
    input.text?.trim() || null,
    now,
    actor,
    now,
    actor,
  );

  if (!opts.deferRecompute) recomputeWeekScores(weekStart);

  audit(actor, "reports.create", {
    entityType: "report",
    entityId: reportId,
    newValue: { email: person.email, status: "approved", reportedAtUtc, weekStart },
  });

  return { reportId, email: person.email, status: "approved" as const, reportedAtUtc, weekStart };
}
