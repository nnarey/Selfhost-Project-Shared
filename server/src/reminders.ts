import { v4 as uuid } from "uuid";
import { getDb, nowISO, audit } from "./db.js";
import { ENV } from "./env.js";
import { emailHandle } from "./participants.js";
import { humanizeIdleGap, workingHoursBetween } from "./workingHours.js";
import { getImportFreshness } from "./scoring/engine.js";
import { competitionStartUtcISO, periodWeekStartUtcISO } from "./week.js";
import { onboardingMessage } from "./onboardingMessage.js";
import { isPermanentHolderEmail } from "./config/permanentHolders.js";
import { sendSlackDm } from "./slackSend.js";

function liveAllowlist(): Set<string> | null {
  const raw = ENV.reminderLiveAllowlist.trim();
  if (!raw) return null;
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface ReminderCandidate {
  email: string;
  name: string;
  cameraId: string | null;
  kind: "onboarding" | "inactivity";
  reason: string;
  text: string;
  lastRecordingAt: string | null;
  assignedAt: string | null;
  /**
   * Working hours idle — since last valid recording, or since checkout. Working rather than
   * calendar, because that is what eligibility is measured in; a calendar figure beside a
   * working-time rule invites the reader to check one against the other and find them disagreeing.
   */
  idleWorkingHours: number;
}

function assertFreshForReminders(): void {
  const freshness = getImportFreshness();
  if (!freshness.hasImport || freshness.staleForReminders) {
    throw new Error(
      "Reminder queue/send blocked: activity export is missing or older than 24 hours. Import a fresh paired CSV batch first.",
    );
  }
}

/**
 * Reminder clocks run on working time, not calendar time.
 *
 * A calendar clock reminds someone on Monday morning that they have not recorded "for three days"
 * when two of those were the weekend. Counting only Phoenix working days means a Friday-afternoon
 * recording first triggers on Tuesday afternoon, which is two days someone was actually expected
 * to be using the camera.
 */
/** Duration a recording must reach to count toward the leaderboard. Mirrors the scoring rule. */
export const MIN_SCORING_SECONDS = 30;

export const IDLE_WORKING_HOURS = Number(process.env.REMINDER_IDLE_WORKING_HOURS || 48);

/**
 * Minimum working time between two nudges to the same person. Also on the working clock: a
 * calendar cooldown expires overnight, so a Friday nudge could re-fire on Saturday to someone
 * whose idle time had not meaningfully changed.
 */
export const NUDGE_COOLDOWN_WORKING_HOURS = Number(
  process.env.REMINDER_COOLDOWN_WORKING_HOURS || 24,
);

/**
 * How to address someone in a DM.
 *
 * `participants.name` holds a display name ("Devon Park"); the email local-part was
 * being used instead, so the messages opened "Hi devon". A first name only — a nudge that
 * greets someone by their full legal name reads like a form letter.
 *
 * Falls back to the email handle when a roster row has no name yet, which is better than an empty
 * greeting for someone who signed up but has not been filled in.
 */
export function greetingName(name: string | null | undefined, email: string): string {
  const first = (name || "").trim().split(/\s+/)[0];
  return first || emailHandle(email);
}

export function recomputeReminderEligibility(asOfISO = nowISO()): ReminderCandidate[] {
  const db = getDb();
  const participants = db
    .prepare(
      `SELECT email, name, camera_id, last_slack_nudge_at, snooze_until, enrolled_at
       FROM participants WHERE signup_status IN ('pending', 'approved')`,
    )
    .all() as Array<{
    email: string;
    name: string;
    camera_id: string | null;
    last_slack_nudge_at: string | null;
    snooze_until: string | null;
    enrolled_at: string;
  }>;

  const asOf = new Date(asOfISO).getTime();
  const candidates: ReminderCandidate[] = [];

  const lastSentRows = db
    .prepare(
      `SELECT lower(email) AS email, MAX(sent_at) AS sent_at
       FROM pending_nudges WHERE status = 'sent'
       GROUP BY lower(email)`,
    )
    .all() as Array<{ email: string; sent_at: string }>;
  const lastSentByEmail = new Map(lastSentRows.map((r) => [r.email, r.sent_at]));
  const onboardedEmails = new Set(
    (
      db
        .prepare(
          `SELECT lower(email) AS email FROM pending_nudges
           WHERE status = 'sent' AND kind = 'onboarding'`,
        )
        .all() as Array<{ email: string }>
    ).map((r) => r.email),
  );

  for (const p of participants) {
    if (p.snooze_until && new Date(p.snooze_until).getTime() > asOf) continue;

    const open = db
      .prepare(
        `SELECT * FROM assignment_history
         WHERE email = ?
           AND source IN ('fleet')
           AND assigned_at_utc <= ?
           AND (unassigned_at_utc IS NULL OR unassigned_at_utc > ?)
         ORDER BY assigned_at_utc DESC
         LIMIT 1`,
      )
      .get(p.email, asOfISO, asOfISO) as
      | {
          assignment_id: string;
          camera_id: string;
          assigned_at_utc: string;
        }
      | undefined;

    if (!open) continue;

    // Deliberately no duration floor. A 27-second clip is someone using the camera, and nudging
    // them for inactivity — or charging them an idle day — reads as a punishment for trying.
    // Whether the clip *scores* is a separate question, answered by the scoring buckets.
    const lastRec = db
      .prepare(
        `SELECT event_time_utc, duration_seconds FROM activity_events
         WHERE email = ?
           AND event_type = 'recording'
           AND lower(status) = 'success'
           AND upper(purpose) = 'PURPOSE_STANDARD'
           AND event_time_utc >= ?
         ORDER BY event_time_utc DESC
         LIMIT 1`,
      )
      .get(p.email, competitionStartUtcISO()) as
      | { event_time_utc: string; duration_seconds: number | null }
      | undefined;

    const emailKey = p.email.toLowerCase();
    const lastSent = lastSentByEmail.get(emailKey);
    const lastNudge = Math.max(
      p.last_slack_nudge_at ? new Date(p.last_slack_nudge_at).getTime() : 0,
      lastSent ? new Date(lastSent).getTime() : 0,
    );
    const periodStart = new Date(competitionStartUtcISO()).getTime();
    const hasOnboarding = onboardedEmails.has(emailKey);

    const greeting = greetingName(p.name, p.email);
    const displayName = (p.name || "").trim() || emailHandle(p.email);
    const checkoutAnchor = Math.max(new Date(open.assigned_at_utc).getTime(), periodStart);
    const hoursSinceCheckout = (asOf - checkoutAnchor) / (1000 * 60 * 60);

    // Permanent-camera holders already have the device. Onboarding is for checkout participants.
    if (!hasOnboarding && !isPermanentHolderEmail(p.email)) {
      candidates.push({
        email: p.email,
        name: displayName,
        cameraId: open.camera_id,
        kind: "onboarding",
        reason: "No onboarding DM sent yet",
        text: onboardingMessage(),
        lastRecordingAt: lastRec?.event_time_utc ?? null,
        assignedAt: open.assigned_at_utc,
        idleWorkingHours: workingHoursBetween(checkoutAnchor, asOf),
      });
      continue;
    }

    if (lastNudge && workingHoursBetween(lastNudge, asOf) < NUDGE_COOLDOWN_WORKING_HOURS) continue;

    if (!lastRec) {
      const workingSinceCheckout = workingHoursBetween(checkoutAnchor, asOf);
      const sinceCheckout = humanizeIdleGap(hoursSinceCheckout, workingSinceCheckout);
      if (workingSinceCheckout >= IDLE_WORKING_HOURS) {
        candidates.push({
          email: p.email,
          name: displayName,
          cameraId: open.camera_id,
          kind: "inactivity",
          reason: `No valid recording in ${sinceCheckout} since checkout`,
          text: `Hi ${greeting}, it's been ${sinceCheckout} since you checked out FieldCam (${open.camera_id}) and we still don't see a valid qualifying recording. A quick 30+ second clip gets you on the leaderboard.`,
          lastRecordingAt: null,
          assignedAt: open.assigned_at_utc,
          idleWorkingHours: workingSinceCheckout,
        });
      }
      continue;
    }

    const lastRecMs = new Date(lastRec.event_time_utc).getTime();
    const workingIdleHours = workingHoursBetween(lastRecMs, asOf);
    const idleGap = humanizeIdleGap((asOf - lastRecMs) / 3600_000, workingIdleHours);
    const lastDuration = Number(lastRec.duration_seconds || 0);
    // A short clip is a different problem from going quiet — but only when it is the only
    // Evidence they have recorded. A later 24-second clip must not hide weeks of silence
    // after they already recorded something that scored.
    const lastWasShort = lastDuration > 0 && lastDuration < MIN_SCORING_SECONDS;
    const hadScoringRecording = lastWasShort
      ? Boolean(
          db
            .prepare(
              `SELECT 1 AS ok FROM activity_events
               WHERE email = ?
                 AND event_type = 'recording'
                 AND lower(status) = 'success'
                 AND upper(purpose) = 'PURPOSE_STANDARD'
                 AND duration_seconds >= ?
                 AND event_time_utc >= ?
                 AND event_time_utc < ?
               LIMIT 1`,
            )
            .get(
              p.email,
              MIN_SCORING_SECONDS,
              competitionStartUtcISO(),
              lastRec.event_time_utc,
            ),
        )
      : false;
    const shortOnly = lastWasShort && !hadScoringRecording;
    if (workingIdleHours >= IDLE_WORKING_HOURS) {
      candidates.push({
        email: p.email,
        name: displayName,
        cameraId: open.camera_id,
        kind: "inactivity",
        reason: shortOnly
          ? `Last recording was ${Math.round(lastDuration)}s — under the ${MIN_SCORING_SECONDS}s minimum`
          : `No recording in ${idleGap} during open assignment`,
        // Someone who recorded for 27 seconds and is told "we don't see a valid recording" is
        // being told something untrue in their own terms. Name the actual problem.
        text: shortOnly
          ? `Hi ${greeting}, your last FieldCam recording on ${open.camera_id} was ${Math.round(lastDuration)} seconds — just under the ${MIN_SCORING_SECONDS}-second minimum, so it didn't count toward the leaderboard. One more clip over ${MIN_SCORING_SECONDS} seconds and you're on the board.`
          : `Hi ${greeting}, it's been ${idleGap} since your last FieldCam recording on ${open.camera_id}. A quick Fleet clip keeps your streak going.`,
        lastRecordingAt: lastRec.event_time_utc,
        assignedAt: open.assigned_at_utc,
        idleWorkingHours: workingIdleHours,
      });
    }
  }

  // Store eligibility snapshot for admin preview (not queued).
  db.prepare(
    `INSERT INTO sync_meta(key, value) VALUES('reminder_eligibility', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify({ asOf: asOfISO, candidates }));

  return candidates;
}

export function previewReminders() {
  const freshness = getImportFreshness();
  const candidates = recomputeReminderEligibility();
  return {
    freshness,
    blocked: freshness.staleForReminders || !freshness.hasImport,
    blockReason:
      freshness.staleForReminders || !freshness.hasImport
        ? "Activity data is stale or missing (>24h). Import fresh CSVs before queueing."
        : null,
    candidates,
  };
}

export async function queueReminders(actor: string, emails: string[]) {
  assertFreshForReminders();
  const preview = previewReminders();
  if (preview.blocked) throw new Error(preview.blockReason || "Reminders blocked");

  const selected = new Set(emails.map((e) => e.toLowerCase()));
  const db = getDb();
  const alreadyQueued = new Set(
    (
      db
        .prepare(
          `SELECT lower(email) AS email, kind FROM pending_nudges WHERE status = 'queued'`,
        )
        .all() as Array<{ email: string; kind: string }>
    ).map((r) => `${r.email}:${r.kind}`),
  );
  const toQueue = preview.candidates.filter((c) => {
    if (!selected.has(c.email.toLowerCase())) return false;
    if (alreadyQueued.has(`${c.email.toLowerCase()}:${c.kind}`)) return false;
    return true;
  });
  if (!toQueue.length) throw new Error("No matching eligible recipients selected");

  const now = nowISO();
  const weekStart = periodWeekStartUtcISO(now);
  const insert = db.prepare(
    `INSERT INTO pending_nudges (
      id, email, name, camera_id, kind, text, created_at, status, queued_at, week_start
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  );

  const ids: string[] = [];
  const tx = db.transaction(() => {
    for (const c of toQueue) {
      const id = uuid();
      ids.push(id);
      insert.run(
        id,
        c.email,
        c.name,
        c.cameraId,
        c.kind,
        c.text,
        now,
        now,
        weekStart,
      );
    }
  });
  tx();

  audit(actor, "reminders.queue", {
    entityType: "pending_nudges",
    newValue: { ids, emails: toQueue.map((c) => c.email) },
  });

  const autoSend = Boolean(ENV.reminderAutoSend && ENV.slackBotToken);
  let sent = 0;
  let failed = 0;
  if (autoSend) {
    const results: Array<{ id: string; status: "sent" | "failed"; error?: string }> = [];
    for (let i = 0; i < toQueue.length; i++) {
      const c = toQueue[i];
      const id = ids[i];
      const dm = await sendSlackDm(c.email, c.text);
      if (dm.ok) {
        results.push({ id, status: "sent" });
        sent += 1;
      } else {
        results.push({ id, status: "failed", error: dm.error || "slack send failed" });
        failed += 1;
      }
    }
    markNudgeSendResults(actor, results, { dryRun: false });
  }

  return { queued: toQueue.length, ids, sent, failed, autoSend };
}

export function listPendingNudges(status: "queued" | "all" = "queued") {
  const db = getDb();
  if (status === "all") {
    return db
      .prepare(
        `SELECT id, email, name, camera_id as cameraId, kind, text, created_at as createdAt,
                status, queued_at as queuedAt, sent_at as sentAt, error, week_start as weekStart
         FROM pending_nudges
         ORDER BY created_at DESC
         LIMIT 200`,
      )
      .all();
  }
  return db
    .prepare(
      `SELECT id, email, name, camera_id as cameraId, kind, text, created_at as createdAt,
              status, queued_at as queuedAt, sent_at as sentAt, error, week_start as weekStart
       FROM pending_nudges
       WHERE status = 'queued'
       ORDER BY created_at ASC
       LIMIT 200`,
    )
    .all();
}

/**
 * Record MCP send results. dryRun audits what would change but does not mark rows sent.
 * Live (dryRun=false) "sent" results are gated by REMINDER_LIVE_ALLOWLIST when set.
 * Empty allowlist (default) does not restrict queued recipients.
 */
export function markNudgeSendResults(
  actor: string,
  results: Array<{ id: string; status: "sent" | "failed"; error?: string }>,
  opts: { dryRun?: boolean } = {},
) {
  const dryRun = Boolean(opts.dryRun);
  const db = getDb();
  const now = nowISO();
  const allow = liveAllowlist();
  const update = db.prepare(
    `UPDATE pending_nudges SET status = ?, sent_at = ?, error = ? WHERE id = ? AND status = 'queued'`,
  );
  const touchParticipant = db.prepare(
    `UPDATE participants SET last_slack_nudge_at = ? WHERE email = (
       SELECT email FROM pending_nudges WHERE id = ?
     )`,
  );
  const getNudge = db.prepare(`SELECT email FROM pending_nudges WHERE id = ?`);

  const applied: Array<{
    id: string;
    status: string;
    dryRun: boolean;
    email?: string;
    error?: string | null;
  }> = [];
  const tx = db.transaction(() => {
    for (const r of results) {
      const row = getNudge.get(r.id) as { email: string } | undefined;
      const email = row?.email?.toLowerCase();

      if (dryRun) {
        applied.push({ id: r.id, status: r.status, dryRun: true, email });
        continue;
      }

      let status = r.status;
      let error = r.error || null;
      if (
        status === "sent" &&
        allow &&
        (!email || !allow.has(email))
      ) {
        status = "failed";
        error = error || "not allowlisted for live reminder send (REMINDER_LIVE_ALLOWLIST)";
      }

      const sentAt = status === "sent" ? now : null;
      const info = update.run(status, sentAt, error, r.id);
      if (info.changes > 0 && status === "sent") {
        touchParticipant.run(now, r.id);
      }
      applied.push({ id: r.id, status, dryRun: false, email, error });
    }
  });
  tx();

  audit(actor, dryRun ? "reminders.send_dry_run" : "reminders.send_results", {
    entityType: "pending_nudges",
    newValue: { applied, count: applied.length },
  });

  return {
    dryRun,
    applied,
    count: applied.length,
    allowlist: allow ? [...allow] : null,
  };
}

export function cancelQueuedNudges(actor: string, ids: string[]) {
  const db = getDb();
  const now = nowISO();
  const upd = db.prepare(
    `UPDATE pending_nudges SET status = 'cancelled', error = ?, sent_at = ?
     WHERE id = ? AND status = 'queued'`,
  );
  let cancelled = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const info = upd.run("cancelled by admin", now, id);
      if (info.changes > 0) cancelled += 1;
    }
  });
  tx();
  audit(actor, "reminders.cancel", {
    entityType: "pending_nudges",
    newValue: { ids, cancelled },
  });
  return { cancelled };
}
