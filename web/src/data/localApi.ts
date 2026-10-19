/**
 * Local Node/SQLite API client.
 * Set VITE_LOCAL_API_URL (e.g. http://localhost:8787) or use Vite proxy /local-api.
 */
import type { StatsWindowKey } from "../config/statsWindows";

export interface LocalScoreBreakdown {
  metricKey: string;
  label: string;
  raw: number;
  points: number;
  enabled: boolean;
  displayOrder: number;
}

export interface LocalLeaderboardEntry {
  rank: number;
  name: string;
  cameraId: string | null;
  cameraIds?: string[];
  emailHash: string;
  photoUrl?: string | null;
  totalPoints: number;
  breakdown: LocalScoreBreakdown[];
}

/** Resolve a leaderboard/participant photoUrl (often `/api/avatars/...`) against the API base. */
export function resolveLocalPhotoUrl(photoUrl: string | null | undefined): string | undefined {
  if (!photoUrl?.trim()) return undefined;
  const u = photoUrl.trim();
  if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("data:")) return u;
  const base = apiBase().replace(/\/$/, "");
  if (u.startsWith("/")) return `${base}${u}`;
  return `${base}/${u}`;
}

export interface LocalFreshness {
  hasImport: boolean;
  exportTimeUtc: string | null;
  committedAt: string | null;
  ageHours: number | null;
  staleForReminders: boolean;
  batchId: string | null;
}

export interface LocalLeaderboardResponse {
  weekStart: string;
  weekEnd: string;
  openWeekStart?: string;
  availableWeeks?: string[];
  scoringProfile: {
    profileId: string;
    version: number;
    name: string;
    metrics: Array<{ metricKey: string; label: string; displayOrder: number }>;
  };
  freshness: LocalFreshness;
  track?: "permanent" | "checkout" | "overall" | "all";
  scope?: "all-time";
  period?: "weekly" | "biweekly" | "all-time";
  entries: LocalLeaderboardEntry[];
}

const LOCAL_API_URL = (import.meta.env.VITE_LOCAL_API_URL as string | undefined)?.trim();

export function isLocalApiConfigured(): boolean {
  if (import.meta.env.VITE_STATIC_LEADERBOARD === "true") return false;
  return Boolean(LOCAL_API_URL) || import.meta.env.DEV || import.meta.env.PROD;
}

/** Browser base: Vite proxy in dev; same-origin `/api` on Harbor; absolute URL when set. */
function apiBase(): string {
  if (LOCAL_API_URL) {
    if (import.meta.env.DEV) {
      // Prefer same-origin proxy to avoid CORS surprises when pointing at localhost.
      try {
        const u = new URL(LOCAL_API_URL);
        if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
          return "/local-api";
        }
      } catch {
        // fall through
      }
      return LOCAL_API_URL.replace(/\/$/, "");
    }
    return LOCAL_API_URL.replace(/\/$/, "");
  }
  if (import.meta.env.DEV) return "/local-api";
  return "";
}

async function parseJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  if (res.status === 413) {
    throw new Error(
      label.toLowerCase().includes("photo")
        ? "That image is too large to upload. Choose a photo smaller than 1MB."
        : `${label} was too large. Try a smaller file.`,
    );
  }
  let data: T & { error?: string; ok?: boolean };
  try {
    data = JSON.parse(text) as T & { error?: string; ok?: boolean };
  } catch {
    throw new Error(`${label} returned non-JSON (${res.status})`);
  }
  if (!res.ok || data.error) {
    throw new Error(data.error || `${label} failed: ${res.status}`);
  }
  return data;
}

export async function fetchLocalLeaderboard(
  weekStart?: string,
  track?: "permanent" | "checkout" | "overall",
): Promise<LocalLeaderboardResponse> {
  const params = new URLSearchParams();
  if (weekStart) params.set("weekStart", weekStart);
  if (track) params.set("track", track);
  const q = params.toString() ? `?${params}` : "";
  const res = await fetch(`${apiBase()}/api/leaderboard${q}`);
  return parseJson<LocalLeaderboardResponse>(res, "Local leaderboard");
}

export interface LocalRosterSummary {
  ok: boolean;
  enrolled: number;
  active: number;
}

export async function fetchLocalRosterSummary(): Promise<LocalRosterSummary> {
  const res = await fetch(`${apiBase()}/api/roster/summary`);
  return parseJson<LocalRosterSummary>(res, "Roster summary");
}

export interface LocalSeasonStatus {
  ok: boolean;
  startsAtUtc: string;
  started: boolean;
  startedAtUtc: string | null;
}

export async function fetchLocalSeason(): Promise<LocalSeasonStatus> {
  const res = await fetch(`${apiBase()}/api/season`);
  return parseJson<LocalSeasonStatus>(res, "Season status");
}

export async function fetchLocalFreshness(): Promise<LocalFreshness> {
  const res = await fetch(`${apiBase()}/api/freshness`);
  return parseJson<LocalFreshness>(res, "Local freshness");
}

export interface LocalStatTrend {
  last: number | null;
  prior: number | null;
  delta: number | null;
  direction: "up" | "down" | "flat" | "unknown";
  tone: "better" | "worse" | "neutral";
}

export interface LocalWindowedStats {
  totalRecordings: number;
  recordingsOverThreshold: number;
  minThresholdSeconds: number;
  recordingsUnderThreshold: number;
  totalDurationSeconds: number;
  totalDurationHours: number;
  avgDurationSeconds: number;
  distinctParticipants: number;
  distinctCameras: number;
  totalUploads: number;
  totalLivestreams: number;
  totalReports: number;
  empty: boolean;
  reliability: LocalReliabilityMetric[];
}

export interface LocalOverallStats {
  totalRecordings: number;
  recordingsOverThreshold: number;
  minThresholdSeconds: number;
  recordingsUnderThreshold: number;
  totalDurationSeconds: number;
  totalDurationHours: number;
  avgDurationSeconds: number;
  distinctParticipants: number;
  distinctCameras: number;
  totalUploads: number;
  totalLivestreams: number;
  totalReports: number;
  /** Success rates for the operations the export reports an outcome for. */
  reliability?: LocalReliabilityMetric[];
  /** Per-camera failure counts, most failures first. */
  deviceFailures?: LocalDeviceFailureRow[];
  /** Upload success split by network path. */
  uploadTransports?: LocalTransportRow[];
  /** Per-DVR-state power draw and the shift length derived from it. */
  runtime?: LocalRuntimeEstimate;
  window?: LocalStatsWindow;
  freshness?: LocalFreshness;
  /** The selected window. Equals the all-time figures when the window is all-time. */
  current?: LocalWindowedStats;
  /** The equal-length span before it, or null when the window is all-time. */
  previous?: LocalWindowedStats | null;
  volumeTrends?: Record<string, LocalStatTrend>;
}

export interface LocalPowerState {
  key: "buffering" | "recording" | "livestreaming";
  label: string;
  /** Median AvgPower in mW, null until samples arrive. */
  medianMw: number | null;
  samples: number;
}

export interface LocalRuntimeEstimate {
  states: LocalPowerState[];
  shiftHours: number | null;
  shiftHoursLow: number | null;
  shiftHoursHigh: number | null;
  targetHours: number;
  batteryMah: number;
  nominalVolts: number;
  recordingHours: number;
  computable: boolean;
  offProfileSamples: number;
  offProfileConfigs: string[];
  allTimeSamples: number;
}

export interface LocalStatsWindow {
  key: StatsWindowKey;
  label: string;
  short: string;
  phrase: string;
  /** Null for all-time, which has no earlier span to compare against. */
  prior: string | null;
  /** Null for all-time, which has no lower bound. */
  hours: number | null;
  /** For all-time, the earliest activity on record — null if there is none yet. */
  sinceUtc: string | null;
  untilUtc: string;
  asOfUtc: string;
}

/** `window` picks the span the tiles, reliability, and tables are read over. */
export async function fetchLocalStats(window?: StatsWindowKey): Promise<LocalOverallStats> {
  const q = window ? `?window=${encodeURIComponent(window)}` : "";
  const res = await fetch(`${apiBase()}/api/stats${q}`);
  return parseJson<LocalOverallStats>(res, "Local stats");
}

export interface LocalReliabilityMetric {
  key: string;
  label: string;
  successes: number;
  failures: number;
  total: number;
  rate: number | null;
  ci95Lower: number | null;
  ci95Upper: number | null;
  trend?: LocalStatTrend;
}

export interface LocalDeviceFailureRow {
  cameraId: string;
  holderName: string | null;
  holderEmail: string | null;
  uploadFailures: number;
  uploadTotal: number;
  recordingFailures: number;
  recordingTotal: number;
  uploadRate: number | null;
  ci95Lower: number | null;
  ci95Upper: number | null;
  uploadFailuresLast24h?: number;
  recordingFailuresLast24h?: number;
}

export interface LocalTransportRow {
  transport: string;
  label: string;
  successes: number;
  failures: number;
  total: number;
  rate: number | null;
  ci95Lower: number | null;
  ci95Upper: number | null;
}

export interface LocalWeeklyStatsRow {
  weekStart: string;
  recordings: number;
  recordingHours: number;
  participants: number;
  uploads: number;
  reports: number;
}

/** Per-week totals for the Overall Statistics trend charts. Weeks with no activity are absent. */
export async function fetchLocalWeeklyStats(): Promise<LocalWeeklyStatsRow[]> {
  const res = await fetch(`${apiBase()}/api/stats/weekly`);
  const data = await parseJson<{ weeks: LocalWeeklyStatsRow[] }>(res, "Weekly stats");
  return data.weeks ?? [];
}

export type LocalDeviceHub = "Phoenix" | "Seattle";

export interface LocalDeviceRow {
  cameraId: string;
  label: string | null;
  hub: LocalDeviceHub;
  status: "Available" | "Checked out";
  holderEmail: string | null;
  holderName: string | null;
  checkoutAtUtc: string | null;
  source: string | null;
  lastUsedDate: string | null;
}

export interface LocalDevicesResponse {
  ok: boolean;
  devices: LocalDeviceRow[];
  summary: {
    total: number;
    available: number;
    checkedOut: number;
    byHub: Record<
      LocalDeviceHub,
      { total: number; available: number; checkedOut: number }
    >;
  };
}

export async function fetchLocalDevices(): Promise<LocalDevicesResponse> {
  const res = await fetch(`${apiBase()}/api/devices`);
  return parseJson<LocalDevicesResponse>(res, "Local devices");
}

export async function localQrCheckout(
  email: string,
  cameraId: string,
): Promise<{ provisional: boolean; cameraId: string; message?: string }> {
  const res = await fetch(`${apiBase()}/api/qr/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, cameraId }),
  });
  return parseJson(res, "QR checkout");
}

export async function localQrReturn(
  cameraId: string,
  email?: string,
): Promise<{ returned: boolean; closed: number; message?: string }> {
  const res = await fetch(`${apiBase()}/api/qr/return`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cameraId, email }),
  });
  return parseJson(res, "QR return");
}

export async function localParticipantSignup(input: {
  email: string;
  name: string;
  password: string;
  registration?: Record<string, unknown>;
}): Promise<{ email: string; name: string; signupStatus: "pending" }> {
  const res = await fetch(`${apiBase()}/api/participant/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJson(res, "Participant signup");
}

export async function localListParticipants(
  token: string,
  status: "pending" | "approved" | "rejected" | "all" = "pending",
) {
  const res = await fetch(`${apiBase()}/api/admin/participants?status=${encodeURIComponent(status)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson<{
    participants: Array<{
      email: string;
      name: string;
      hub: string;
      signupStatus: string;
      hasPassword: boolean;
      enrolledAt: string;
      updatedAt: string;
      registration: {
        roleDepartment?: string;
        location?: string;
        expectedHoursPerWeek?: string;
        dailyFeatures?: string[];
      } | null;
    }>;
  }>(res, "Participants");
}

export async function localSetParticipantSignupStatus(
  token: string,
  email: string,
  status: "pending" | "approved" | "rejected",
) {
  const res = await fetch(`${apiBase()}/api/admin/participants/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ email, status }),
  });
  return parseJson<{ email: string; signupStatus: string }>(res, "Signup status");
}

export interface RemoveParticipantsResult {
  dryRun: boolean;
  emails: string[];
  removedParticipants: number;
  removedActivityEvents: number;
  removedAssignments: number;
  weeksRecomputed: string[];
}

export async function localRemoveParticipants(
  token: string,
  emails: string[],
  dryRun = true,
): Promise<RemoveParticipantsResult> {
  const res = await fetch(`${apiBase()}/api/admin/participants/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ emails, dryRun }),
  });
  return parseJson<RemoveParticipantsResult>(res, "Remove participants");
}

export type BiweeklyTrack = "permanent" | "checkout";

export interface ScoreRowTrack {
  email: string;
  name: string;
  cameraId: string;
  totalPoints: number;
  track: BiweeklyTrack;
  overridden: boolean;
}

export interface LeaderboardTracksResponse {
  ok: boolean;
  rows: ScoreRowTrack[];
  overrides: Array<{
    email: string;
    cameraId: string;
    track: BiweeklyTrack;
    reason: string | null;
  }>;
}

export async function localLeaderboardTracks(token: string): Promise<LeaderboardTracksResponse> {
  const res = await fetch(`${apiBase()}/api/admin/leaderboard/tracks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson<LeaderboardTracksResponse>(res, "Leaderboard tracks");
}

export async function localSetTrackOverride(
  token: string,
  email: string,
  cameraId: string,
  track: BiweeklyTrack | null,
  reason?: string,
): Promise<{ email: string; cameraId: string; track: BiweeklyTrack | null }> {
  const res = await fetch(`${apiBase()}/api/admin/leaderboard/track-override`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ email, cameraId, track, reason }),
  });
  return parseJson(res, "Track override");
}

export interface HipMeResponse {
  ok: boolean;
  identity: { email: string; name: string } | null;
  participant: {
    email: string;
    name: string;
    role: "participant";
    photoUrl?: string | null;
    emailHash?: string;
    signupStatus?: string;
    accessStatus?: string;
  } | null;
  admin: { token: string; expiresAt: string; email: string } | null;
  needsSignup: boolean;
}

export async function localFetchMe(): Promise<HipMeResponse> {
  const token = sessionStorage.getItem("fieldcam_local_admin_token");
  const res = await fetch(`${apiBase()}/api/me`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  return parseJson<HipMeResponse>(res, "Current user");
}

export async function localAdminLogin(
  email: string,
  password: string,
): Promise<{
  token: string;
  expiresAt: string;
  email: string;
  participant?: HipMeResponse["participant"];
}> {
  const res = await fetch(`${apiBase()}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return parseJson(res, "Admin login");
}

export async function localParticipantLogin(
  email: string,
  password: string,
): Promise<{
  email: string;
  name: string;
  role: "participant";
  photoUrl?: string | null;
  emailHash?: string;
  signupStatus?: string;
  accessStatus?: string;
  admin?: { token: string; expiresAt: string; email: string } | null;
}> {
  const res = await fetch(`${apiBase()}/api/participant/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return parseJson(res, "Participant login");
}

export async function localParticipantPhoto(
  email: string,
  password: string,
  photoDataUrl: string,
): Promise<{ email: string; photoUrl: string }> {
  const res = await fetch(`${apiBase()}/api/participant/photo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, photoDataUrl }),
  });
  return parseJson(res, "Participant photo");
}

export async function localParticipantDisplayName(
  email: string,
  password: string,
  displayName: string,
): Promise<{ email: string; name: string }> {
  const res = await fetch(`${apiBase()}/api/participant/display-name`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName }),
  });
  return parseJson(res, "Participant display name");
}

function authHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

export async function localImportBegin(
  token: string,
  exportTimeUtc: string,
  exportTimezone: string,
): Promise<{ batchId: string }> {
  const res = await fetch(`${apiBase()}/api/admin/import/begin`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ exportTimeUtc, exportTimezone }),
  });
  return parseJson(res, "Import begin");
}

export async function localImportUpload(
  token: string,
  batchId: string,
  splunkCsv: string,
  fleetCsv?: string,
): Promise<{
  splunkRows: number;
  fleetRows: number;
  fleetOptional?: boolean;
  splunkMapping: unknown;
  fleetMapping: unknown;
}> {
  const res = await fetch(`${apiBase()}/api/admin/import/upload`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ batchId, splunkCsv, fleetCsv: fleetCsv || "" }),
  });
  return parseJson(res, "Import upload");
}

export async function localFleetStatus(token: string) {
  const res = await fetch(`${apiBase()}/api/admin/fleet/status`, {
    headers: authHeaders(token),
  });
  return parseJson<{
    enabled: boolean;
    mode: string;
    configured: boolean;
    pollSeconds: number;
    modelFilter: string | null;
    lastSyncAt: string | null;
    lastResult: Record<string, unknown> | null;
  }>(res, "Fleet status");
}

export async function localFleetSync(token: string) {
  const res = await fetch(`${apiBase()}/api/admin/fleet/sync`, {
    method: "POST",
    headers: authHeaders(token),
    body: "{}",
  });
  return parseJson<{ result: Record<string, unknown> }>(res, "Fleet sync");
}

export async function localDownloadAssignmentsCsv(token: string): Promise<{ rows: number; filename: string }> {
  const res = await fetch(`${apiBase()}/api/admin/assignments/export`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    let message = `Assignment export failed (${res.status})`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (text.includes("Cannot GET")) {
        message = "API needs a restart so the assignment export route is loaded.";
      }
    }
    throw new Error(message);
  }
  const headerName = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1];
  const filename = headerName || `fieldcam-assignments-${new Date().toISOString().slice(0, 10)}.csv`;
  const rows = Math.max(0, text.trim().split(/\r?\n/).filter(Boolean).length - 1);
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { rows, filename };
}

export async function localFleetManualOwnership(
  token: string,
  cameraId: string,
  email: string | null,
) {
  const res = await fetch(`${apiBase()}/api/admin/fleet/manual-ownership`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ cameraId, email }),
  });
  return parseJson<{ result: Record<string, unknown> }>(res, "Manual ownership");
}

export interface LocalScoreDelta {
  email: string;
  name: string;
  beforePoints: number;
  afterPoints: number;
  deltaPoints: number;
  beforeRank: number | null;
  afterRank: number | null;
}

export async function localImportPreview(
  token: string,
  batchId: string,
): Promise<{
  batchId?: string;
  acceptedActivity: number;
  rejectedActivity: number;
  quarantinedActivity: number;
  acceptedAssignments: number;
  rejectedAssignments: number;
  acceptedInventory?: number;
  closedStaleAssignments?: number;
  exportTimeUtc: string | null;
  freshness: LocalFreshness;
  quarantineSample: Array<{
    eventId: string;
    cameraId: string;
    eventTimeUtc: string;
    eventType: string;
    reason: string;
  }>;
  errors: Array<{ sourceKind: string; rowNumber: number; severity: string; message: string }>;
  scoreDeltaPreview: {
    participantsAffected: number;
    weekStart: string;
    deltas: LocalScoreDelta[];
  };
}> {
  const res = await fetch(`${apiBase()}/api/admin/import/preview`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ batchId }),
  });
  return parseJson(res, "Import preview");
}

export async function localListQuarantine(token: string): Promise<{
  items: Array<{
    eventId: string;
    eventTimeUtc: string;
    cameraId: string;
    eventType: string;
    reason: string;
    batchId: string | null;
    createdAt: string;
  }>;
}> {
  const res = await fetch(`${apiBase()}/api/admin/quarantine`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res, "Quarantine list");
}

export async function localListReports(
  token: string,
  status?: string,
): Promise<{
  reports: Array<{
    reportId: string;
    email: string;
    reportedAtUtc: string;
    status: string;
    slackMessageUrl: string | null;
    text?: string | null;
    createdAt?: string | null;
    createdBy?: string | null;
    decidedAtUtc?: string | null;
    decidedBy?: string | null;
  }>;
}> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await fetch(`${apiBase()}/api/admin/reports${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res, "Reports list");
}

export async function localCreateReport(
  token: string,
  input: {
    email: string;
    text?: string;
    slackMessageUrl?: string;
    reportedAtUtc?: string;
    approve?: boolean;
  },
): Promise<{
  reportId: string;
  email: string;
  status: "approved" | "pending";
  reportedAtUtc: string;
  weekStart: string;
}> {
  const res = await fetch(`${apiBase()}/api/admin/reports/create`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(input),
  });
  return parseJson(res, "Create report");
}

export async function localSetReportStatus(
  token: string,
  reportId: string,
  status: "approved" | "rejected",
  reason?: string,
) {
  const res = await fetch(`${apiBase()}/api/admin/reports/status`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ reportId, status, reason }),
  });
  return parseJson(res, "Report status");
}

export async function localIntakeReports(
  token: string,
  input: {
    reports?: Array<{
      email: string;
      slackMessageUrl?: string;
      reportedAtUtc?: string;
      reportedAt?: string;
      text?: string;
    }>;
    csv?: string;
    dryRun?: boolean;
  },
): Promise<{
  dryRun: boolean;
  total: number;
  wouldInsert: number;
  skippedDuplicate: number;
  skippedUnknownEmail: number;
  skippedNoUrl: number;
  inserted: number;
  /** Rows that threw on write. The rest of the batch still landed. */
  failed: number;
  rows: Array<{ email: string; slackMessageUrl: string; action: string; error?: string }>;
}> {
  const res = await fetch(`${apiBase()}/api/admin/reports/intake`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      reports: input.reports,
      csv: input.csv,
      dryRun: input.dryRun ?? true,
    }),
  });
  return parseJson(res, "Reports intake");
}

export async function localImportCommit(
  token: string,
  batchId: string,
): Promise<{
  scores?: { count: number; weekStart: string };
  eligibilityCount?: number;
  status?: string;
  batchId?: string;
}> {
  const res = await fetch(`${apiBase()}/api/admin/import/commit`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ batchId }),
  });
  return parseJson(res, "Import commit");
}

export async function localRemindersPreview(token: string): Promise<{
  blocked: boolean;
  blockReason: string | null;
  freshness: LocalFreshness;
  candidates: Array<{
    email: string;
    name: string;
    cameraId: string | null;
    kind: string;
    reason: string;
    text: string;
    /** Last valid recording, or null when they have never recorded since checkout. */
    lastRecordingAt: string | null;
    assignedAt: string | null;
    /** Working hours idle — the unit eligibility is measured in. */
    idleWorkingHours: number;
  }>;
}> {
  const res = await fetch(`${apiBase()}/api/admin/reminders/preview`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(res, "Reminders preview");
}

export async function localRemindersQueue(
  token: string,
  emails: string[],
): Promise<{ queued: number; ids: string[]; sent: number; failed: number; autoSend: boolean }> {
  const res = await fetch(`${apiBase()}/api/admin/reminders/queue`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ emails }),
  });
  return parseJson(res, "Reminders queue");
}

export async function localRemindersPending(
  token: string,
  status: "queued" | "all" = "queued",
): Promise<{
  nudges: Array<{
    id: string;
    email: string;
    name: string;
    cameraId: string | null;
    kind: string;
    text: string;
    status: string;
    queuedAt: string | null;
    sentAt: string | null;
    error: string | null;
  }>;
}> {
  const res = await fetch(
    `${apiBase()}/api/admin/reminders/pending?status=${encodeURIComponent(status)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return parseJson(res, "Reminders pending");
}

export async function localRemindersCancel(
  token: string,
  ids: string[],
): Promise<{ cancelled: number }> {
  const res = await fetch(`${apiBase()}/api/admin/reminders/cancel`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ ids }),
  });
  return parseJson(res, "Reminders cancel");
}

export async function localRemindersMarkSent(
  token: string,
  results: Array<{ id: string; status: "sent" | "failed"; error?: string }>,
  dryRun = true,
): Promise<{ dryRun: boolean; count: number; allowlist: string[] | null }> {
  const res = await fetch(`${apiBase()}/api/admin/reminders/mark-sent`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ results, dryRun }),
  });
  return parseJson(res, "Reminders mark-sent");
}

export interface LocalScoringRule {
  metricKey: string;
  label: string;
  pointsPerUnit: number;
  enabled: boolean;
  cap: number | null;
  minimum: number | null;
  displayOrder: number;
  aggregation: string;
  paramsJson: string;
}

export async function localScoringActive(): Promise<{
  profileId: string;
  version: number;
  name: string;
  metrics: Array<{ metricKey: string; label: string; pointsPerUnit: number }>;
  rules: LocalScoringRule[];
}> {
  const res = await fetch(`${apiBase()}/api/scoring/active`);
  return parseJson(res, "Scoring profile");
}

export async function localCopyScoringDraft(
  token: string,
  name?: string,
): Promise<{
  profileId: string;
  version: number;
  rules: Array<{
    metricKey: string;
    label: string;
    pointsPerUnit: number;
    enabled: boolean;
    displayOrder: number;
    aggregation: string;
    minimum: number | null;
    cap: number | null;
    paramsJson: string;
  }>;
}> {
  const res = await fetch(`${apiBase()}/api/admin/scoring/draft`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ name }),
  });
  return parseJson(res, "Scoring draft");
}

export async function localUpdateScoringDraft(
  token: string,
  body: {
    profileId: string;
    version: number;
    rules: Array<{
      metricKey: string;
      label: string;
      pointsPerUnit: number;
      enabled: boolean;
      displayOrder: number;
      aggregation: string;
      minimum: number | null;
      cap: number | null;
      paramsJson: string;
    }>;
  },
) {
  const res = await fetch(`${apiBase()}/api/admin/scoring/draft/update`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  return parseJson(res, "Scoring draft update");
}

export async function localValidateScoringDraft(
  token: string,
  profileId: string,
  version: number,
): Promise<{ errors: string[]; nextMonday: string }> {
  const res = await fetch(`${apiBase()}/api/admin/scoring/validate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ profileId, version }),
  });
  return parseJson(res, "Scoring validate");
}

export async function localPreviewScoringDraft(
  token: string,
  profileId: string,
  version: number,
): Promise<{
  weekStart: string;
  nextMonday: string;
  unavailableMetrics: string[];
  deltas: LocalScoreDelta[];
  projectedTop: Array<{ rank: number; name: string; cameraId?: string | null; totalPoints: number }>;
}> {
  const res = await fetch(`${apiBase()}/api/admin/scoring/preview`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ profileId, version }),
  });
  return parseJson(res, "Scoring preview");
}

export async function localScheduleScoringDraft(
  token: string,
  profileId: string,
  version: number,
  effectiveWeekStart: string,
  reason?: string,
) {
  const res = await fetch(`${apiBase()}/api/admin/scoring/schedule`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ profileId, version, effectiveWeekStart, reason }),
  });
  return parseJson(res, "Scoring schedule");
}

export async function localEmergencyActivateScoring(
  token: string,
  profileId: string,
  version: number,
  reason: string,
) {
  const res = await fetch(`${apiBase()}/api/admin/scoring/emergency`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ profileId, version, reason }),
  });
  return parseJson(res, "Scoring emergency");
}

export async function localRecomputeScores(token: string, weekStart?: string) {
  const res = await fetch(`${apiBase()}/api/admin/scores/recompute`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ weekStart }),
  });
  return parseJson<{ scores: { weekStart: string; count: number; profileId: string; version: number } }>(
    res,
    "Score recompute",
  );
}

export interface ResetScoresResult {
  dryRun: boolean;
  scope: "period" | "all";
  weekStart: string | null;
  weeksRecomputed: string[];
  cleared: {
    weeklyScores: number;
    dailyActivity: number;
    activityEvents: number;
    quarantinedActivity: number;
    scoreAdjustments: number;
    challengeAwards: number;
    reports: number;
  };
}

export async function localResetScores(
  token: string,
  opts: {
    weekStart?: string;
    clearActivity?: boolean;
    clearManual?: boolean;
    clearReports?: boolean;
    dryRun?: boolean;
  },
): Promise<ResetScoresResult> {
  const res = await fetch(`${apiBase()}/api/admin/scores/reset`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(opts),
  });
  return parseJson<ResetScoresResult>(res, "Reset scores");
}

export async function localSnapshotWeek(token: string, reason?: string) {
  const res = await fetch(`${apiBase()}/api/admin/snapshots`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ reason }),
  });
  return parseJson(res, "Snapshot week");
}

export interface LocalChallengeAward {
  awardId: string;
  email: string;
  name: string;
  cameraId: string | null;
  weekStart: string;
  points: number;
  title: string;
  notes: string | null;
  awardedBy: string;
  createdAt: string;
}

export async function localListChallenges(token: string, weekStart?: string) {
  const q = weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : "";
  const res = await fetch(`${apiBase()}/api/admin/challenges${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson<{ awards: LocalChallengeAward[] }>(res, "Challenge awards");
}

export async function localAwardChallenge(
  token: string,
  body: {
    email: string;
    points: number;
    title: string;
    notes?: string;
    cameraId?: string;
    weekStart?: string;
  },
) {
  const res = await fetch(`${apiBase()}/api/admin/challenges`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  return parseJson<{ award: LocalChallengeAward; scores: { count: number; weekStart: string } }>(
    res,
    "Award challenge",
  );
}

export async function localRevokeChallenge(token: string, awardId: string) {
  const res = await fetch(`${apiBase()}/api/admin/challenges/revoke`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ awardId }),
  });
  return parseJson<{ awardId: string; weekStart: string }>(res, "Revoke challenge");
}

export interface LocalScorePerson {
  email: string;
  name: string;
  totalPoints: number;
  rank: number | null;
}

export interface LocalScoreAdjustment {
  adjustmentId: string;
  email: string;
  name: string;
  weekStart: string;
  deltaPoints: number;
  reason: string;
  setTo: number | null;
  awardedBy: string;
  createdAt: string;
}

export async function localScorePeople(token: string, weekStart?: string) {
  const q = weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : "";
  const res = await fetch(`${apiBase()}/api/admin/scores/people${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson<{ weekStart: string; people: LocalScorePerson[] }>(res, "Score people");
}

export async function localListScoreAdjustments(token: string, weekStart?: string) {
  const q = weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : "";
  const res = await fetch(`${apiBase()}/api/admin/scores/adjustments${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson<{ adjustments: LocalScoreAdjustment[] }>(res, "Score adjustments");
}

export async function localAdjustScore(
  token: string,
  body: { email: string; reason: string; delta?: number; setTotal?: number; weekStart?: string },
) {
  const res = await fetch(`${apiBase()}/api/admin/scores/adjust`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  return parseJson<{
    adjustment: LocalScoreAdjustment;
    beforePoints: number;
    afterPoints: number;
  }>(res, "Adjust score");
}

export async function localRevokeScoreAdjustment(token: string, adjustmentId: string) {
  const res = await fetch(`${apiBase()}/api/admin/scores/adjustments/revoke`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ adjustmentId }),
  });
  return parseJson<{ adjustmentId: string; weekStart: string }>(res, "Revoke score adjustment");
}
