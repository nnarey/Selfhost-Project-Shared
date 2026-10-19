import { DEMO_ACTIVITY_WINDOW_DAYS } from "../config/scoring.config";
import { buildDeviceInventory } from "./devices";
import {
  chance,
  isoDateDaysFromNow,
  isoTimestampDaysFromNow,
  isoTimestampHoursFromNow,
  mulberry32,
  randFloat,
  randInt,
} from "./random";
import type { ActivityRecord, Department, Device, Hub, Match, Participant, Role, Team } from "./types";
import { DEPARTMENTS, ROLES } from "./types";

export const TEAM_PRESETS: Omit<Team, "id">[] = [
  { defaultName: "Sync Squad", name: "Sync Squad", color: "#3b82f6", crest: "⚡", group: "A" },
  { defaultName: "Battery FC", name: "Battery FC", color: "#f2782f", crest: "🔋", group: "A" },
  { defaultName: "Phoenix Pulse", name: "Phoenix Pulse", color: "#e5484d", crest: "🌵", group: "A" },
  { defaultName: "Dock United", name: "Dock United", color: "#2f9e6e", crest: "🛡️", group: "A" },
  { defaultName: "Stream City", name: "Stream City", color: "#a855f7", crest: "📡", group: "B" },
  { defaultName: "GNSS Rangers", name: "GNSS Rangers", color: "#0ea5b7", crest: "📍", group: "B" },
  { defaultName: "Haptic Heat", name: "Haptic Heat", color: "#f2b705", crest: "🔥", group: "B" },
  { defaultName: "Northline Eleven", name: "Northline Eleven", color: "#4c9a5f", crest: "🎬", group: "B" },
];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function buildTeams(): Team[] {
  return TEAM_PRESETS.map((preset) => ({ ...preset, id: slugify(preset.defaultName) }));
}

const ROLE_CYCLE: Role[] = ROLES;
const DEPT_CYCLE: Department[] = DEPARTMENTS;
const HUB_CYCLE: Hub[] = ["Phoenix", "Seattle"];

interface SeedResult {
  participants: Participant[];
  activity: ActivityRecord[];
  matches: Match[];
  devices: Device[];
}

/**
 * Generates a believable mid-tournament demo dataset:
 * - 8 teams x 4 rostered participants (32 total) + 4 unassigned sign-ups
 *   sitting in the admin queue.
 * - ~2 weeks of daily activity per rostered, active participant.
 * - A couple of participants deliberately seeded with stale/no recordings
 *   (24h no-recordings rule already tripped) or a recent recording that
 *   still keeps them Active, to exercise those UI states.
 * - Group-stage round 1 & 2 fixtures in the past (played), round 3 fixtures
 *   in the near future (upcoming) — giving the "some matches complete, some
 *   still to come" mid-tournament feel. Knockout fixtures are unscheduled.
 *
 * Dates are generated relative to `new Date()` at seed time so the demo
 * always looks current. Re-run by clearing storage or using the admin
 * "reset demo data" action.
 */
export function generateSeed(teams: Team[]): SeedResult {
  const rand = mulberry32(20260701);
  const now = new Date();

  const devices = buildDeviceInventory();
  const nextIndexByHub: Record<Hub, number> = { Phoenix: 0, Seattle: 0 };
  const devicesByHub: Record<Hub, Device[]> = {
    Phoenix: devices.filter((d) => d.hub === "Phoenix"),
    Seattle: devices.filter((d) => d.hub === "Seattle"),
  };

  const participants: Participant[] = [];
  const activity: ActivityRecord[] = [];

  let personCounter = 1;

  const makeParticipant = (teamId: string | undefined): Participant => {
    const n = personCounter++;
    const hub = HUB_CYCLE[n % HUB_CYCLE.length];
    const role = ROLE_CYCLE[n % ROLE_CYCLE.length];
    const department = DEPT_CYCLE[n % DEPT_CYCLE.length];
    const enrolledDaysAgo = randInt(rand, 16, 22);

    let serial = "";
    if (teamId) {
      const pool = devicesByHub[hub];
      const idx = nextIndexByHub[hub]++;
      serial = pool[idx]?.serial ?? `FC-${10000 + n}`;
    }

    return {
      email: `participant${n}@northline.example`,
      name: `Participant ${n}`,
      hub,
      role,
      department,
      serial,
      teamId,
      status: "Active",
      enrolledAt: isoTimestampDaysFromNow(-enrolledDaysAgo, now),
      checkoutDate: isoTimestampDaysFromNow(-enrolledDaysAgo + 1, now),
      // Seeded holders already "checked out" once — avoid re-firing onboarding in demos.
      checkoutCount: serial ? 1 : 0,
      onboardingSentAt: serial
        ? isoTimestampDaysFromNow(-enrolledDaysAgo + 1, now)
        : undefined,
    };
  };

  // Rostered participants — 4 per team.
  for (const team of teams) {
    for (let i = 0; i < 4; i++) {
      participants.push(makeParticipant(team.id));
    }
  }

  // Unassigned sign-ups sitting in the admin queue.
  for (let i = 0; i < 4; i++) {
    participants.push(makeParticipant(undefined));
  }

  // Special-case a few participants to exercise inactive states. `lastReturnAt`
  // here is just reused as a convenient cutoff marker for the activity
  // generator below (no recordings are generated past that date) — actual
  // status is auto-recomputed from recordings on every read via
  // `computeAutoStatus`, so these `status` values are just the initial guess.
  // #1: long inactive — hasn't recorded anything in 3 days.
  const longInactive = participants[5];
  longInactive.serial = "";
  longInactive.lastReturnAt = isoTimestampDaysFromNow(-3, now);
  longInactive.status = "Inactive";

  // #2: just tipped into inactive — last recording ~26 hours ago.
  const justInactive = participants[13];
  justInactive.serial = "";
  justInactive.lastReturnAt = isoTimestampHoursFromNow(-26, now);
  justInactive.status = "Inactive";

  // #3: in the grace window — last recording ~10 hours ago, still Active.
  const inGraceWindow = participants[21];
  inGraceWindow.serial = "";
  inGraceWindow.lastReturnAt = isoTimestampHoursFromNow(-10, now);
  inGraceWindow.status = "Active";

  const specialInactiveEmails = new Set([longInactive.email, justInactive.email]);

  // Activity generation for rostered, currently-or-recently-active participants.
  const rosteredActive = participants.filter((p) => p.teamId);
  rosteredActive.forEach((p, idx) => {
    const isStar = idx % 8 === 0; // one star performer per team on average
    const cutoffDate = specialInactiveEmails.has(p.email) && p.lastReturnAt
      ? p.lastReturnAt.slice(0, 10)
      : isoDateDaysFromNow(0, now);

    for (let d = DEMO_ACTIVITY_WINDOW_DAYS - 1; d >= 0; d--) {
      const date = isoDateDaysFromNow(-d, now);
      if (date > cutoffDate) continue;

      const recentDay = d <= 6;
      const activityChance = isStar ? 0.95 : recentDay ? 0.78 : 0.62;
      if (!chance(rand, activityChance)) continue;

      const recordings = randInt(rand, 1, isStar ? 5 : 4);
      const hours = randFloat(rand, 0.5, isStar ? 7.5 : 6, 2);
      const uploads = randInt(rand, 0, isStar ? 4 : 3);
      const livestreams = chance(rand, isStar ? 0.35 : 0.12) ? 1 : 0;
      const reports = chance(rand, isStar ? 0.4 : 0.2) ? 1 : 0;

      activity.push({ email: p.email, date, recordings, hours, uploads, livestreams, reports });
    }
  });

  // --- Group-stage round robin (4 teams per group, 3 rounds, 2 matches/round) ---
  const matches: Match[] = [];
  const roundRobinPairs: [number, number][][] = [
    [[0, 1], [2, 3]],
    [[0, 2], [3, 1]],
    [[0, 3], [1, 2]],
  ];
  // Round windows: rounds 1-2 in the past (played), round 3 upcoming.
  const roundOffsets: [number, number][] = [
    [-13, -12],
    [-7, -6],
    [2, 3],
  ];

  for (const group of ["A", "B"] as const) {
    const groupTeams = teams.filter((t) => t.group === group);
    roundRobinPairs.forEach((pairs, roundIdx) => {
      const [startOffset, endOffset] = roundOffsets[roundIdx];
      const startDate = isoDateDaysFromNow(startOffset, now);
      const endDate = isoDateDaysFromNow(endOffset, now);
      const played = endOffset < 0;
      pairs.forEach(([homeIdx, awayIdx], matchIdx) => {
        matches.push({
          id: `${group}-R${roundIdx + 1}-M${matchIdx + 1}`,
          stage: "group",
          group,
          round: roundIdx + 1,
          homeTeamId: groupTeams[homeIdx].id,
          awayTeamId: groupTeams[awayIdx].id,
          startDate,
          endDate,
          played,
        });
      });
    });
  }

  // --- Knockouts: unscheduled placeholders, teams TBD until group stage completes ---
  matches.push({
    id: "SF1",
    stage: "semifinal",
    homeTeamId: null,
    awayTeamId: null,
    startDate: isoDateDaysFromNow(9, now),
    endDate: isoDateDaysFromNow(10, now),
    played: false,
    provisional: true,
  });
  matches.push({
    id: "SF2",
    stage: "semifinal",
    homeTeamId: null,
    awayTeamId: null,
    startDate: isoDateDaysFromNow(9, now),
    endDate: isoDateDaysFromNow(10, now),
    played: false,
    provisional: true,
  });
  matches.push({
    id: "FINAL",
    stage: "final",
    homeTeamId: null,
    awayTeamId: null,
    startDate: isoDateDaysFromNow(14, now),
    endDate: isoDateDaysFromNow(15, now),
    played: false,
    provisional: true,
  });
  matches.push({
    id: "THIRD",
    stage: "thirdPlace",
    homeTeamId: null,
    awayTeamId: null,
    startDate: isoDateDaysFromNow(14, now),
    endDate: isoDateDaysFromNow(15, now),
    played: false,
    provisional: true,
  });

  return { participants, activity, matches, devices };
}
