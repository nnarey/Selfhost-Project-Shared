/** Sentinel teamId for signed-up people not on a competing World Cup team. */
export const WAITLIST_TEAM_ID = "waitlist";

export function isWaitlisted(teamId: string | undefined): boolean {
  return !teamId || teamId === WAITLIST_TEAM_ID;
}

export function isCompetingTeam(teamId: string | undefined): boolean {
  return Boolean(teamId) && teamId !== WAITLIST_TEAM_ID;
}
