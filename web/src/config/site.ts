/**
 * Public URL of the self-host web app (static site or local).
 * Used in onboarding / reminder copy so people can open My Profile + Leaderboard.
 */
export const STATS_SITE_URL = (
  (import.meta.env.VITE_STATS_SITE_URL as string | undefined) ||
  "https://fieldcam.example"
).replace(/\/$/, "");

export function statsMyProfileUrl(): string {
  return `${STATS_SITE_URL}/#/my-profile`;
}

/** @deprecated use statsMyProfileUrl */
export function statsMyStatsUrl(): string {
  return statsMyProfileUrl();
}

export function statsLeaderboardUrl(): string {
  return `${STATS_SITE_URL}/#/leaderboard`;
}

export function statsCheckOutUrl(): string {
  return `${STATS_SITE_URL}/#/devices`;
}
