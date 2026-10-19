import { ADMIN_PASSWORD } from "../config/admin";
import type {
  ActivityRecord,
  Complaint,
  Device,
  FormSignup,
  Match,
  MatchStage,
  NudgeJobResult,
  NudgeKind,
  Participant,
  PendingNudge,
  Team,
} from "./types";
import { isSheetsConfigured, sheetsGet, sheetsPost } from "./sheetsClient";

export { isSheetsConfigured };

export interface SheetsSnapshot {
  participants: Participant[];
  teams: Team[];
  activity: ActivityRecord[];
  matches: Match[];
  devices: Device[];
  formSignups: FormSignup[];
  unassignedSignups: Omit<FormSignup, "password">[];
  complaints: Complaint[];
  pendingNudges: PendingNudge[];
}

function normalizeParticipant(raw: Record<string, unknown>): Participant {
  const teamId = raw.teamId ? String(raw.teamId) : undefined;
  return {
    email: String(raw.email || "").toLowerCase(),
    name: String(raw.name || ""),
    hub: (raw.hub as Participant["hub"]) || "Phoenix",
    role: (raw.role as Participant["role"]) || "Other",
    department: (raw.department as Participant["department"]) || "Other",
    serial: raw.serial ? String(raw.serial) : "",
    teamId: teamId || undefined,
    status: raw.status === "Inactive" ? "Inactive" : "Active",
    enrolledAt: String(raw.enrolledAt || new Date().toISOString()),
    checkoutDate: String(raw.checkoutDate || raw.enrolledAt || new Date().toISOString()),
    lastReturnAt: raw.lastReturnAt ? String(raw.lastReturnAt) : undefined,
    manualStatusOverride: Boolean(raw.manualStatusOverride),
    photoUrl: raw.photoUrl ? String(raw.photoUrl) : undefined,
    password: raw.password ? String(raw.password) : undefined,
    lastSlackNudgeAt: raw.lastSlackNudgeAt ? String(raw.lastSlackNudgeAt) : undefined,
    lastEmailNudgeAt: raw.lastEmailNudgeAt ? String(raw.lastEmailNudgeAt) : undefined,
    checkoutCount: Number(raw.checkoutCount) || 0,
    onboardingSentAt: raw.onboardingSentAt ? String(raw.onboardingSentAt) : undefined,
  };
}

function normalizePendingNudge(raw: Record<string, unknown>): PendingNudge {
  return {
    id: String(raw.id || ""),
    email: String(raw.email || "").toLowerCase(),
    name: String(raw.name || ""),
    serial: String(raw.serial || ""),
    kind: String(raw.kind || ""),
    text: String(raw.text || ""),
    createdAt: String(raw.createdAt || ""),
    status: String(raw.status || "pending"),
    sentAt: raw.sentAt ? String(raw.sentAt) : undefined,
    error: raw.error ? String(raw.error) : undefined,
  };
}

function normalizeTeam(raw: Record<string, unknown>): Team {
  return {
    id: String(raw.id),
    defaultName: String(raw.defaultName || raw.name || ""),
    name: String(raw.name || raw.defaultName || ""),
    color: String(raw.color || "#3b82f6"),
    crest: String(raw.crest || "⚽"),
    group: raw.group === "B" ? "B" : "A",
    logoUrl: raw.logoUrl ? String(raw.logoUrl) : undefined,
  };
}

function normalizeMatch(raw: Record<string, unknown>): Match {
  return {
    id: String(raw.id),
    stage: raw.stage as MatchStage,
    group: raw.group === "A" || raw.group === "B" ? raw.group : undefined,
    round: raw.round === "" || raw.round == null ? undefined : Number(raw.round),
    homeTeamId: raw.homeTeamId ? String(raw.homeTeamId) : null,
    awayTeamId: raw.awayTeamId ? String(raw.awayTeamId) : null,
    startDate: String(raw.startDate || "").slice(0, 10),
    endDate: String(raw.endDate || "").slice(0, 10),
    played: Boolean(raw.played),
    provisional: Boolean(raw.provisional),
  };
}

export async function fetchSheetsSnapshot(): Promise<SheetsSnapshot> {
  const [
    participantsRaw,
    teamsRaw,
    activityRaw,
    matchesRaw,
    devicesRaw,
    signupsRaw,
    unassignedRaw,
    complaintsRaw,
  ] = await Promise.all([
    sheetsGet<Record<string, unknown>[]>("participants"),
    sheetsGet<Record<string, unknown>[]>("teams"),
    sheetsGet<Record<string, unknown>[]>("activity"),
    sheetsGet<Record<string, unknown>[]>("matches"),
    sheetsGet<Record<string, unknown>[]>("devices"),
    sheetsGet<Record<string, unknown>[]>("signups"),
    sheetsGet<Record<string, unknown>[]>("unassignedSignups"),
    sheetsGet<Record<string, unknown>[]>("complaints"),
  ]);

  // Optional until Apps Script is redeployed with nudge endpoints.
  let pendingNudgesRaw: Record<string, unknown>[] = [];
  try {
    pendingNudgesRaw = await sheetsGet<Record<string, unknown>[]>("pendingNudges");
  } catch {
    pendingNudgesRaw = [];
  }

  const participants = (participantsRaw || []).map(normalizeParticipant);
  const formSignups: FormSignup[] = (signupsRaw || []).map((s) => ({
    email: String(s.email || "").toLowerCase(),
    name: String(s.name || ""),
    password: "",
    role: (s.role as FormSignup["role"]) || "Other",
    hub: (s.hub as FormSignup["hub"]) || "Phoenix",
    submittedAt: String(s.submittedAt || ""),
  }));

  return {
    participants,
    teams: (teamsRaw || []).map(normalizeTeam),
    activity: (activityRaw || []).map((a) => ({
      email: String(a.email || "").toLowerCase(),
      date: String(a.date || "").slice(0, 10),
      recordings: Number(a.recordings) || 0,
      hours: Number(a.hours) || 0,
      uploads: Number(a.uploads) || 0,
      livestreams: Number(a.livestreams) || 0,
      reports: Number(a.reports) || 0,
    })),
    matches: (matchesRaw || []).map(normalizeMatch),
    devices: (devicesRaw || []).map((d) => ({
      serial: String(d.serial || ""),
      hub: (d.hub as Device["hub"]) || "Phoenix",
      deskLocation: String(
        d.deskLocation || ((d.hub as Device["hub"]) === "Seattle" ? "Hub A" : "Black Box"),
      ),
    })),
    formSignups,
    unassignedSignups: (unassignedRaw || []).map((s) => ({
      email: String(s.email || "").toLowerCase(),
      name: String(s.name || ""),
      role: (s.role as FormSignup["role"]) || "Other",
      hub: (s.hub as FormSignup["hub"]) || "Phoenix",
      submittedAt: String(s.submittedAt || ""),
    })),
    complaints: (complaintsRaw || []).map((c) => ({
      id: String(c.id),
      email: String(c.email || ""),
      name: String(c.name || ""),
      body: String(c.body || ""),
      createdAt: String(c.createdAt || ""),
      status: c.status === "resolved" ? "resolved" : "open",
      adminNote: c.adminNote ? String(c.adminNote) : undefined,
    })),
    pendingNudges: (pendingNudgesRaw || []).map(normalizePendingNudge),
  };
}

export async function sheetsLoginParticipant(
  email: string,
  password: string,
): Promise<{ email: string; name: string; role: "participant" }> {
  return sheetsPost({ action: "login", email, password });
}

export async function sheetsLoginAdmin(
  email: string,
  password: string,
): Promise<{ email: string; name: string; role: "admin" }> {
  return sheetsPost({ action: "loginAdmin", email, password });
}

type AdminAuth = { adminEmail: string; adminPassword: string };

export function adminAuthFromSession(email: string, storedPassword?: string): AdminAuth {
  return {
    adminEmail: email,
    adminPassword: storedPassword || ADMIN_PASSWORD,
  };
}

export async function sheetsAssignTeam(auth: AdminAuth, email: string, teamId: string) {
  await sheetsPost({ action: "assignTeam", ...auth, email, teamId });
}

export async function sheetsUpsertActivity(auth: AdminAuth, record: ActivityRecord) {
  await sheetsPost({ action: "upsertActivity", ...auth, record });
}

export async function sheetsDeleteActivity(auth: AdminAuth, email: string, date: string) {
  await sheetsPost({ action: "deleteActivity", ...auth, email, date });
}

export async function sheetsUpsertMatch(auth: AdminAuth, match: Match) {
  await sheetsPost({ action: "upsertMatch", ...auth, match });
}

export async function sheetsDeleteMatch(auth: AdminAuth, matchId: string) {
  await sheetsPost({ action: "deleteMatch", ...auth, matchId });
}

export async function sheetsCreateMatch(
  auth: AdminAuth,
  match: Match,
): Promise<Match> {
  return sheetsPost({ action: "createMatch", ...auth, match });
}

export async function sheetsCreateComplaint(email: string, body: string): Promise<Complaint> {
  return sheetsPost({ action: "createComplaint", email, body });
}

export async function sheetsResolveComplaint(auth: AdminAuth, id: string, adminNote?: string) {
  await sheetsPost({ action: "resolveComplaint", ...auth, id, adminNote });
}

export async function sheetsUpdateTeamProfile(data: {
  teamId: string;
  name?: string;
  color?: string;
  logoUrl?: string | null;
  crest?: string;
  requesterEmail?: string;
}) {
  await sheetsPost({ action: "updateTeamProfile", ...data });
}

export async function sheetsUpdateProfilePhoto(email: string, photoUrl: string) {
  await sheetsPost({ action: "updateProfilePhoto", email, photoUrl });
}

export async function sheetsUpdateSerial(auth: AdminAuth, email: string, serial: string) {
  await sheetsPost({ action: "updateSerial", ...auth, email, serial });
}

export async function sheetsSetStatus(
  auth: AdminAuth,
  email: string,
  status: "Active" | "Inactive",
) {
  await sheetsPost({ action: "setStatus", ...auth, email, status });
}

export async function sheetsCheckoutDevice(email: string, serial: string) {
  await sheetsPost({ action: "checkoutDevice", email, serial });
}

export async function sheetsReturnDevice(email: string) {
  await sheetsPost({ action: "returnDevice", email });
}

export async function sheetsRecordReturn(auth: AdminAuth, email: string) {
  await sheetsPost({ action: "recordReturn", ...auth, email });
}

export async function sheetsListPendingNudges(): Promise<PendingNudge[]> {
  const rows = await sheetsGet<Record<string, unknown>[]>("pendingNudges");
  return (rows || []).map(normalizePendingNudge);
}

export async function sheetsRunNudgeJob(
  auth: AdminAuth,
  dryRun: boolean,
): Promise<NudgeJobResult> {
  return sheetsPost({ action: "runNudgeJob", ...auth, dryRun });
}

export async function sheetsForceNudge(
  auth: AdminAuth,
  email: string,
  kind: NudgeKind,
  dryRun: boolean,
): Promise<Record<string, unknown>> {
  return sheetsPost({ action: "forceNudge", ...auth, email, kind, dryRun });
}

export async function sheetsMarkNudgeSent(auth: AdminAuth, id: string) {
  await sheetsPost({ action: "markNudgeSent", ...auth, id });
}

export async function sheetsMarkNudgeFailed(auth: AdminAuth, id: string, error?: string) {
  await sheetsPost({ action: "markNudgeFailed", ...auth, id, error });
}
