import { MATCH_POINTS } from "../config/scoring.config";
import { sumActivityInWindow } from "./scoring";
import type { ActivityRecord, Group, Match, Participant, Team } from "./types";

export interface MatchResult {
  match: Match;
  homeScore: number;
  awayScore: number;
  /** "home" | "away" | "draw" | null (not played yet) */
  outcome: "home" | "away" | "draw" | null;
  homePoints: number;
  awayPoints: number;
}

/**
 * Computes a single match's result from activity within its date window.
 * Group-stage matches allow draws on an exact tie. Knockout matches do not:
 * an exact tie is broken by whichever team logged more #selfhost reports in
 * the match window.
 */
export function computeMatchResult(
  match: Match,
  rosterByTeam: Map<string, Participant[]>,
  activityByEmail: Map<string, ActivityRecord[]>,
): MatchResult {
  const teamScore = (teamId: string | null) => {
    if (!teamId) return { total: 0, totals: { reports: 0 } };
    const roster = rosterByTeam.get(teamId) ?? [];
    let total = 0;
    let reports = 0;
    for (const p of roster) {
      const records = activityByEmail.get(p.email) ?? [];
      const windowed = sumActivityInWindow(records, match.startDate, match.endDate);
      total += windowed.total;
      reports += windowed.totals.reports;
    }
    return { total, totals: { reports } };
  };

  const home = teamScore(match.homeTeamId);
  const away = teamScore(match.awayTeamId);

  if (!match.played) {
    return {
      match,
      homeScore: home.total,
      awayScore: away.total,
      outcome: null,
      homePoints: 0,
      awayPoints: 0,
    };
  }

  const allowDraw = match.stage === "group";
  let outcome: MatchResult["outcome"];

  if (home.total === away.total) {
    if (allowDraw) {
      outcome = "draw";
    } else {
      // Knockout tiebreak: most #selfhost reports in the window wins.
      outcome = home.totals.reports >= away.totals.reports ? "home" : "away";
    }
  } else {
    outcome = home.total > away.total ? "home" : "away";
  }

  const homePoints =
    outcome === "home" ? MATCH_POINTS.win : outcome === "draw" ? MATCH_POINTS.draw : MATCH_POINTS.loss;
  const awayPoints =
    outcome === "away" ? MATCH_POINTS.win : outcome === "draw" ? MATCH_POINTS.draw : MATCH_POINTS.loss;

  return { match, homeScore: home.total, awayScore: away.total, outcome, homePoints, awayPoints };
}

export interface StandingsRow {
  team: Team;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  activityScore: number;
}

/**
 * Group table sorted by: match points -> total activity score -> head-to-head.
 * Head-to-head is only consulted when two teams are still tied after the
 * first two criteria (simple pairwise check, sufficient for 4-team groups).
 */
export function computeGroupStandings(
  group: Group,
  teams: Team[],
  matches: Match[],
  rosterByTeam: Map<string, Participant[]>,
  activityByEmail: Map<string, ActivityRecord[]>,
): StandingsRow[] {
  const groupTeams = teams.filter((t) => t.group === group);
  const groupMatches = matches.filter((m) => m.stage === "group" && m.group === group && m.played);

  const rows = new Map<string, StandingsRow>();
  for (const team of groupTeams) {
    rows.set(team.id, { team, played: 0, won: 0, drawn: 0, lost: 0, points: 0, activityScore: 0 });
  }

  const headToHead = new Map<string, MatchResult>(); // key: `${teamA}|${teamB}` both directions

  for (const match of groupMatches) {
    const result = computeMatchResult(match, rosterByTeam, activityByEmail);
    if (!match.homeTeamId || !match.awayTeamId) continue;

    const home = rows.get(match.homeTeamId);
    const away = rows.get(match.awayTeamId);
    if (!home || !away) continue;

    home.played += 1;
    away.played += 1;
    home.points += result.homePoints;
    away.points += result.awayPoints;
    home.activityScore += result.homeScore;
    away.activityScore += result.awayScore;

    if (result.outcome === "home") {
      home.won += 1;
      away.lost += 1;
    } else if (result.outcome === "away") {
      away.won += 1;
      home.lost += 1;
    } else if (result.outcome === "draw") {
      home.drawn += 1;
      away.drawn += 1;
    }

    headToHead.set(`${match.homeTeamId}|${match.awayTeamId}`, result);
    headToHead.set(`${match.awayTeamId}|${match.homeTeamId}`, result);
  }

  const headToHeadCompare = (a: StandingsRow, b: StandingsRow): number => {
    const result = headToHead.get(`${a.team.id}|${b.team.id}`);
    if (!result) return 0;
    const aIsHome = result.match.homeTeamId === a.team.id;
    const aPts = aIsHome ? result.homePoints : result.awayPoints;
    const bPts = aIsHome ? result.awayPoints : result.homePoints;
    return bPts - aPts;
  };

  return [...rows.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.activityScore !== a.activityScore) return b.activityScore - a.activityScore;
    return headToHeadCompare(a, b);
  });
}

export interface BracketData {
  semis: { id: string; home: Team | null; away: Team | null; provisional: boolean; match?: Match }[];
  final: { home: Team | null; away: Team | null; match?: Match };
  thirdPlace: { home: Team | null; away: Team | null; match?: Match };
}

/**
 * Builds the knockout bracket from current (possibly partial) group
 * standings. Because the demo dataset always has at least one unplayed
 * group-stage round, semifinal matchups are marked `provisional` — they
 * reflect standings-to-date and may shift once the final round completes.
 */
export function computeBracket(
  teams: Team[],
  matches: Match[],
  rosterByTeam: Map<string, Participant[]>,
  activityByEmail: Map<string, ActivityRecord[]>,
): BracketData {
  const standingsA = computeGroupStandings("A", teams, matches, rosterByTeam, activityByEmail);
  const standingsB = computeGroupStandings("B", teams, matches, rosterByTeam, activityByEmail);

  const groupStageComplete =
    standingsA.every((r) => r.played === 3) && standingsB.every((r) => r.played === 3);

  const semiMatches = matches.filter((m) => m.stage === "semifinal");
  const finalMatch = matches.find((m) => m.stage === "final");
  const thirdPlaceMatch = matches.find((m) => m.stage === "thirdPlace");

  const semis = [
    {
      id: "SF1",
      home: standingsA[0]?.team ?? null,
      away: standingsB[1]?.team ?? null,
      provisional: !groupStageComplete,
      match: semiMatches[0],
    },
    {
      id: "SF2",
      home: standingsB[0]?.team ?? null,
      away: standingsA[1]?.team ?? null,
      provisional: !groupStageComplete,
      match: semiMatches[1],
    },
  ];

  return {
    semis,
    final: { home: null, away: null, match: finalMatch },
    thirdPlace: { home: null, away: null, match: thirdPlaceMatch },
  };
}
