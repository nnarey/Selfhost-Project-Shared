// ABOUTME: Reads the Jira triage file committed by GitHub Actions and applies it on boot.
// ABOUTME: An empty or missing file leaves existing report scores alone.
import fs from "node:fs";
import path from "node:path";
import { SERVER_ROOT } from "../env.js";
import {
  applyJiraTriageSnapshot,
  type JiraTriageResult,
  type JiraTriageSnapshot,
} from "./triage.js";

export function jiraTriagePath(): string {
  const fromEnv = process.env.JIRA_TRIAGE_PATH?.trim();
  if (fromEnv) return fromEnv;
  return path.resolve(SERVER_ROOT, "../data/jira-triage.json");
}

export function assertPublishable(snapshot: JiraTriageSnapshot): void {
  if (snapshot.issues.length === 0) {
    throw new Error(
      `Jira triage snapshot has no triaged issues (${snapshot.uncertain.length} uncertain); not publishing`,
    );
  }
}

export function serializeJiraTriageSnapshot(snapshot: JiraTriageSnapshot): string {
  const issues = [...snapshot.issues].sort((a, b) => a.key.localeCompare(b.key));
  const uncertain = [...new Set(snapshot.uncertain)].sort();
  return (
    JSON.stringify({ site: snapshot.site, epic: snapshot.epic, issues, uncertain }, null, 2) + "\n"
  );
}

export function importJiraTriageFile(
  filePath = jiraTriagePath(),
): { skipped: true; reason: string } | ({ skipped: false } & JiraTriageResult) {
  if (!fs.existsSync(filePath)) return { skipped: true, reason: "missing" };
  let snapshot: JiraTriageSnapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(filePath, "utf8")) as JiraTriageSnapshot;
  } catch {
    return { skipped: true, reason: "unreadable" };
  }
  if (!snapshot || typeof snapshot.site !== "string" || !Array.isArray(snapshot.issues)) {
    return { skipped: true, reason: "unreadable" };
  }
  if (snapshot.issues.length === 0) return { skipped: true, reason: "empty" };
  if (!Array.isArray(snapshot.uncertain)) snapshot.uncertain = [];
  return { skipped: false, ...applyJiraTriageSnapshot("gha-jira", snapshot) };
}
