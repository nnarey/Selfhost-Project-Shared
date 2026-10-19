import {
  statsCheckOutUrl,
  statsLeaderboardUrl,
  statsMyProfileUrl,
} from "../config/site";
import { INACTIVITY_THRESHOLD_HOURS } from "../config/scoring.config";
import { hoursSinceLastRecording } from "./scoring";
import type { ActivityRecord, NudgeKind, Participant, PendingNudge } from "./types";

const EMAIL_INACTIVITY_DAYS = 2;
const SLACK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const EMAIL_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;
/** Hours with no qualifying activity (since checkout or last action) before use/return Slack. */
export const INACTION_REMINDER_HOURS = 24;

function isQualifyingDay(r: ActivityRecord): boolean {
  return r.recordings > 0 || r.uploads > 0 || r.livestreams > 0 || r.reports > 0;
}

/** Most recent YYYY-MM-DD with any qualifying activity. */
export function getLastQualifyingDate(records: ActivityRecord[]): string | undefined {
  let latest: string | undefined;
  for (const r of records) {
    if (isQualifyingDay(r) && (!latest || r.date > latest)) latest = r.date;
  }
  return latest;
}

/**
 * Whole calendar days since last qualifying activity (or enrolledAt).
 * Mirrors Apps Script `daysSinceLastQualifyingActivity_`.
 */
export function daysSinceLastQualifyingActivity(
  participant: Participant,
  records: ActivityRecord[],
  nowISO: string,
): number {
  const last = getLastQualifyingDate(records);
  const anchor = last
    ? new Date(`${last}T00:00:00.000Z`).getTime()
    : new Date(participant.enrolledAt).getTime();
  return Math.floor((new Date(nowISO).getTime() - anchor) / (1000 * 60 * 60 * 24));
}

/**
 * Hours since last action while checked out: last qualifying day on/after
 * checkout, else checkout timestamp. Used for 1-day use/return reminders.
 */
export function hoursSinceLastActionWhileCheckedOut(
  participant: Participant,
  records: ActivityRecord[],
  nowISO: string,
): number {
  const checkoutISO = participant.checkoutDate || participant.enrolledAt;
  const checkoutDay = checkoutISO.slice(0, 10);
  const last = getLastQualifyingDate(records);
  const anchor =
    last && last >= checkoutDay
      ? new Date(`${last}T00:00:00.000Z`).getTime()
      : new Date(checkoutISO).getTime();
  return (new Date(nowISO).getTime() - anchor) / (1000 * 60 * 60);
}

/** Needs first-timer 7-day onboarding (not yet sent; not a repeat checkouter). */
export function needsOnboarding(participant: Participant): boolean {
  return !participant.onboardingSentAt && (participant.checkoutCount ?? 0) <= 1;
}

/** True if this is a second (or later) checkout — skip first-timer messaging. */
export function hasCheckedOutBefore(participant: Participant): boolean {
  return (participant.checkoutCount ?? 0) > 1;
}

function withinCooldown(iso: string | undefined, cooldownMs: number, now: Date): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return now.getTime() - t < cooldownMs;
}

/** First-timer onboarding sent after signup / first checkout. Keep in sync with server/src/onboardingMessage.ts. */
export function buildOnboarding7DayText(_p: Participant): string {
  return [
    "Hello, and thanks for joining the FieldCam self-host competition.",
    "",
    "Post findings in #fieldcam-selfhost. The weekly leaderboard is at https://fieldcam.example/#/leaderboard.",
    "Setup steps live in the guide: https://fieldcam.example/guide.",
    "",
    "1. Register the camera to yourself in Fleet.",
    "2. Check it out in the app, then record and upload.",
    "3. Return it from the Devices page when you are done.",
    "",
    "Questions go to Alice Chen (alice@northline.example).",
  ].join("\n");
}

export function buildOnboarding7DayEmail(p: Participant): { subject: string; body: string } {
  return {
    subject: "You're in FieldCam self-host — getting started",
    body: buildOnboarding7DayText(p),
  };
}

/** 1-day inactivity while still checked out: use or return. */
export function buildSlack1dNudgeText(p: Participant): string {
  return [
    `Hey ${p.name || "there"} — quick check-in on your FieldCam (${p.serial || "camera"}).`,
    "",
    "We haven't seen activity from you in about a day. Are you still wearing it?",
    "",
    "If something is getting in the way — device issue, too busy, just forgot — reply in #selfhost.",
    "",
    "If you're done, please return the camera to the hub so someone else can use it:",
    statsCheckOutUrl(),
    "",
    "Check your stats anytime:",
    `• My Profile: ${statsMyProfileUrl()}`,
    `• Leaderboard: ${statsLeaderboardUrl()}`,
    "",
    "Alice",
  ].join("\n");
}

/** @deprecated alias — same as 1-day use/return copy */
export function buildSlack24hNudgeText(p: Participant): string {
  return buildSlack1dNudgeText(p);
}

export function buildEmail2dNudge(p: Participant): { subject: string; body: string } {
  const subject = `FieldCam self-host: checking in on your camera (${p.serial || ""})`;
  const body = [
    `Hey ${p.name || "there"},`,
    "",
    `Quick check-in on your FieldCam (${p.serial || "camera"}) from the ${p.hub || ""} hub.`,
    "",
    "We haven't seen activity from you in a couple of days.",
    "",
    "Are you still wearing it? If you're done, return it at the hub desk:",
    statsCheckOutUrl(),
    "",
    `My Profile: ${statsMyProfileUrl()}`,
    `Leaderboard: ${statsLeaderboardUrl()}`,
    "",
    "Thanks,",
    "Alice",
  ].join("\n");
  return { subject, body };
}

export interface LocalNudgePreview {
  slack: { email: string; name: string; serial: string; kind: string; text: string }[];
  email: { email: string; name: string; serial: string; subject: string; body: string }[];
  skipped: { email: string; reason: string }[];
}

/**
 * Client-side preview (same rules as Apps Script).
 * Only people with a serial can get inactivity reminders.
 */
export function previewNudges(
  participants: Participant[],
  activity: ActivityRecord[],
  nowISO: string = new Date().toISOString(),
): LocalNudgePreview {
  const now = new Date(nowISO);
  const byEmail = new Map<string, ActivityRecord[]>();
  for (const r of activity) {
    const list = byEmail.get(r.email) ?? [];
    list.push(r);
    byEmail.set(r.email, list);
  }

  const slack: LocalNudgePreview["slack"] = [];
  const email: LocalNudgePreview["email"] = [];
  const skipped: LocalNudgePreview["skipped"] = [];

  for (const p of participants) {
    if (!p.serial?.trim()) {
      skipped.push({ email: p.email, reason: "not_checked_out" });
      continue;
    }
    const records = byEmail.get(p.email) ?? [];
    const hoursIdle = hoursSinceLastActionWhileCheckedOut(p, records, nowISO);
    const days = daysSinceLastQualifyingActivity(p, records, nowISO);

    if (hoursIdle > INACTION_REMINDER_HOURS) {
      if (withinCooldown(p.lastSlackNudgeAt, SLACK_COOLDOWN_MS, now)) {
        skipped.push({ email: p.email, reason: "slack_cooldown" });
      } else {
        slack.push({
          email: p.email,
          name: p.name,
          serial: p.serial,
          kind: "slack_1d",
          text: buildSlack1dNudgeText(p),
        });
      }
    } else if (hoursSinceLastRecording(p, records, nowISO) > INACTIVITY_THRESHOLD_HOURS) {
      // recording-only stale but had other activity — still ok, no slack
    }

    if (days >= EMAIL_INACTIVITY_DAYS) {
      if (withinCooldown(p.lastEmailNudgeAt, EMAIL_COOLDOWN_MS, now)) {
        skipped.push({ email: p.email, reason: "email_cooldown" });
      } else {
        const mail = buildEmail2dNudge(p);
        email.push({
          email: p.email,
          name: p.name,
          serial: p.serial,
          subject: mail.subject,
          body: mail.body,
        });
      }
    }
  }

  return { slack, email, skipped };
}

export function buildPendingNudgeSlackPayload(nudge: PendingNudge): {
  channel: string;
  text: string;
} {
  return { channel: nudge.email, text: nudge.text };
}

export function isNudgeKind(value: string): value is NudgeKind {
  return (
    value === "slack_1d" ||
    value === "slack_24h" ||
    value === "email_2d" ||
    value === "onboarding_7day"
  );
}
