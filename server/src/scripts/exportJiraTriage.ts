// ABOUTME: Writes data/jira-triage.json for the daily GitHub Action.
// ABOUTME: Refuses an empty file, which would reject every Jira report on Harbor.
import fs from "node:fs";
import path from "node:path";
import { fetchJiraTriageSnapshot } from "../jira/poller.js";
import {
  assertPublishable,
  jiraTriagePath,
  serializeJiraTriageSnapshot,
} from "../jira/snapshot.js";

const snapshot = await fetchJiraTriageSnapshot();
assertPublishable(snapshot);
const filePath = jiraTriagePath();
fs.mkdirSync(path.dirname(filePath), { recursive: true });
fs.writeFileSync(filePath, serializeJiraTriageSnapshot(snapshot));
console.log(
  `Wrote ${snapshot.issues.length} triaged issues (${snapshot.uncertain.length} uncertain) to ${filePath}`,
);
