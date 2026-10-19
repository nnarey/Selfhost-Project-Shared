/**
 * Regenerates synthetic paired CSVs relative to the current Phoenix week.
 * Run: npx tsx src/scripts/generateFixtures.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { weekStartUtcISO } from "../week.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../../fixtures");

const weekStart = new Date(weekStartUtcISO(new Date()));
const hours = (h: number) => new Date(weekStart.getTime() + h * 3600 * 1000).toISOString();

const assignments = [
  ["asg-alice-1", "FC-1001", "alice@northline.example", hours(2), "", "fleet", "open"],
  ["asg-bob-1", "FC-1002", "bob@northline.example", hours(3), "", "fleet", "open"],
  ["asg-cara-1", "FC-1003", "cara@northline.example", hours(4), hours(50), "fleet", "closed"],
  ["asg-cara-2", "FC-1003", "devon@northline.example", hours(50), "", "fleet", "open"],
  ["asg-elena-1", "FC-1004", "elena@northline.example", hours(5), "", "fleet", "open"],
  ["asg-frank-1", "FC-1005", "frank@northline.example", hours(6), "", "fleet", "open"],
  // Grace returned midweek — keeps earned points, no further attribution
  ["asg-grace-1", "FC-1006", "grace@northline.example", hours(8), hours(40), "fleet", "closed"],
  // Hank open but idle (for reminder eligibility)
  ["asg-hank-1", "FC-1007", "hank@northline.example", hours(10), "", "fleet", "open"],
  // Unassigned stock — Devices lists these as available
  ["", "FC-1008", "", "", "", "fleet", "available"],
  ["", "FC-1099", "", "", "", "fleet", "available"],
];

const events: string[][] = [];
let n = 1;
const add = (
  camera: string,
  hourOffset: number,
  type: string,
  duration: number,
  purpose: string,
  status: string,
) => {
  events.push([
    `evt-${String(n++).padStart(4, "0")}`,
    hours(hourOffset),
    camera,
    type,
    String(duration),
    purpose,
    status,
  ]);
};

// Alice: active scorer (includes a recent clip so inactivity does not dominate)
add("FC-1001", 5, "recording", 120, "PURPOSE_STANDARD", "success");
add("FC-1001", 6, "recording", 3600, "PURPOSE_STANDARD", "success");
add("FC-1001", 7, "upload", 0, "", "success");
add("FC-1001", 29, "recording", 90, "PURPOSE_STANDARD", "success");
add("FC-1001", 30, "livestream", 600, "", "success");
add("FC-1001", 100, "recording", 180, "PURPOSE_STANDARD", "success");
add("FC-1001", 101, "upload", 0, "", "success");

// Bob: medium
add("FC-1002", 8, "recording", 45, "PURPOSE_STANDARD", "success");
add("FC-1002", 9, "recording", 20, "PURPOSE_STANDARD", "success"); // too short — ignored
add("FC-1002", 32, "recording", 1800, "PURPOSE_STANDARD", "success");
add("FC-1002", 33, "upload", 0, "", "success");

// Cara then Devon on same camera — attribution split by time
add("FC-1003", 10, "recording", 600, "PURPOSE_STANDARD", "success"); // Cara
add("FC-1003", 52, "recording", 900, "PURPOSE_STANDARD", "success"); // Devon

// Elena
add("FC-1004", 12, "recording", 300, "PURPOSE_STANDARD", "success");
add("FC-1004", 36, "recording", 7200, "PURPOSE_STANDARD", "success");

// Frank
add("FC-1005", 14, "recording", 400, "PURPOSE_STANDARD", "success");

// Grace before return
add("FC-1006", 12, "recording", 500, "PURPOSE_STANDARD", "success");
add("FC-1006", 20, "upload", 0, "", "success");
// After return — should quarantine (no open assignment)
add("FC-1006", 45, "recording", 200, "PURPOSE_STANDARD", "success");

// Unassigned camera activity — quarantine
add("FC-1008", 15, "recording", 100, "PURPOSE_STANDARD", "success");

// Hank: assignment only, no recordings (onboarding/inactivity reminder)

const assignCsv = [
  "assignment_id,camera_id,email,assigned_at_utc,unassigned_at_utc,source,status",
  ...assignments.map((r) => r.join(",")),
].join("\n");

const activityCsv = [
  "event_id,event_time_utc,camera_id,event_type,duration_seconds,purpose,status",
  ...events.map((r) => r.join(",")),
].join("\n");

fs.mkdirSync(fixturesDir, { recursive: true });
fs.writeFileSync(path.join(fixturesDir, "assignments.csv"), assignCsv + "\n");
fs.writeFileSync(path.join(fixturesDir, "activity_events.csv"), activityCsv + "\n");
fs.writeFileSync(
  path.join(fixturesDir, "README.md"),
  `# Synthetic paired fixtures

Generated for Phoenix week starting \`${weekStart.toISOString()}\`.

- \`activity_events.csv\` — Splunk-like event-level activity
- \`assignments.csv\` — Fleet assignment history plus unassigned camera_id rows for available stock

Regenerate with:

\`\`\`bash
cd server && npx tsx src/scripts/generateFixtures.ts
\`\`\`

These use the canonical column names. Native Splunk/Fleet headers will map through Admin mapping profiles once real samples arrive.
`,
);

console.log(`Wrote fixtures for week ${weekStart.toISOString()} → ${fixturesDir}`);
