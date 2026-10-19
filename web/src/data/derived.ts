import type { ActivityRecord, Participant, Team } from "./types";

export function buildRosterByTeam(participants: Participant[]): Map<string, Participant[]> {
  const map = new Map<string, Participant[]>();
  for (const p of participants) {
    if (!p.teamId) continue;
    const list = map.get(p.teamId) ?? [];
    list.push(p);
    map.set(p.teamId, list);
  }
  return map;
}

export function buildActivityByEmail(activity: ActivityRecord[]): Map<string, ActivityRecord[]> {
  const map = new Map<string, ActivityRecord[]>();
  for (const r of activity) {
    const list = map.get(r.email) ?? [];
    list.push(r);
    map.set(r.email, list);
  }
  return map;
}

export function getTeamById(teams: Team[], teamId: string | null | undefined): Team | undefined {
  if (!teamId) return undefined;
  return teams.find((t) => t.id === teamId);
}
