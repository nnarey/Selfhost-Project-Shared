// Core domain types for the FieldCam Self-Host World Cup platform.
//
// STAGE 1 NOTE: These types are designed to map 1:1 onto the Google Sheet
// tabs described in the plan (Sheet1 / Teams / Assignments / Activity /
// Matches) so that the localStorage-backed dataSource in `dataSource.ts`
// can later be swapped for a real Apps Script client without changing any
// UI code. See `sheetsClient.ts` for the stubbed future integration.

export type Hub = "Phoenix" | "Seattle";

export const HUBS: Hub[] = ["Phoenix", "Seattle"];

export type Role = "PM" | "Eng" | "LDP" | "Sales" | "SE" | "UX" | "CSM" | "Other";

export const ROLES: Role[] = ["PM", "Eng", "LDP", "Sales", "SE", "UX", "CSM", "Other"];

export type Department =
  | "R&D"
  | "Product"
  | "PM"
  | "Eng"
  | "LDP"
  | "Sales"
  | "SE"
  | "UX"
  | "CSM"
  | "Other";

export const DEPARTMENTS: Department[] = [
  "R&D",
  "Product",
  "PM",
  "Eng",
  "LDP",
  "Sales",
  "SE",
  "UX",
  "CSM",
  "Other",
];

export type ParticipantStatus = "Active" | "Inactive";

export type DeviceAvailability = "Available" | "Checked out";

export type ComplaintStatus = "open" | "resolved";

export type NudgeKind = "slack_1d" | "slack_24h" | "email_2d" | "onboarding_7day";

export type PendingNudgeStatus = "pending" | "sent" | "failed";

/** Queued Slack (or preview) nudge row from the PendingNudges sheet. */
export interface PendingNudge {
  id: string;
  email: string;
  name: string;
  serial: string;
  kind: NudgeKind | string;
  text: string;
  createdAt: string;
  status: PendingNudgeStatus | string;
  sentAt?: string;
  error?: string;
}

export interface NudgeJobResult {
  dryRun: boolean;
  allowlist: string[] | null;
  slack: {
    email: string;
    name?: string;
    serial?: string;
    kind?: string;
    text: string;
  }[];
  email: {
    email: string;
    name?: string;
    serial?: string;
    kind?: string;
    subject: string;
    body: string;
  }[];
  skipped: { email: string; reason: string }[];
}

/** Physical FieldCam unit stocked at a hub desk. Availability is derived from checkouts. */
export interface Device {
  serial: string;
  hub: Hub;
  /** Where to find it at the hub (shelf / bin). */
  deskLocation: string;
}

/**
 * Raw Google Form response row (before / until admin assignment).
 * Password is stored for login checks only — never expose in public GET lists.
 */
export interface FormSignup {
  email: string;
  name: string;
  password: string;
  role: Role;
  hub: Hub;
  /** ISO timestamp from Form. */
  submittedAt: string;
  /** Extra questionnaire answers (freeform). */
  notes?: string;
  /** True once admin assigned to a team or waitlist. */
  assigned?: boolean;
}

export interface Complaint {
  id: string;
  email: string;
  name: string;
  body: string;
  createdAt: string;
  status: ComplaintStatus;
  adminNote?: string;
}

export interface Participant {
  /** Unique key — must be an @northline.example address. */
  email: string;
  name: string;
  hub: Hub;
  role: Role;
  department: Department;
  /** Current device serial. Empty string = no device currently checked out. */
  serial: string;
  /**
   * Competing team id, `waitlist`, or undefined (unassigned Form signup not yet
   * placed in a bucket).
   */
  teamId?: string;
  status: ParticipantStatus;
  /** ISO timestamp of enrollment (sign-up). */
  enrolledAt: string;
  /** ISO timestamp of most recent device checkout. */
  checkoutDate: string;
  /**
   * ISO timestamp of the most recent device return, if the participant is
   * currently between devices. Cleared once a new serial is checked out.
   * Device-logistics bookkeeping only — does not drive auto-inactivity;
   * see `computeAutoStatus` (based on last logged recording) for that.
   */
  lastReturnAt?: string;
  /** True if an admin manually overrode status (skips the 24h no-recordings auto-rule). */
  manualStatusOverride?: boolean;
  /** Form password for local login (prototype). Never show in public UI. */
  password?: string;
  /** Profile photo URL (Drive or data URL for local demo). */
  photoUrl?: string;
  /** ISO timestamp of last Slack inactivity nudge (set when PendingNudge marked sent). */
  lastSlackNudgeAt?: string;
  /** ISO timestamp of last 2-day inactivity email (MailApp). */
  lastEmailNudgeAt?: string;
  /**
   * How many times this person has checked out a device (lifetime).
   * 0 = never; used so short-term/repeat users skip first-timer onboarding.
   */
  checkoutCount?: number;
  /** ISO timestamp when the 7-day onboarding overview was sent (first-timers only). */
  onboardingSentAt?: string;
}

export type Group = "A" | "B";

export interface Team {
  id: string;
  /** Original preset name, kept for reference. */
  defaultName: string;
  /** Current display name — editable by any roster member. */
  name: string;
  color: string;
  crest: string;
  group: Group;
  /** Optional uploaded logo (overrides crest emoji when set). */
  logoUrl?: string;
}

export interface ActivityRecord {
  email: string;
  /** ISO date (day granularity), e.g. "2026-06-20". */
  date: string;
  recordings: number;
  hours: number;
  uploads: number;
  livestreams: number;
  reports: number;
}

export type MatchStage = "group" | "semifinal" | "final" | "thirdPlace";

export interface Match {
  id: string;
  stage: MatchStage;
  group?: Group;
  /** Round-robin round number within the group stage (1-3). */
  round?: number;
  homeTeamId: string | null;
  awayTeamId: string | null;
  /** ISO date — match window start. */
  startDate: string;
  /** ISO date — match window end. */
  endDate: string;
  /** True once endDate has passed and a result has been computed. */
  played: boolean;
  /** True if this fixture is still waiting on group-stage results (bracket). */
  provisional?: boolean;
}

export interface NewParticipantInput {
  name: string;
  email: string;
  hub: Hub;
  role: Role;
  department: Department;
  serial?: string;
}

export interface ScoreBreakdown {
  recordingPoints: number;
  hourPoints: number;
  uploadPoints: number;
  livestreamPoints: number;
  reportPoints: number;
  streakBonus: number;
  streakDays: number;
  inactivePenalty: number;
  inactiveDays: number;
  total: number;
  totals: {
    recordings: number;
    hours: number;
    uploads: number;
    livestreams: number;
    reports: number;
  };
}
