import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, "..");

function readEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = fs.readFileSync(filePath, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch {
    // optional
  }
  return out;
}

const fileEnv = {
  ...readEnvFile(path.join(SERVER_ROOT, ".env")),
  ...readEnvFile(path.join(SERVER_ROOT, ".env.local")),
};

function get(key: string, fallback = ""): string {
  // Distinguish "unset" from intentionally blank (e.g. REMINDER_LIVE_ALLOWLIST=).
  if (Object.prototype.hasOwnProperty.call(process.env, key) && process.env[key] != null) {
    return String(process.env[key]).trim();
  }
  if (Object.prototype.hasOwnProperty.call(fileEnv, key)) {
    return String(fileEnv[key]).trim();
  }
  return fallback.trim();
}

/**
 * Fleet model strings that count as a self-host camera. The agency device list also returns
 * docks and older cameras, and Fleet names whoever registered the hardware as its "owner" —
 * anything that gets past this filter reads as a checkout by that person. So an unset, blank, or
 * unparseable value falls back to the default instead of disabling the filter.
 */
const DEFAULT_DEVICE_MODEL = "fieldcam_series";
const deviceModelRaw = get("FLEET_DEVICE_MODEL", DEFAULT_DEVICE_MODEL) || DEFAULT_DEVICE_MODEL;
const deviceModels = deviceModelRaw
  .split(",")
  .map((m) => m.trim().toLowerCase())
  .filter(Boolean);

export const ENV = {
  port: Number(get("PORT", "8080")) || 8080,
  /** Built Vite app to serve from this process (Harbor single container). */
  webDist: get("WEB_DIST", ""),
  adminPassword: get("ADMIN_PASSWORD", "Password"),
  adminSessionHours: Number(get("ADMIN_SESSION_HOURS", "8")) || 8,
  databasePath: path.isAbsolute(get("DATABASE_PATH"))
    ? get("DATABASE_PATH")
    : path.join(SERVER_ROOT, get("DATABASE_PATH", "data/fieldcam.sqlite")),
  weekTimezone: get("WEEK_TIMEZONE", "America/Phoenix"),
  /** Phoenix calendar date the open competition starts (YYYY-MM-DD). Activity before this does not score. */
  competitionStartDate: get("COMPETITION_START", "2026-08-31"),
  /** Kickoff for the real biweekly competition; everything before it is preseason. */
  seasonStartDate: get("SEASON_START", "2026-08-31"),

  /** Fleet Partner API ownership sync */
  fleetEnabled: ["1", "true", "yes", "on"].includes(
    get("FLEET_ENABLED", process.env.NODE_ENV === "production" ? "false" : "true").toLowerCase(),
  ),
  /** mock | live | off */
  fleetMode: (get("FLEET_MODE", "mock").toLowerCase() || "mock") as
    | "mock"
    | "live"
    | "off",
  fleetBaseUrl: get("FLEET_BASE_URL", ""),
  fleetTokenUrl: get("FLEET_TOKEN_URL", ""),
  fleetAgencyId: get("FLEET_AGENCY_ID", ""),
  fleetClientId: get("FLEET_CLIENT_ID", ""),
  fleetClientSecret: get("FLEET_CLIENT_SECRET", ""),
  /** Parsed allowlist, lowercased. Never empty — see DEFAULT_DEVICE_MODEL above. */
  fleetDeviceModels: deviceModels.length ? deviceModels : [DEFAULT_DEVICE_MODEL],
  /** Extra querystring, e.g. limit=200 */
  fleetDeviceQuery: get("FLEET_DEVICE_QUERY", ""),
  fleetPollSeconds: Number(get("FLEET_POLL_SECONDS", "300")) || 300,
  /** JSON map of Fleet owner id -> email */
  fleetOwnerEmailMap: get("FLEET_OWNER_EMAIL_MAP", "{}"),

  /**
   * Comma-separated emails allowed for live reminder sends (mark-sent dryRun=false).
   * Empty = no server-side allowlist. Queue in Admin is the send confirmation.
   */
  reminderLiveAllowlist: get("REMINDER_LIVE_ALLOWLIST", ""),

  /** Slack bot token (xoxb-…) for sending reminder DMs when Admin queues. */
  slackBotToken: get("SLACK_BOT_TOKEN", ""),

  /**
   * When true, POST /reminders/queue sends Slack DMs immediately (queue = confirm).
   * Requires SLACK_BOT_TOKEN. Default on.
   */
  reminderAutoSend: ["1", "true", "yes", "on"].includes(
    get("REMINDER_AUTO_SEND", "true").toLowerCase(),
  ),

  /**
   * When true, the leaderboard API only returns permanent holders (no checkout track).
   */
  leaderboardPermanentOnly: ["1", "true", "yes", "on"].includes(
    get("LEADERBOARD_PERMANENT_ONLY", "false").toLowerCase(),
  ),

  /**
   * Trust Harbor/SSO identity headers (x-harbor-user-email). On by default in production
   * so Harbor SSO maps to the matching participant/admin row. Leave off locally.
   */
  harborTrustIdentity: ["1", "true", "yes", "on"].includes(
    get(
      "HARBOR_TRUST_IDENTITY",
      process.env.NODE_ENV === "production" ? "true" : "false",
    ).toLowerCase(),
  ),
  /**
   * When this matches ALL_TIME_RESET_VALUE, the next boot sets the live database
   * aside and scores a fresh one from the all-time snapshot. A database that
   * already recorded the value is left alone.
   */
  allTimeReset: get("FIELDCAM_ALL_TIME_RESET", ""),

  /**
   * Laptop only: treat this email as signed in (no app password). Ignored when
   * HARBOR_TRUST_IDENTITY is on. Empty in production.
   */
  localDevIdentity: get(
    "LOCAL_DEV_IDENTITY",
    process.env.NODE_ENV === "production" ? "" : "alice@northline.example",
  ).toLowerCase(),

  /** Laptop poller. Harbor scores from the committed Jira triage file instead. */
  jiraEmail: get("JIRA_EMAIL", ""),
  jiraApiToken: get("JIRA_API_TOKEN", ""),
  jiraSite: get("JIRA_SITE", "issues.northline.example"),
  /** Scoped tokens return an empty issue list from the site URL. The gateway is the one that searches. */
  jiraCloudId: get("JIRA_CLOUD_ID", "00000000-0000-4000-8000-000000000001"),
  jiraEpic: get("JIRA_SELFHOST_EPIC", "FC-100"),
  /** How often the server asks Jira which epic bugs moved NEEDS TRIAGE → Triaged. */
  jiraPollSeconds: Number(get("JIRA_POLL_SECONDS", "900")) || 900,

  /**
   * GHA-committed Splunk activity CSV. Harbor imports this on boot. Never a Splunk URL.
   */
  splunkSnapshotPath: path.isAbsolute(get("SPLUNK_SNAPSHOT_PATH"))
    ? get("SPLUNK_SNAPSHOT_PATH")
    : path.join(
        SERVER_ROOT,
        "..",
        get("SPLUNK_SNAPSHOT_PATH", "data/splunk-activity.csv") || "data/splunk-activity.csv",
      ),

  /** Laptop gather: public/API-key read of the mechanical tracker. */
  googleApiKey: get("GOOGLE_API_KEY", ""),
  mechanicalSheetId: get(
    "MECHANICAL_SHEET_ID",
    "",
  ),
};
