import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../db.js";
import { ENV, SERVER_ROOT } from "../env.js";

const SLACK_CHANNEL = "C000FIELD00";
const SHEET_RANGE = "Sheet1!B5:J200";

type RosterRow = { email: string; name: string };
type Candidate = {
  email: string;
  text: string;
  slackMessageUrl: string;
  reportedAtUtc: string;
};

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function writeCsv(rows: Candidate[]): string {
  const header = "email,text,slackMessageUrl,reportedAtUtc";
  const body = rows.map((r) =>
    [r.email, r.text, r.slackMessageUrl, r.reportedAtUtc].map(csvEscape).join(","),
  );
  return [header, ...body].join("\n") + "\n";
}

function loadRoster(): RosterRow[] {
  return getDb()
    .prepare(
      `SELECT email, name FROM participants WHERE lower(signup_status) != 'rejected'`,
    )
    .all() as RosterRow[];
}

export function emailFromRoster(roster: RosterRow[], email: string): string | null {
  const hit = roster.find((r) => r.email.toLowerCase() === email.toLowerCase());
  return hit ? hit.email : null;
}

export function emailFromNotedBy(roster: RosterRow[], notedBy: string): string | null {
  const parts = notedBy.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const surname = parts[parts.length - 1].toLowerCase();
  const hits = roster.filter((r) => {
    const nameParts = r.name.trim().split(/\s+/);
    return nameParts[nameParts.length - 1]?.toLowerCase() === surname;
  });
  return hits.length === 1 ? hits[0].email : null;
}

export function shouldKeepSlackText(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 30) return false;
  if (/has joined the channel/i.test(t)) return false;
  if (/has left the channel/i.test(t)) return false;
  if (/made updates to a canvas/i.test(t)) return false;
  if (/uploaded a file/i.test(t) && t.length < 80) return false;
  return true;
}

async function slackApi(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${ENV.slackBotToken}` },
  });
  return (await res.json()) as Record<string, unknown>;
}

async function gatherSlack(roster: RosterRow[]): Promise<{ rows: Candidate[]; skipped: string }> {
  if (!ENV.slackBotToken) return { rows: [], skipped: "SLACK_BOT_TOKEN is not set" };
  const userCache = new Map<string, string | null>();
  const rows: Candidate[] = [];
  let cursor = "";
  try {
    for (;;) {
      const body = await slackApi("conversations.history", {
        channel: SLACK_CHANNEL,
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      if (!body.ok) {
        // Keep what earlier pages already yielded — a rate-limit on page 3 used to discard
        // everything gathered so far and report the source as simply skipped.
        return { rows, skipped: `Slack: ${String(body.error || "request failed")}` };
      }
      const messages = (body.messages as Array<Record<string, unknown>>) || [];
      for (const m of messages) {
        const text = String(m.text || "");
        if (!shouldKeepSlackText(text)) continue;
        const userId = String(m.user || "");
        if (!userId) continue;
        if (!userCache.has(userId)) {
          const info = await slackApi("users.info", { user: userId });
          const user = (info.user || {}) as {
            profile?: { email?: string; real_name?: string };
            real_name?: string;
          };
          const fromEmail = user.profile?.email
            ? emailFromRoster(roster, user.profile.email)
            : null;
          const fromName = emailFromNotedBy(
            roster,
            user.profile?.real_name || user.real_name || "",
          );
          userCache.set(userId, fromEmail || fromName);
        }
        const email = userCache.get(userId);
        if (!email) continue;
        const ts = String(m.ts || "");
        if (!ts) continue;
        const permalink = `https://northline.slack.com/archives/${SLACK_CHANNEL}/p${ts.replace(".", "")}`;
        const sec = Number(ts.split(".")[0]);
        const reportedAtUtc = Number.isFinite(sec)
          ? new Date(sec * 1000).toISOString()
          : "";
        rows.push({ email, text, slackMessageUrl: permalink, reportedAtUtc });
      }
      const next = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      if (!next) break;
      cursor = next;
    }
  } catch (err) {
    return { rows: [], skipped: `Slack: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { rows, skipped: "" };
}

async function gatherSheet(roster: RosterRow[]): Promise<{ rows: Candidate[]; skipped: string }> {
  if (!ENV.googleApiKey) return { rows: [], skipped: "GOOGLE_API_KEY is not set" };
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${ENV.mechanicalSheetId}` +
    `/values/${encodeURIComponent(SHEET_RANGE)}?key=${encodeURIComponent(ENV.googleApiKey)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { rows: [], skipped: `Sheet HTTP ${res.status}` };
    const data = (await res.json()) as { values?: string[][] };
    const values = data.values || [];
    if (!values.length) return { rows: [], skipped: "" };
    const header = values[0].map((h) => h.trim().toLowerCase());
    const idx = (name: string) => header.indexOf(name);
    const idCol = idx("issue id");
    const dateCol = idx("date noticed");
    const snCol = idx("sn#");
    const detailsCol = idx("details");
    const notedCol = idx("noted by");
    const missing = (
      [
        ["issue id", idCol],
        ["date noticed", dateCol],
        ["sn#", snCol],
        ["details", detailsCol],
        ["noted by", notedCol],
      ] as const
    )
      .filter(([, i]) => i < 0)
      .map(([name]) => name);
    if (missing.length) {
      // `raw[-1]` is undefined, which reads as an empty cell — so a renamed header used to yield
      // an empty CSV and report the source as fine.
      return { rows: [], skipped: `Sheet: missing column(s) ${missing.join(", ")}` };
    }
    const rows: Candidate[] = [];
    for (const raw of values.slice(1)) {
      const issueId = (raw[idCol] || "").trim();
      // Skip, don't stop: a blank spacer row mid-sheet used to truncate every report below it.
      if (!issueId) continue;
      const notedBy = (raw[notedCol] || "").trim();
      const email = emailFromNotedBy(roster, notedBy);
      if (!email) continue;
      const sn = (raw[snCol] || "").trim();
      const details = (raw[detailsCol] || "").trim();
      const text = sn && !/^all$/i.test(sn) ? `${sn} — ${details}` : details;
      const date = (raw[dateCol] || "").trim();
      rows.push({
        email,
        text,
        slackMessageUrl: `https://docs.google.com/spreadsheets/d/${ENV.mechanicalSheetId}/edit?issue=${encodeURIComponent(issueId)}#gid=0`,
        reportedAtUtc: /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00.000Z` : "",
      });
    }
    return { rows, skipped: "" };
  } catch (err) {
    return { rows: [], skipped: `Sheet: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function main() {
  const roster = loadRoster();
  const skipped: string[] = [];
  const slack = await gatherSlack(roster);
  if (slack.skipped) skipped.push(slack.skipped);
  const sheet = await gatherSheet(roster);
  if (sheet.skipped) skipped.push(sheet.skipped);

  const combined = [...slack.rows, ...sheet.rows];
  const defaultName = `fieldcam-reports-${new Date().toISOString().slice(0, 10)}.csv`;
  const out = path.resolve(argValue("--out") || path.join(SERVER_ROOT, "data", defaultName));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, writeCsv(combined), "utf8");
  console.log(
    JSON.stringify(
      {
        out,
        rows: combined.length,
        slack: slack.rows.length,
        sheet: sheet.rows.length,
        skippedSources: skipped,
      },
      null,
      2,
    ),
  );
  closeDb();
}

// Only run when invoked as a CLI. Keeping the module importable lets the pure helpers above be
// unit-tested without the script firing off Slack/JIRA/Sheets requests on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
