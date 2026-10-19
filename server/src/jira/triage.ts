// ABOUTME: Credits a roster reporter when a self-host bug moves from NEEDS TRIAGE to Triaged.
// ABOUTME: Won't Fix without that transition does not score, and a later Won't Fix keeps the points.
import { audit, getDb, nowISO } from "../db.js";
import { createReport } from "../reports.js";
import { recomputeWeekScores } from "../scoring/engine.js";
import { weekStartUtcISO } from "../week.js";

export type StatusChange = { at: string; from: string; to: string };

export type JiraIssueSummary = {
  key: string;
  summary: string;
  reporterEmail: string;
};

export type JiraSearchPage = {
  issues: JiraIssueSummary[];
  nextPageToken?: string;
};

export type JiraTriageIssue = JiraIssueSummary & { triageAt: string };

export type JiraTriageSnapshot = {
  site: string;
  epic: string;
  issues: JiraTriageIssue[];
  uncertain: string[];
};

export type JiraTriageResult = {
  credited: number;
  moved: number;
  rejected: number;
  unchanged: number;
};

type ReportRow = {
  report_id: string;
  status: string;
  reported_at_utc: string;
  week_start: string | null;
};

function earliestTriageAt(changes: StatusChange[]): string | null {
  let best: number | null = null;
  for (const change of changes) {
    if (change.from !== "NEEDS TRIAGE" || change.to !== "Triaged") continue;
    const at = Date.parse(change.at);
    if (Number.isNaN(at)) continue;
    if (best == null || at < best) best = at;
  }
  return best == null ? null : new Date(best).toISOString();
}

function rosterEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const row = getDb()
    .prepare(`SELECT email, signup_status FROM participants WHERE lower(email) = ?`)
    .get(normalized) as { email: string; signup_status: string } | undefined;
  if (!row || row.signup_status === "rejected") return null;
  return row.email;
}

function browseUrl(site: string, key: string): string {
  return `https://${site}/browse/${key}`;
}

function issueKey(site: string, url: string): string | null {
  const prefix = `https://${site}/browse/`;
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length).split(/[?#]/)[0];
  return key || null;
}

export async function buildJiraTriageSnapshot(opts: {
  site: string;
  epic?: string;
  search: (pageToken?: string) => Promise<JiraSearchPage>;
  changelog: (key: string) => Promise<StatusChange[]>;
}): Promise<JiraTriageSnapshot> {
  const found: JiraIssueSummary[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await opts.search(pageToken);
    found.push(...result.issues);
    if (!result.nextPageToken || result.nextPageToken === pageToken) break;
    pageToken = result.nextPageToken;
  }

  const issues: JiraTriageIssue[] = [];
  const uncertain: string[] = [];
  for (const issue of found) {
    let changes: StatusChange[];
    try {
      changes = await opts.changelog(issue.key);
    } catch {
      uncertain.push(issue.key);
      continue;
    }
    const triageAt = earliestTriageAt(changes);
    if (!triageAt || !issue.reporterEmail.trim()) {
      uncertain.push(issue.key);
      continue;
    }
    issues.push({ ...issue, triageAt });
  }
  return { site: opts.site, epic: opts.epic ?? "", issues, uncertain };
}

export function applyJiraTriageSnapshot(actor: string, snapshot: JiraTriageSnapshot): JiraTriageResult {
  const triaged = new Set<string>();
  // A failed changelog read must not reject a report we could not prove was never triaged.
  const uncertain = new Set(snapshot.uncertain);
  const weeks = new Set<string>();
  let credited = 0;
  let moved = 0;
  let unchanged = 0;

  for (const issue of snapshot.issues) {
    if (!issue.triageAt || !issue.reporterEmail.trim()) {
      uncertain.add(issue.key);
      continue;
    }
    const email = rosterEmail(issue.reporterEmail);
    if (!email) continue;

    try {
      const outcome = creditOrMove(actor, snapshot.site, issue, email, issue.triageAt, weeks);
      triaged.add(issue.key);
      if (outcome === "credited") credited += 1;
      else if (outcome === "moved") moved += 1;
      else unchanged += 1;
    } catch {
      uncertain.add(issue.key);
    }
  }

  const rejected = rejectNeverTriaged(actor, snapshot.site, triaged, uncertain, weeks);
  for (const week of weeks) recomputeWeekScores(week);
  return { credited, moved, rejected, unchanged };
}

export async function syncJiraTriage(opts: {
  actor: string;
  site: string;
  search: (pageToken?: string) => Promise<JiraSearchPage>;
  changelog: (key: string) => Promise<StatusChange[]>;
}): Promise<JiraTriageResult> {
  const snapshot = await buildJiraTriageSnapshot(opts);
  return applyJiraTriageSnapshot(opts.actor, snapshot);
}

function creditOrMove(
  actor: string,
  site: string,
  issue: JiraIssueSummary,
  email: string,
  at: string,
  weeks: Set<string>,
): "credited" | "moved" | "unchanged" {
  const db = getDb();
  const url = browseUrl(site, issue.key);
  const existing = db
    .prepare(
      `SELECT report_id, status, reported_at_utc, week_start FROM reports WHERE slack_message_url = ?`,
    )
    .get(url) as ReportRow | undefined;

  if (!existing) {
    const created = createReport(
      actor,
      { email, text: issue.summary, slackMessageUrl: url, reportedAtUtc: at },
      { deferRecompute: true },
    );
    weeks.add(created.weekStart);
    return "credited";
  }

  const sameTime = Date.parse(existing.reported_at_utc) === Date.parse(at);
  if (sameTime && existing.status === "approved") return "unchanged";

  const weekStart = weekStartUtcISO(at);
  const now = nowISO();
  db.prepare(
    `UPDATE reports
     SET status = 'approved', reported_at_utc = ?, week_start = ?,
         approved_at_utc = ?, approved_by = ?, decided_at_utc = ?, decided_by = ?
     WHERE report_id = ?`,
  ).run(at, weekStart, now, actor, now, actor, existing.report_id);
  if (existing.week_start) weeks.add(existing.week_start);
  weeks.add(weekStart);
  audit(actor, "reports.jira-triage", {
    entityType: "report",
    entityId: existing.report_id,
    oldValue: { status: existing.status, reportedAtUtc: existing.reported_at_utc },
    newValue: { status: "approved", reportedAtUtc: at, weekStart },
  });
  return "moved";
}

function rejectNeverTriaged(
  actor: string,
  site: string,
  triaged: Set<string>,
  uncertain: Set<string>,
  weeks: Set<string>,
): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT report_id, slack_message_url, week_start FROM reports
       WHERE status = 'approved' AND slack_message_url LIKE ?`,
    )
    .all(`https://${site}/browse/%`) as Array<{
    report_id: string;
    slack_message_url: string;
    week_start: string | null;
  }>;

  const now = nowISO();
  let rejected = 0;
  const mark = db.prepare(
    `UPDATE reports SET status = 'rejected', decided_at_utc = ?, decided_by = ? WHERE report_id = ?`,
  );
  for (const row of rows) {
    const key = issueKey(site, row.slack_message_url);
    if (!key || triaged.has(key) || uncertain.has(key)) continue;
    mark.run(now, actor, row.report_id);
    if (row.week_start) weeks.add(row.week_start);
    audit(actor, "reports.jira-triage", {
      entityType: "report",
      entityId: row.report_id,
      newValue: { status: "rejected", key },
    });
    rejected += 1;
  }
  return rejected;
}
