// STAGE 1 DATA SOURCE — localStorage stand-in for Google Sheet + Apps Script.
// Function signatures match the planned Apps Script contract so UI can swap later.

import { WAITLIST_TEAM_ID } from "../config/teams";
import { adminCredentialsValid } from "./session";
import { buildComplaintSlackReminders } from "./slackNotify";
import { computeAutoStatus } from "./scoring";
import { buildDeviceInventory } from "./devices";
import { buildTeams, generateSeed } from "./mockSeed";
import type {
  ActivityRecord,
  Complaint,
  Device,
  FormSignup,
  Hub,
  Match,
  MatchStage,
  NewParticipantInput,
  Participant,
  Role,
  Team,
} from "./types";
import { HUBS, ROLES } from "./types";

const STORAGE_KEYS = {
  participants: "fieldcam_participants_v1",
  teams: "fieldcam_teams_v1",
  activity: "fieldcam_activity_v1",
  matches: "fieldcam_matches_v1",
  devices: "fieldcam_devices_v1",
  formSignups: "fieldcam_form_signups_v1",
  complaints: "fieldcam_complaints_v1",
  pendingSlack: "fieldcam_pending_slack_v1",
};

const COMPANY_EMAIL_RE = /^[a-z0-9._%+-]+@northline\.com$/i;

export class ValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function readJSON<T>(key: string): T | null {
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJSON<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function seedFormSignups(): FormSignup[] {
  const now = Date.now();
  return [
    {
      email: "jordan.lee@northline.example",
      name: "Jordan Lee",
      password: "demo",
      role: "Eng",
      hub: "Phoenix",
      submittedAt: new Date(now - 86400000 * 2).toISOString(),
      notes: "Wants outdoor heat testing",
      assigned: false,
    },
    {
      email: "sam.patel@northline.example",
      name: "Sam Patel",
      password: "demo",
      role: "PM",
      hub: "Seattle",
      submittedAt: new Date(now - 86400000).toISOString(),
      notes: "Interested in livestream reliability",
      assigned: false,
    },
    {
      email: "alex.kim@northline.example",
      name: "Alex Kim",
      password: "demo",
      role: "UX",
      hub: "Phoenix",
      submittedAt: new Date(now - 3600000 * 5).toISOString(),
      notes: "Can wear daily",
      assigned: false,
    },
  ];
}

function ensureFormSignups() {
  const existing = readJSON<FormSignup[]>(STORAGE_KEYS.formSignups);
  if (existing && existing.length > 0) return;
  writeJSON(STORAGE_KEYS.formSignups, seedFormSignups());
}

function ensureComplaints() {
  if (readJSON<Complaint[]>(STORAGE_KEYS.complaints)) return;
  writeJSON(STORAGE_KEYS.complaints, []);
}

function ensureSeeded() {
  const existing = readJSON<Team[]>(STORAGE_KEYS.teams);
  if (existing && existing.length > 0) {
    ensureDevices();
    ensureFormSignups();
    ensureComplaints();
    return;
  }

  const teams = buildTeams();
  const { participants, activity, matches, devices } = generateSeed(teams);
  // Give seeded rostered people a demo password so login works in local mode.
  const withPasswords = participants.map((p) => ({ ...p, password: "demo" }));
  writeJSON(STORAGE_KEYS.teams, teams);
  writeJSON(STORAGE_KEYS.participants, withPasswords);
  writeJSON(STORAGE_KEYS.activity, activity);
  writeJSON(STORAGE_KEYS.matches, matches);
  writeJSON(STORAGE_KEYS.devices, devices);
  writeJSON(STORAGE_KEYS.formSignups, seedFormSignups());
  writeJSON(STORAGE_KEYS.complaints, []);
}

function ensureDevices() {
  const existing = readJSON<Device[]>(STORAGE_KEYS.devices);
  if (existing && existing.length > 0) return;

  const devices = buildDeviceInventory();
  const seen = new Set(devices.map((d) => d.serial.toUpperCase()));
  const participants = readJSON<Participant[]>(STORAGE_KEYS.participants) ?? [];
  for (const p of participants) {
    const serial = p.serial?.trim();
    if (!serial) continue;
    if (seen.has(serial.toUpperCase())) continue;
    devices.push({
      serial,
      hub: p.hub,
      deskLocation: p.hub === "Seattle" ? "Hub A" : "Black Box",
    });
    seen.add(serial.toUpperCase());
  }
  writeJSON(STORAGE_KEYS.devices, devices);
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

window.addEventListener("storage", (e) => {
  if (Object.values(STORAGE_KEYS).includes(e.key ?? "")) notify();
});

ensureSeeded();

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listTeams(): Team[] {
  return readJSON<Team[]>(STORAGE_KEYS.teams) ?? [];
}

export function listParticipants(): Participant[] {
  const participants = readJSON<Participant[]>(STORAGE_KEYS.participants) ?? [];
  const activity = readJSON<ActivityRecord[]>(STORAGE_KEYS.activity) ?? [];
  const activityByEmail = new Map<string, ActivityRecord[]>();
  for (const r of activity) {
    const list = activityByEmail.get(r.email) ?? [];
    list.push(r);
    activityByEmail.set(r.email, list);
  }

  const nowISO = new Date().toISOString();
  let changed = false;
  const updated = participants.map((p) => {
    const autoStatus = computeAutoStatus(p, activityByEmail.get(p.email) ?? [], nowISO);
    if (autoStatus !== p.status) {
      changed = true;
      return { ...p, status: autoStatus };
    }
    return p;
  });
  if (changed) writeJSON(STORAGE_KEYS.participants, updated);
  return updated;
}

export function getParticipant(email: string): Participant | undefined {
  return listParticipants().find((p) => p.email.toLowerCase() === email.toLowerCase());
}

export function listActivity(): ActivityRecord[] {
  return readJSON<ActivityRecord[]>(STORAGE_KEYS.activity) ?? [];
}

export function listMatches(): Match[] {
  return readJSON<Match[]>(STORAGE_KEYS.matches) ?? [];
}

export function listDevices(): Device[] {
  ensureDevices();
  return readJSON<Device[]>(STORAGE_KEYS.devices) ?? [];
}

/** Form responses not yet shown as secrets in UI — strip password in public list helper. */
export function listFormSignups(): FormSignup[] {
  ensureFormSignups();
  return readJSON<FormSignup[]>(STORAGE_KEYS.formSignups) ?? [];
}

export function listUnassignedSignups(): Omit<FormSignup, "password">[] {
  return listFormSignups()
    .filter((s) => !s.assigned)
    .map(({ password: _pw, ...rest }) => rest);
}

export function listComplaints(): Complaint[] {
  ensureComplaints();
  return readJSON<Complaint[]>(STORAGE_KEYS.complaints) ?? [];
}

export function listPendingSlackReminders(): { channel: string; text: string }[] {
  return readJSON(STORAGE_KEYS.pendingSlack) ?? [];
}

export function clearPendingSlackReminders(): void {
  writeJSON(STORAGE_KEYS.pendingSlack, []);
  notify();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function loginParticipant(
  email: string,
  password: string,
): { email: string; name: string; role: "participant" } {
  const normalized = email.trim().toLowerCase();
  const signup = listFormSignups().find((s) => s.email.toLowerCase() === normalized);
  const participant = getParticipant(normalized);

  const expected =
    participant?.password ??
    signup?.password ??
    null;

  if (!expected || expected !== password) {
    throw new ValidationError("BAD_CREDENTIALS", "Incorrect email or password.");
  }

  const name = participant?.name ?? signup?.name ?? normalized;
  return { email: normalized, name, role: "participant" };
}

export function loginAdmin(
  email: string,
  password: string,
): { email: string; name: string; role: "admin" } {
  const normalized = email.trim().toLowerCase();
  if (!adminCredentialsValid(normalized, password)) {
    throw new ValidationError(
      "BAD_ADMIN",
      "Admin login requires an allowlisted @northline.example email and the admin password.",
    );
  }
  return { email: normalized, name: normalized.split("@")[0], role: "admin" };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function addParticipant(input: NewParticipantInput): Participant {
  const email = input.email.trim().toLowerCase();
  if (!COMPANY_EMAIL_RE.test(email)) {
    throw new ValidationError("INVALID_EMAIL", "Email must be an @northline.example address.");
  }

  const participants = listParticipants();
  if (participants.some((p) => p.email.toLowerCase() === email)) {
    throw new ValidationError("DUPLICATE_EMAIL", "Email already registered.");
  }

  const now = new Date().toISOString();
  const serial = input.serial?.trim() ?? "";
  const participant: Participant = {
    email,
    name: input.name.trim(),
    hub: input.hub,
    role: input.role,
    department: input.department,
    serial,
    teamId: undefined,
    status: "Active",
    enrolledAt: now,
    checkoutDate: now,
    checkoutCount: serial ? 1 : 0,
  };

  writeJSON(STORAGE_KEYS.participants, [...participants, participant]);
  notify();
  return participant;
}

/**
 * Assign Form signup (or existing participant) to a competing team or waitlist.
 */
export function assignTeam(email: string, teamId: string): void {
  const normalized = email.trim().toLowerCase();
  const teams = listTeams();
  if (teamId !== WAITLIST_TEAM_ID && !teams.some((t) => t.id === teamId)) {
    throw new ValidationError("BAD_TEAM", "Unknown team.");
  }

  let participants = listParticipants();
  let person = participants.find((p) => p.email.toLowerCase() === normalized);

  const signups = listFormSignups();
  const signup = signups.find((s) => s.email.toLowerCase() === normalized);

  if (!person && signup) {
    const role = (ROLES.includes(signup.role as Role) ? signup.role : "Other") as Role;
    const hub = (HUBS.includes(signup.hub as Hub) ? signup.hub : "Phoenix") as Hub;
    const now = new Date().toISOString();
    person = {
      email: signup.email.toLowerCase(),
      name: signup.name,
      hub,
      role,
      department: "Other",
      serial: "",
      teamId,
      status: "Active",
      enrolledAt: signup.submittedAt || now,
      checkoutDate: now,
      password: signup.password,
    };
    participants = [...participants, person];
  } else if (person) {
    participants = participants.map((p) =>
      p.email.toLowerCase() === normalized
        ? {
            ...p,
            teamId,
            password: p.password ?? signup?.password,
            name: p.name || signup?.name || p.name,
          }
        : p,
    );
  } else {
    throw new ValidationError("NOT_FOUND", "No signup found for that email.");
  }

  writeJSON(STORAGE_KEYS.participants, participants);
  writeJSON(
    STORAGE_KEYS.formSignups,
    signups.map((s) =>
      s.email.toLowerCase() === normalized ? { ...s, assigned: true } : s,
    ),
  );
  notify();
}

export function updateSerial(email: string, serial: string): void {
  const trimmed = serial.trim();
  const participants = listParticipants();
  const prior = participants.find((p) => p.email.toLowerCase() === email.toLowerCase());
  const hadSerial = Boolean(prior?.serial?.trim());
  const priorCount = prior?.checkoutCount ?? 0;
  const isNewCheckout = Boolean(trimmed) && !hadSerial;
  const isFirstCheckout = isNewCheckout && priorCount === 0 && !prior?.onboardingSentAt;

  const updated = participants.map((p) => {
    if (p.email.toLowerCase() !== email.toLowerCase()) return p;
    const next: Participant = {
      ...p,
      serial: trimmed,
      lastReturnAt: undefined,
      status: "Active",
      manualStatusOverride: false,
      checkoutDate: new Date().toISOString(),
    };
    if (isNewCheckout) {
      next.checkoutCount = priorCount + 1;
      if (isFirstCheckout) {
        next.onboardingSentAt = new Date().toISOString();
        console.info(
          "[FieldCam onboarding] First checkout for",
          email,
          "— in Sheets mode this queues Slack + email with the 7-day plan + stats links.",
        );
      }
    }
    return next;
  });
  writeJSON(STORAGE_KEYS.participants, updated);

  if (trimmed) {
    ensureDevices();
    const devices = listDevices();
    const exists = devices.some((d) => d.serial.toLowerCase() === trimmed.toLowerCase());
    if (!exists) {
      const owner = updated.find((p) => p.email.toLowerCase() === email.toLowerCase());
      writeJSON(STORAGE_KEYS.devices, [
        ...devices,
        {
          serial: trimmed,
          hub: owner?.hub ?? "Phoenix",
          deskLocation: (owner?.hub ?? "Phoenix") === "Seattle" ? "Hub A" : "Black Box",
        },
      ]);
    }
  }

  notify();
}

/**
 * Self-service checkout from Availability. Enforces: requester on roster,
 * serial in inventory, one device per person, serial not held by someone else.
 */
export function checkoutDevice(email: string, serial: string): void {
  const trimmed = serial.trim();
  if (!trimmed) {
    throw new ValidationError("NO_SERIAL", "Pick a device to check out.");
  }

  ensureDevices();
  const devices = listDevices();
  const device = devices.find((d) => d.serial.toLowerCase() === trimmed.toLowerCase());
  if (!device) {
    throw new ValidationError("UNKNOWN_DEVICE", "That serial is not in hub inventory.");
  }

  const participants = listParticipants();
  const me = participants.find((p) => p.email.toLowerCase() === email.toLowerCase());
  if (!me) {
    throw new ValidationError(
      "NOT_ON_ROSTER",
      "You must be on the tournament roster to check out a device. Ask an admin to assign you first.",
    );
  }

  const mySerial = me.serial?.trim() ?? "";
  if (mySerial && mySerial.toLowerCase() !== trimmed.toLowerCase()) {
    throw new ValidationError(
      "ALREADY_HAS_DEVICE",
      `Return ${mySerial} before checking out another camera.`,
    );
  }

  const holder = participants.find(
    (p) => p.serial?.trim().toUpperCase() === trimmed.toUpperCase(),
  );
  if (holder && holder.email.toLowerCase() !== email.toLowerCase()) {
    throw new ValidationError(
      "DEVICE_TAKEN",
      `Already checked out to ${holder.name}.`,
    );
  }

  if (mySerial.toLowerCase() === trimmed.toLowerCase()) {
    return;
  }

  // updateSerial increments checkoutCount + marks first-timer onboarding locally
  updateSerial(email, trimmed);
}

/** Self-service return of the device currently held by this participant. */
export function returnDevice(email: string): void {
  const me = getParticipant(email);
  if (!me) {
    throw new ValidationError("NOT_ON_ROSTER", "You are not on the tournament roster.");
  }
  if (!me.serial?.trim()) {
    throw new ValidationError("NO_DEVICE", "You do not have a device checked out.");
  }
  recordReturn(email);
}

export function recordReturn(email: string): void {
  const participants = listParticipants();
  const now = new Date().toISOString();
  const updated = participants.map((p) =>
    p.email.toLowerCase() === email.toLowerCase()
      ? { ...p, serial: "", lastReturnAt: now, manualStatusOverride: false }
      : p,
  );
  writeJSON(STORAGE_KEYS.participants, updated);
  notify();
}

export function setStatus(email: string, status: "Active" | "Inactive"): void {
  const participants = listParticipants();
  const updated = participants.map((p) =>
    p.email.toLowerCase() === email.toLowerCase()
      ? { ...p, status, manualStatusOverride: true }
      : p,
  );
  writeJSON(STORAGE_KEYS.participants, updated);
  notify();
}

export function updateTeamProfile(
  teamId: string,
  updates: { name?: string; color?: string; logoUrl?: string | null; crest?: string },
  requesterEmail: string,
): void {
  const participant = getParticipant(requesterEmail);
  if (!participant || participant.teamId !== teamId) {
    throw new ValidationError(
      "NOT_ON_ROSTER",
      "Only members of this team can edit its name, color, or logo.",
    );
  }
  applyTeamUpdates(teamId, updates);
}

export function updateTeamProfileAsAdmin(
  teamId: string,
  updates: { name?: string; color?: string; logoUrl?: string | null; crest?: string },
): void {
  const teams = listTeams();
  if (!teams.some((t) => t.id === teamId)) {
    throw new ValidationError("BAD_TEAM", "Unknown team.");
  }
  applyTeamUpdates(teamId, updates);
}

function applyTeamUpdates(
  teamId: string,
  updates: { name?: string; color?: string; logoUrl?: string | null; crest?: string },
): void {
  const teams = listTeams();
  writeJSON(
    STORAGE_KEYS.teams,
    teams.map((t) => {
      if (t.id !== teamId) return t;
      const next = { ...t };
      if (updates.name !== undefined) next.name = updates.name;
      if (updates.color !== undefined) next.color = updates.color;
      if (updates.crest !== undefined) next.crest = updates.crest;
      if (updates.logoUrl === null) delete next.logoUrl;
      else if (updates.logoUrl !== undefined) next.logoUrl = updates.logoUrl;
      return next;
    }),
  );
  notify();
}

export function updateProfilePhoto(email: string, photoUrl: string): void {
  const participants = listParticipants();
  const updated = participants.map((p) =>
    p.email.toLowerCase() === email.toLowerCase() ? { ...p, photoUrl } : p,
  );
  writeJSON(STORAGE_KEYS.participants, updated);
  notify();
}

export function upsertActivity(record: ActivityRecord): void {
  const activity = listActivity();
  const idx = activity.findIndex(
    (r) => r.email.toLowerCase() === record.email.toLowerCase() && r.date === record.date,
  );
  const next = { ...record, email: record.email.trim().toLowerCase() };
  if (idx >= 0) activity[idx] = next;
  else activity.push(next);
  writeJSON(STORAGE_KEYS.activity, activity);
  notify();
}

export function deleteActivity(email: string, date: string): void {
  writeJSON(
    STORAGE_KEYS.activity,
    listActivity().filter(
      (r) => !(r.email.toLowerCase() === email.toLowerCase() && r.date === date),
    ),
  );
  notify();
}

export function upsertMatch(match: Match): void {
  const matches = listMatches();
  const idx = matches.findIndex((m) => m.id === match.id);
  if (idx >= 0) matches[idx] = match;
  else matches.push(match);
  writeJSON(STORAGE_KEYS.matches, matches);
  notify();
}

export function deleteMatch(matchId: string): void {
  writeJSON(
    STORAGE_KEYS.matches,
    listMatches().filter((m) => m.id !== matchId),
  );
  notify();
}

export function createMatch(input: {
  stage: MatchStage;
  group?: Match["group"];
  round?: number;
  homeTeamId: string | null;
  awayTeamId: string | null;
  startDate: string;
  endDate: string;
}): Match {
  const id = `M-${Date.now().toString(36)}`;
  const match: Match = {
    id,
    stage: input.stage,
    group: input.group,
    round: input.round,
    homeTeamId: input.homeTeamId,
    awayTeamId: input.awayTeamId,
    startDate: input.startDate,
    endDate: input.endDate,
    played: false,
    provisional: input.stage !== "group",
  };
  upsertMatch(match);
  return match;
}

export function createComplaint(email: string, body: string): Complaint {
  const participant = getParticipant(email);
  const signup = listFormSignups().find((s) => s.email.toLowerCase() === email.toLowerCase());
  const name = participant?.name ?? signup?.name ?? email;
  const complaint: Complaint = {
    id: `c-${Date.now().toString(36)}`,
    email: email.toLowerCase(),
    name,
    body: body.trim(),
    createdAt: new Date().toISOString(),
    status: "open",
  };
  if (!complaint.body) {
    throw new ValidationError("EMPTY", "Complaint text is required.");
  }
  const complaints = listComplaints();
  writeJSON(STORAGE_KEYS.complaints, [complaint, ...complaints]);

  const pending = listPendingSlackReminders();
  writeJSON(STORAGE_KEYS.pendingSlack, [...pending, ...buildComplaintSlackReminders(complaint)]);
  notify();
  return complaint;
}

export function resolveComplaint(id: string, adminNote?: string): void {
  writeJSON(
    STORAGE_KEYS.complaints,
    listComplaints().map((c) =>
      c.id === id ? { ...c, status: "resolved" as const, adminNote } : c,
    ),
  );
  notify();
}

export function resetDemoData(): void {
  Object.values(STORAGE_KEYS).forEach((k) => window.localStorage.removeItem(k));
  ensureSeeded();
  notify();
}
