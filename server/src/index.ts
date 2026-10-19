import { fork } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { ENV } from "./env.js";
import { audit, getDb } from "./db.js";
import {
  issueAdminSession,
  loadParticipantSession,
  loginAdmin,
  loginParticipant,
  logoutAdmin,
  requireAdmin,
} from "./auth.js";
import { harborEmailMatches, harborIdentityFrom } from "./harborIdentity.js";
import { isAdminEmail } from "./config/adminEmails.js";

function auditSafe(actor: string, action: string, entityId: string) {
  audit(actor, action, { entityType: "weekly_scores", entityId });
}
import {
  getRosterSummary,
  listParticipants,
  setParticipantSignupStatus,
  signupParticipant,
  updateParticipantDisplayName,
} from "./participants.js";
import {
  purgeDemoData,
  purgeNonPermanentParticipants,
  removeParticipants,
  seedDemoData,
} from "./seed.js";
import {
  correctWeekScores,
  getLeaderboard,
  getImportFreshness,
  getStatsDashboard,
  parseStatsWindow,
  getWeeklyStats,
  listSnapshots,
  recomputeWeekScores,
  resetScores,
  snapshotOpenWeek,
} from "./scoring/engine.js";
import { parseLeaderboardTrack } from "./config/permanentHolders.js";
import { getSeasonStatus, startSeasonIfDue } from "./config/season.js";
import {
  listScoreRowTracks,
  listTrackOverrides,
  setTrackOverride,
} from "./config/trackOverrides.js";
import { awardChallenge, listChallengeAwards, revokeChallenge } from "./challenges.js";
import {
  applyScoreAdjustment,
  listScoreAdjustments,
  listScorePeople,
  revokeScoreAdjustment,
} from "./scoreAdjustments.js";
import {
  copyActiveToDraft,
  emergencyActivate,
  getActiveProfilePublic,
  getDraft,
  scheduleDraft,
  updateDraft,
} from "./scoring/profiles.js";
import { previewDraftScores, validateDraft } from "./scoring/preview.js";
import {
  beginImport,
  uploadImportFiles,
  previewImport,
  commitImport,
  listQuarantinedActivity,
} from "./import/pipeline.js";
import { listMappingProfiles, saveMappingProfile } from "./import/mapping.js";
import {
  cancelQueuedNudges,
  listPendingNudges,
  markNudgeSendResults,
  previewReminders,
  queueReminders,
} from "./reminders.js";
import { createReport, intakeReports, listReports } from "./reports.js";
import { nextMondayWeekStartUtcISO, weekStartUtcISO } from "./week.js";
import type { MetricKey, ScoringRule } from "./types.js";
import {
  applyManualOwnership,
  backfillOpenAssignmentStarts,
  getEvidenceSyncStatus,
  syncFleetOwnership,
} from "./fleet/sync.js";
import { startEvidencePoller } from "./fleet/poller.js";
import { startJiraTriagePoller } from "./jira/poller.js";
import { recordQrCheckout, recordQrReturn } from "./fleet/qr.js";
import { listDeviceInventory } from "./devices.js";
import { exportAssignmentCsv } from "./assignmentsExport.js";
import { resolveAvatarFile, updateParticipantPhoto } from "./profilePhoto.js";

function tokenFrom(req: express.Request): string | undefined {
  const header = req.header("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const body = req.body as { token?: string; sessionToken?: string } | undefined;
  return body?.token || body?.sessionToken || (req.query.token as string | undefined);
}

function fail(res: express.Response, err: unknown, status = 400) {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    message === "Unauthorized" || message === "Session expired"
      ? 401
      : status;
  res.status(code).json({ ok: false, error: message });
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));
app.use(express.text({ type: ["text/*", "text/csv"], limit: "25mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// The snapshot import runs in another process. Until it exits, API routes stay off this
// thread so a leaderboard read cannot sit on the database lock and stall /health.
let dataStoreReady = false;
app.use((req, res, next) => {
  if (dataStoreReady || req.path === "/health") {
    next();
    return;
  }
  res.status(503).json({ ok: false, error: "starting" });
});

/** Public leaderboard */
/**
 * Read a date-bearing query parameter, tolerating a still-encoded value.
 *
 * On Harbor the leaderboard's weekStart arrived as "2026-08-31T07%3A00%3A00.000Z" — the colons never
 * decoded. URLSearchParams correctly sends %3A, something in front of the app re-encodes it to
 * %253A, and Express's one decode leaves %3A behind. Date.parse rejects that, which is why every
 * closed-period click returned a 500 there and none reproduced locally, where Vite proxies
 * straight through.
 *
 * We do not control what sits in front of the container, so decode defensively: use the value if
 * it already parses, otherwise try one more decode. Anything that still fails to parse is a
 * genuinely bad request and the caller is told so.
 */
function dateParam(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!Number.isNaN(Date.parse(raw))) return raw;
  try {
    const decoded = decodeURIComponent(raw);
    if (!Number.isNaN(Date.parse(decoded))) return decoded;
  } catch {
    // Malformed percent-escapes — fall through and let the caller reject it.
  }
  return raw;
}

app.get("/api/leaderboard", (req, res) => {
  const rawWeek = dateParam(req.query.weekStart as string | undefined);
  const track = req.query.track;
  try {
    // Opens the season on its own at kickoff — no deploy or admin needed at midnight.
    startSeasonIfDue();
    // A weekStart the date maths cannot parse used to reach biweekStartUtcISO and surface as a
    // bare "Invalid time value" 500 — indistinguishable from a server fault, and it sent two
    // separate investigations chasing the wrong thing. Reject it as the bad request it is.
    if (rawWeek !== undefined && Number.isNaN(Date.parse(rawWeek))) {
      fail(res, new Error(`weekStart is not a valid date: ${JSON.stringify(rawWeek)}`), 400);
      return;
    }
    res.json(getLeaderboard(rawWeek, parseLeaderboardTrack(track)));
  } catch (err) {
    /*
     * Say what was being attempted.
     *
     * Every date helper on this path throws the same opaque "Invalid time value" from deep inside
     * Intl or toISOString, with no indication of which week, track or row caused it. Naming the
     * inputs turns the next occurrence into something diagnosable from the log alone instead of a
     * reproduction hunt.
     */
    const message = err instanceof Error ? err.message : String(err);
    /*
     * Log the stack, not just the message.
     *
     * "Invalid time value" is thrown identically by Intl.DateTimeFormat.format, Date.toISOString
     * and every helper built on them, and the message alone names none of them. Three separate
     * attempts to find one occurrence failed because the trace was never captured anywhere — the
     * response carries a message, the server logged nothing. One line here turns the next
     * occurrence into a file and a line number.
     */
    console.error(
      `Leaderboard failed (track=${String(track ?? "default")} weekStart=${String(rawWeek ?? "default")}): ${message}\n${err instanceof Error ? err.stack : ""}`,
    );
    fail(
      res,
      new Error(
        `${message} (loading leaderboard track=${String(track ?? "default")} weekStart=${String(rawWeek ?? "default")})`,
      ),
      500,
    );
  }
});

/** `?window=24h|7d|14d|all` picks the span the tiles, reliability, and tables are read over. */
app.get("/api/stats", (req, res) => {
  try {
    res.json(getStatsDashboard(new Date(), parseStatsWindow(req.query.window)));
  } catch (err) {
    fail(res, err, 500);
  }
});

/** Per-week totals behind the Overall Statistics trend charts. */
app.get("/api/stats/weekly", (_req, res) => {
  try {
    res.json({ ok: true, weeks: getWeeklyStats() });
  } catch (err) {
    fail(res, err, 500);
  }
});

/** Public roster counts for the landing page. */
app.get("/api/roster/summary", (_req, res) => {
  try {
    res.json({ ok: true, ...getRosterSummary() });
  } catch (err) {
    fail(res, err, 500);
  }
});

/** Countdown target for the landing page, and whether the season has opened yet. */
app.get("/api/season", (_req, res) => {
  try {
    startSeasonIfDue();
    res.json({ ok: true, ...getSeasonStatus() });
  } catch (err) {
    fail(res, err, 500);
  }
});

app.get("/api/freshness", (_req, res) => {
  try {
    res.json(getImportFreshness());
  } catch (err) {
    fail(res, err, 500);
  }
});

app.get("/api/scoring/active", (_req, res) => {
  try {
    res.json(getActiveProfilePublic());
  } catch (err) {
    fail(res, err, 500);
  }
});

app.get("/api/me", async (req, res) => {
  try {
    const identity = harborIdentityFrom(req);
    if (!identity) {
      res.json({ ok: true, identity: null, participant: null, admin: null, needsSignup: false });
      return;
    }

    let participant = null;
    try {
      participant = await loadParticipantSession(identity.email);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("rejected")) {
        res.status(403).json({ ok: false, error: message, identity });
        return;
      }
    }

    const admin = isAdminEmail(identity.email) ? issueAdminSession(identity.email) : null;
    res.json({
      ok: true,
      identity,
      participant,
      admin,
      needsSignup: !participant && !admin,
    });
  } catch (err) {
    fail(res, err, 500);
  }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    const result = loginAdmin(email || "", password || "");
    let participant = null;
    try {
      participant = await loadParticipantSession(result.email);
    } catch {
      participant = null;
    }
    res.json({ ok: true, ...result, participant });
  } catch (err) {
    fail(res, err, 401);
  }
});

app.post("/api/participant/signup", (req, res) => {
  try {
    const { email, name, password, registration } = req.body as {
      email?: string;
      name?: string;
      password?: string;
      registration?: unknown;
    };
    const result = signupParticipant({
      email: email || "",
      name: name || "",
      password: password || "",
      registration,
      skipPassword: Boolean(email && harborEmailMatches(req, email) && !password),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/participant/login", async (req, res) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    const result = await loginParticipant(email || "", password || "");
    const admin = isAdminEmail(result.email) ? issueAdminSession(result.email) : null;
    res.json({ ok: true, ...result, admin });
  } catch (err) {
    fail(res, err, 401);
  }
});

app.post("/api/participant/display-name", async (req, res) => {
  try {
    const { email, password, displayName } = req.body as {
      email?: string;
      password?: string;
      displayName?: string;
    };
    if (!displayName?.trim()) throw new Error("displayName required");
    const viaHarbor = email && harborEmailMatches(req, email) ? await loadParticipantSession(email) : undefined;
    const result = await updateParticipantDisplayName(email || "", password || "", displayName, viaHarbor);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(res, err, msg.includes("Incorrect email or password") ? 401 : 400);
  }
});

app.post("/api/participant/photo", async (req, res) => {
  try {
    const { email, password, photoDataUrl } = req.body as {
      email?: string;
      password?: string;
      photoDataUrl?: string;
    };
    if (!photoDataUrl) throw new Error("photoDataUrl required");
    const viaHarbor = email && harborEmailMatches(req, email) ? await loadParticipantSession(email) : undefined;
    const result = await updateParticipantPhoto(email || "", password || "", photoDataUrl, viaHarbor);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(res, err, msg.includes("Incorrect email or password") ? 401 : 400);
  }
});

app.get("/api/admin/participants", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    const status = String(req.query.status || "pending");
    const allowed = status === "all" || status === "pending" || status === "approved" || status === "rejected";
    if (!allowed) throw new Error("Invalid status filter");
    res.json({ ok: true, participants: listParticipants(status as "all" | "pending" | "approved" | "rejected") });
  } catch (err) {
    fail(res, err, 401);
  }
});

app.post("/api/admin/participants/status", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const { email, status } = req.body as { email?: string; status?: "pending" | "approved" | "rejected" };
    if (!email || !status) throw new Error("email and status required");
    res.json({ ok: true, ...setParticipantSignupStatus(actor, email, status) });
  } catch (err) {
    fail(res, err, 401);
  }
});

/** Public avatar files written by participant photo upload. */
app.get("/api/avatars/:name", (req, res) => {
  try {
    const file = resolveAvatarFile(String(req.params.name || ""));
    if (!file) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }
    res.sendFile(file);
  } catch (err) {
    fail(res, err, 404);
  }
});

app.post("/api/admin/logout", (req, res) => {
  try {
    logoutAdmin(tokenFrom(req));
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/seed", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    // Opt-in only — live mode should not rely on synthetic roster.
    res.json({ ok: true, ...seedDemoData(actor) });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/purge-demo", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    res.json({ ok: true, ...purgeDemoData(actor) });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Remove every participant not on the fixed permanent-holder roster, plus their scores/activity.
 * Defaults to a dry run — pass { "dryRun": false } to actually delete. Irreversible.
 */
app.post("/api/admin/purge-non-permanent", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as { dryRun?: boolean };
    res.json({ ok: true, ...purgeNonPermanentParticipants(actor, { dryRun: body.dryRun }) });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Manual multi-select removal of specific participants (by email) and their scoring/activity
 * data. Defaults to a dry run — pass { "dryRun": false } to actually delete. Irreversible.
 */
app.post("/api/admin/participants/remove", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as { emails?: string[]; dryRun?: boolean };
    res.json({
      ok: true,
      ...removeParticipants(actor, body.emails || [], { dryRun: body.dryRun }),
    });
  } catch (err) {
    fail(res, err);
  }
});

/** Score rows (person + camera) and which board each lands on, for admin overrides. */
app.get("/api/admin/leaderboard/tracks", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    res.json({ ok: true, rows: listScoreRowTracks(), overrides: listTrackOverrides() });
  } catch (err) {
    fail(res, err);
  }
});

/** Move one person's score on one camera to the other board; track: null clears the override. */
app.post("/api/admin/leaderboard/track-override", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as {
      email?: string;
      cameraId?: string;
      track?: "permanent" | "checkout" | null;
      reason?: string;
    };
    res.json({
      ok: true,
      ...setTrackOverride(
        actor,
        body.email || "",
        body.cameraId || "",
        body.track ?? null,
        body.reason,
      ),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/import/begin", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const { exportTimeUtc, exportTimezone, exportWindowHours } = req.body as {
      exportTimeUtc?: string;
      exportTimezone?: string;
      /** Hours of history the CSV covers. Needed for anything wider than the routine daily pull. */
      exportWindowHours?: number;
    };
    res.json({
      ok: true,
      ...beginImport(actor, {
        exportTimeUtc: exportTimeUtc || new Date().toISOString(),
        exportTimezone: exportTimezone || "UTC",
        exportWindowHours,
      }),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/import/upload", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as {
      batchId?: string;
      splunkCsv?: string;
      fleetCsv?: string;
      splunkMapping?: Parameters<typeof uploadImportFiles>[2]["splunkMapping"];
      fleetMapping?: Parameters<typeof uploadImportFiles>[2]["fleetMapping"];
    };
    if (!body.batchId) throw new Error("batchId is required");
    res.json({
      ok: true,
      ...uploadImportFiles(actor, body.batchId, {
        splunkCsv: body.splunkCsv || "",
        fleetCsv: body.fleetCsv || "",
        splunkMapping: body.splunkMapping,
        fleetMapping: body.fleetMapping,
      }),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/import/preview", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const { batchId } = req.body as { batchId?: string };
    if (!batchId) throw new Error("batchId is required");
    res.json({ ok: true, ...previewImport(actor, batchId) });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/import/commit", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const { batchId } = req.body as { batchId?: string };
    if (!batchId) throw new Error("batchId is required");
    res.json({ ok: true, ...commitImport(actor, batchId) });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/mappings", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    res.json({ ok: true, profiles: listMappingProfiles() });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/mappings", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    const body = req.body as {
      id?: string;
      name?: string;
      sourceKind?: "splunk" | "fleet";
      mappings?: Parameters<typeof saveMappingProfile>[3];
    };
    if (!body.id || !body.name || !body.sourceKind || !body.mappings) {
      throw new Error("id, name, sourceKind, and mappings are required");
    }
    res.json({
      ok: true,
      profile: saveMappingProfile(body.id, body.name, body.sourceKind, body.mappings),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/reminders/preview", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    res.json({ ok: true, ...previewReminders() });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/reminders/queue", async (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const { emails } = req.body as { emails?: string[] };
    res.json({ ok: true, ...(await queueReminders(actor, emails || [])) });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/reminders/pending", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    const status = String(req.query.status || "queued") === "all" ? "all" : "queued";
    res.json({ ok: true, nudges: listPendingNudges(status) });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/reminders/mark-sent", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as {
      results?: Array<{ id: string; status: "sent" | "failed"; error?: string }>;
      dryRun?: boolean;
    };
    res.json({
      ok: true,
      ...markNudgeSendResults(actor, body.results || [], { dryRun: Boolean(body.dryRun) }),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/reminders/cancel", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as { ids?: string[] };
    res.json({ ok: true, ...cancelQueuedNudges(actor, body.ids || []) });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/quarantine", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    res.json({ ok: true, items: listQuarantinedActivity(Number(req.query.limit) || 100) });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/reports", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    const status = req.query.status ? String(req.query.status) : undefined;
    res.json({ ok: true, reports: listReports(status) });
  } catch (err) {
    fail(res, err);
  }
});

/** Admin-authored report credited to one person. There is no pending/approval step. */
app.post("/api/admin/reports/create", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as {
      email?: string;
      text?: string;
      slackMessageUrl?: string;
      reportedAtUtc?: string;
    };
    res.json({ ok: true, ...createReport(actor, { email: body.email || "", ...body }) });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/reports/intake", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as {
      reports?: Array<{
        email: string;
        slackMessageUrl?: string;
        reportedAtUtc?: string;
        reportedAt?: string;
        text?: string;
      }>;
      csv?: string;
      dryRun?: boolean;
    };
    res.json({
      ok: true,
      ...intakeReports(actor, {
        reports: body.reports,
        csv: body.csv,
        dryRun: Boolean(body.dryRun),
      }),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/snapshots", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    res.json({ ok: true, snapshots: listSnapshots() });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Reset scores to zero. Dry-run by default; pass { "dryRun": false } to apply.
 * clearActivity defaults on because scores rebuild from activity_events otherwise.
 */
app.post("/api/admin/scores/reset", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as {
      weekStart?: string;
      clearActivity?: boolean;
      clearManual?: boolean;
      clearReports?: boolean;
      dryRun?: boolean;
    };
    res.json({ ok: true, ...resetScores(actor, body) });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/snapshots", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as { weekStart?: string; reason?: string };
    res.json({
      ok: true,
      ...snapshotOpenWeek(actor, body.weekStart, body.reason || "manual_snapshot"),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/scores/correct", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as { weekStart?: string; reason?: string };
    if (!body.weekStart || !body.reason) throw new Error("weekStart and reason required");
    res.json({ ok: true, ...correctWeekScores(actor, body.weekStart, body.reason) });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/scores/people", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    const weekStart = req.query.weekStart ? String(req.query.weekStart) : undefined;
    res.json({ ok: true, ...listScorePeople(weekStart) });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/scores/adjustments", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    const weekStart = req.query.weekStart ? String(req.query.weekStart) : undefined;
    res.json({ ok: true, adjustments: listScoreAdjustments(weekStart) });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/scores/adjust", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as {
      email?: string;
      reason?: string;
      delta?: number;
      setTotal?: number;
      weekStart?: string;
    };
    res.json({
      ok: true,
      ...applyScoreAdjustment(actor, {
        email: body.email || "",
        reason: body.reason || "",
        delta: body.delta,
        setTotal: body.setTotal,
        weekStart: body.weekStart,
      }),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/scores/adjustments/revoke", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as { adjustmentId?: string };
    if (!body.adjustmentId) throw new Error("adjustmentId required");
    res.json({ ok: true, ...revokeScoreAdjustment(actor, body.adjustmentId) });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/challenges", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    const weekStart = req.query.weekStart ? String(req.query.weekStart) : undefined;
    res.json({ ok: true, awards: listChallengeAwards(weekStart) });
  } catch (err) {
    fail(res, err, 401);
  }
});

app.post("/api/admin/challenges", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as {
      email?: string;
      points?: number;
      title?: string;
      notes?: string;
      cameraId?: string;
      weekStart?: string;
    };
    res.json({
      ok: true,
      ...awardChallenge(actor, {
        email: body.email || "",
        points: Number(body.points),
        title: body.title || "",
        notes: body.notes,
        cameraId: body.cameraId,
        weekStart: body.weekStart,
      }),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/challenges/revoke", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const { awardId } = req.body as { awardId?: string };
    if (!awardId) throw new Error("awardId required");
    res.json({ ok: true, ...revokeChallenge(actor, awardId) });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/scores/recompute", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as { weekStart?: string };
    const scores = recomputeWeekScores(body.weekStart);
    auditSafe(actor, "scores.recompute", scores.weekStart);
    res.json({ ok: true, scores });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/scoring/draft", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    const profileId = String(req.query.profileId || "");
    const version = Number(req.query.version || 0);
    res.json({ ok: true, ...getDraft(profileId, version) });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/scoring/draft", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const { name } = req.body as { name?: string };
    res.json({ ok: true, ...copyActiveToDraft(actor, name) });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/scoring/draft/update", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as {
      profileId?: string;
      version?: number;
      name?: string;
      rules?: ScoringRule[];
      tieBreakers?: MetricKey[];
      notes?: string;
    };
    if (!body.profileId || !body.version) throw new Error("profileId and version required");
    res.json({
      ok: true,
      ...updateDraft(actor, body.profileId, body.version, body),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/scoring/schedule", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as {
      profileId?: string;
      version?: number;
      effectiveWeekStart?: string;
      reason?: string;
    };
    if (!body.profileId || !body.version || !body.effectiveWeekStart) {
      throw new Error("profileId, version, and effectiveWeekStart required");
    }
    res.json({
      ok: true,
      ...scheduleDraft(
        actor,
        body.profileId,
        body.version,
        body.effectiveWeekStart,
        body.reason,
      ),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/scoring/emergency", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const body = req.body as {
      profileId?: string;
      version?: number;
      reason?: string;
    };
    if (!body.profileId || !body.version || !body.reason) {
      throw new Error("profileId, version, and reason required");
    }
    const activated = emergencyActivate(actor, body.profileId, body.version, body.reason);
    const scores = recomputeWeekScores(activated.weekStart);
    res.json({ ok: true, ...activated, scores });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/scoring/preview", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    const body = req.body as { profileId?: string; version?: number; weekStart?: string };
    if (!body.profileId || !body.version) throw new Error("profileId and version required");
    res.json({ ok: true, ...previewDraftScores(body.profileId, body.version, body.weekStart) });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/scoring/validate", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    const body = req.body as { profileId?: string; version?: number };
    if (!body.profileId || !body.version) throw new Error("profileId and version required");
    res.json({ ok: true, ...validateDraft(body.profileId, body.version) });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/scoring/next-monday", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    res.json({ ok: true, nextMonday: nextMondayWeekStartUtcISO() });
  } catch (err) {
    fail(res, err);
  }
});

/** Apps Script-compatible action dispatcher (GET/POST /api?action=...) */
app.all("/api", async (req, res) => {
  try {
    const action =
      (req.query.action as string) ||
      (req.body && typeof req.body === "object" ? String((req.body as { action?: string }).action || "") : "");
    if (!action) {
      res.status(400).json({ error: "Missing action" });
      return;
    }
    const body = (typeof req.body === "object" && req.body) || {};

    switch (action) {
      case "leaderboard":
        res.json(
          getLeaderboard(
            (req.query.weekStart as string) || body.weekStart,
            parseLeaderboardTrack(req.query.track || body.track),
          ),
        );
        return;
      case "importFreshness":
        res.json(getImportFreshness());
        return;
      case "scoringProfile":
        res.json(getActiveProfilePublic());
        return;
      case "adminLogin":
        res.json({ ok: true, ...loginAdmin(body.email || "", body.password || "") });
        return;
      case "adminLogout":
        logoutAdmin(body.token || tokenFrom(req));
        res.json({ ok: true });
        return;
      case "importBegin": {
        const actor = requireAdmin(body.token || tokenFrom(req));
        res.json({
          ok: true,
          ...beginImport(actor, {
            exportTimeUtc: body.exportTimeUtc || new Date().toISOString(),
            exportTimezone: body.exportTimezone || "UTC",
            exportWindowHours: body.exportWindowHours,
          }),
        });
        return;
      }
      case "importUpload": {
        const actor = requireAdmin(body.token || tokenFrom(req));
        res.json({
          ok: true,
          ...uploadImportFiles(actor, body.batchId, {
            splunkCsv: body.splunkCsv || "",
            fleetCsv: body.fleetCsv || "",
            splunkMapping: body.splunkMapping,
            fleetMapping: body.fleetMapping,
          }),
        });
        return;
      }
      case "importPreview": {
        const actor = requireAdmin(body.token || tokenFrom(req));
        res.json({ ok: true, ...previewImport(actor, body.batchId) });
        return;
      }
      case "importCommit": {
        const actor = requireAdmin(body.token || tokenFrom(req));
        res.json({ ok: true, ...commitImport(actor, body.batchId) });
        return;
      }
      case "remindersPreview": {
        requireAdmin(body.token || tokenFrom(req));
        res.json({ ok: true, ...previewReminders() });
        return;
      }
      case "remindersQueue": {
        const actor = requireAdmin(body.token || tokenFrom(req));
        res.json({ ok: true, ...(await queueReminders(actor, body.emails || [])) });
        return;
      }
      case "remindersPending": {
        requireAdmin(body.token || tokenFrom(req));
        res.json({
          ok: true,
          nudges: listPendingNudges(body.status === "all" ? "all" : "queued"),
        });
        return;
      }
      case "remindersMarkSent": {
        const actor = requireAdmin(body.token || tokenFrom(req));
        res.json({
          ok: true,
          ...markNudgeSendResults(actor, body.results || [], { dryRun: Boolean(body.dryRun) }),
        });
        return;
      }
      case "reportsList": {
        requireAdmin(body.token || tokenFrom(req));
        res.json({ ok: true, reports: listReports(body.status) });
        return;
      }
      case "quarantineList": {
        requireAdmin(body.token || tokenFrom(req));
        res.json({ ok: true, items: listQuarantinedActivity(body.limit || 100) });
        return;
      }
      case "scoringPreview": {
        requireAdmin(body.token || tokenFrom(req));
        res.json({
          ok: true,
          ...previewDraftScores(body.profileId, body.version, body.weekStart),
        });
        return;
      }
      case "scoringSchedule": {
        const actor = requireAdmin(body.token || tokenFrom(req));
        res.json({
          ok: true,
          ...scheduleDraft(
            actor,
            body.profileId,
            body.version,
            body.effectiveWeekStart,
            body.reason,
          ),
        });
        return;
      }
      case "scoringEmergency": {
        const actor = requireAdmin(body.token || tokenFrom(req));
        const activated = emergencyActivate(
          actor,
          body.profileId,
          body.version,
          body.reason,
        );
        const scores = recomputeWeekScores(activated.weekStart);
        res.json({ ok: true, ...activated, scores });
        return;
      }
      case "seed": {
        const actor = requireAdmin(body.token || tokenFrom(req));
        res.json({ ok: true, ...seedDemoData(actor) });
        return;
      }
      case "weekStart":
        res.json({
          weekStart: weekStartUtcISO(new Date()),
          nextMonday: nextMondayWeekStartUtcISO(),
        });
        return;
      default:
        res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/fleet/status", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    res.json({ ok: true, ...getEvidenceSyncStatus() });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/fleet/sync", async (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const result = await syncFleetOwnership(actor);
    res.json({ ok: true, result });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/fleet/backfill-starts", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const changed = backfillOpenAssignmentStarts(actor);
    res.json({ ok: true, changed, windowStart: "previous Phoenix week Monday" });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/admin/assignments/export", (req, res) => {
  try {
    requireAdmin(tokenFrom(req));
    const { csv, filename, rows } = exportAssignmentCsv();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Assignment-Rows", String(rows));
    res.send(csv);
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/admin/fleet/manual-ownership", (req, res) => {
  try {
    const actor = requireAdmin(tokenFrom(req));
    const { cameraId, email } = req.body as { cameraId?: string; email?: string | null };
    if (!cameraId) throw new Error("cameraId required");
    const result = applyManualOwnership(actor, cameraId, email ?? null);
    res.json({ ok: true, result });
  } catch (err) {
    fail(res, err);
  }
});

/** Public camera inventory from Fleet/QR/Fleet assignments. */
app.get("/api/devices", (_req, res) => {
  try {
    res.json({ ok: true, ...listDeviceInventory() });
  } catch (err) {
    fail(res, err, 500);
  }
});

/** QR checkout/return — provisional until Fleet sync confirms (source=Fleet). */
app.post("/api/qr/checkout", (req, res) => {
  try {
    const { cameraId, email } = req.body as { cameraId?: string; email?: string };
    if (!cameraId) throw new Error("cameraId required");
    if (!email) throw new Error("email required");
    res.json({ ok: true, ...recordQrCheckout(email, cameraId) });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/qr/return", (req, res) => {
  try {
    const { cameraId, email } = req.body as { cameraId?: string; email?: string };
    if (!cameraId) throw new Error("cameraId required");
    res.json({ ok: true, ...recordQrReturn(cameraId, email) });
  } catch (err) {
    fail(res, err);
  }
});

if (ENV.webDist && fs.existsSync(ENV.webDist)) {
  app.use(express.static(ENV.webDist));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (req.path === "/health" || req.path === "/api" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(ENV.webDist, "index.html"));
  });
}

function startDataStoreInBackground(): void {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const script = fileURLToPath(new URL("./bootStoreCli.ts", import.meta.url));
  const child = fork(tsxCli, [script], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (child.exitCode !== null) {
      process.exit(0);
      return;
    }
    child.kill();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      process.exit(0);
      return;
    }
    if (code !== 0) {
      console.error(
        `Database init failed (health still returns 200): boot process exit ${code ?? signal}`,
      );
    }
    dataStoreReady = true;
    startEvidencePoller();
    startJiraTriagePoller();
  });
}

app.listen(ENV.port, "0.0.0.0", () => {
  console.log(`FieldCam listening on 0.0.0.0:${ENV.port}`);
  console.log(`Health: /health`);
  // Import is sync SQLite. On this thread it blocks /health, and Harbor restarts the
  // container when that check takes longer than 5 seconds.
  startDataStoreInBackground();
});
