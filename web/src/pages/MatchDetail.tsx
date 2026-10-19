import { Link, useParams } from "react-router-dom";
import Card from "../components/Card";
import ParticipantName from "../components/ParticipantName";
import StatusPill from "../components/StatusPill";
import TeamCrest from "../components/TeamCrest";
import { useTournament } from "../context/TournamentContext";
import { buildActivityByEmail, buildRosterByTeam, getTeamById } from "../data/derived";
import { sumActivityInWindow } from "../data/scoring";
import { computeMatchResult } from "../data/tournament";
import type { ActivityRecord, Participant, Team } from "../data/types";

function formatDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const STAGE_LABEL: Record<string, string> = {
  group: "Group Stage",
  semifinal: "Semifinal",
  final: "Final",
  thirdPlace: "3rd Place Match",
};

function ContributorTable({
  team,
  roster,
  activityByEmail,
  startDate,
  endDate,
  outcome,
  side,
}: {
  team: Team | undefined;
  roster: Participant[];
  activityByEmail: Map<string, ActivityRecord[]>;
  startDate: string;
  endDate: string;
  outcome: "home" | "away" | "draw" | null;
  side: "home" | "away";
}) {
  const rows = roster
    .map((p) => ({
      participant: p,
      windowed: sumActivityInWindow(activityByEmail.get(p.email) ?? [], startDate, endDate),
    }))
    .sort((a, b) => b.windowed.total - a.windowed.total);

  const won = outcome === side;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[var(--color-border-soft)] px-4 py-3">
        {team && <TeamCrest team={team} size="sm" />}
        <div>
          <p className="font-semibold text-[var(--color-text)]">{team?.name ?? "TBD"}</p>
          {outcome && (
            <p
              className={`text-xs font-medium ${
                won ? "text-[var(--color-pitch)]" : outcome === "draw" ? "text-[var(--color-text-faint)]" : "text-[var(--color-danger)]"
              }`}
            >
              {won ? "Won" : outcome === "draw" ? "Drew" : "Lost"}
            </p>
          )}
        </div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-2 py-2 font-medium">Status</th>
            <th className="px-4 py-2 text-right font-medium">Pts in window</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ participant, windowed }) => (
            <tr key={participant.email} className="border-t border-[var(--color-border-soft)]">
              <td className="px-4 py-2">
                <ParticipantName name={participant.name} photoUrl={participant.photoUrl} />
              </td>
              <td className="px-2 py-2">
                <StatusPill status={participant.status} />
              </td>
              <td className="px-4 py-2 text-right font-semibold text-[var(--color-text)]">
                {windowed.total.toFixed(0)}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-6 text-center text-[var(--color-text-faint)]">
                No roster assigned yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

export default function MatchDetail() {
  const { matchId } = useParams();
  const { teams, participants, activity, matches } = useTournament();
  const match = matches.find((m) => m.id === matchId);
  const rosterByTeam = buildRosterByTeam(participants);
  const activityByEmail = buildActivityByEmail(activity);

  if (!match) {
    return (
      <Card className="p-8 text-center text-[var(--color-text-muted)]">
        Match not found. <Link to="/matches" className="text-[var(--color-accent)] underline">Back to matches</Link>
      </Card>
    );
  }

  const homeTeam = getTeamById(teams, match.homeTeamId);
  const awayTeam = getTeamById(teams, match.awayTeamId);
  const result = computeMatchResult(match, rosterByTeam, activityByEmail);

  return (
    <div>
      <Link to="/matches" className="mb-4 inline-block text-sm text-[var(--color-text-faint)] hover:text-[var(--color-accent)]">
        ← All matches
      </Link>

      <Card className="p-6">
        <div className="flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-text-faint)]">
          {STAGE_LABEL[match.stage]} {match.group ? `· Group ${match.group}` : ""}
        </div>
        <p className="mt-1 text-center text-xs text-[var(--color-text-faint)]">
          {formatDate(match.startDate)} – {formatDate(match.endDate)}
        </p>

        <div className="mt-4 flex items-center justify-center gap-6 sm:gap-12">
          <div className="flex flex-col items-center gap-2">
            {homeTeam ? <TeamCrest team={homeTeam} size="lg" /> : <div className="h-16 w-16 rounded-xl border border-dashed border-[var(--color-border)]" />}
            <p className="font-semibold text-[var(--color-text)]">{homeTeam?.name ?? "TBD"}</p>
          </div>

          <div className="text-center">
            {match.played ? (
              <p className="text-3xl font-black text-[var(--color-text)]">
                {result.homeScore.toFixed(0)} – {result.awayScore.toFixed(0)}
              </p>
            ) : (
              <p className="rounded-full bg-[var(--color-info)]/15 px-3 py-1 text-xs font-semibold text-[var(--color-info)]">
                Upcoming
              </p>
            )}
            <p className="mt-1 text-[11px] text-[var(--color-text-faint)]">Match window activity score</p>
          </div>

          <div className="flex flex-col items-center gap-2">
            {awayTeam ? <TeamCrest team={awayTeam} size="lg" /> : <div className="h-16 w-16 rounded-xl border border-dashed border-[var(--color-border)]" />}
            <p className="font-semibold text-[var(--color-text)]">{awayTeam?.name ?? "TBD"}</p>
          </div>
        </div>

        {match.stage !== "group" && (
          <p className="mt-4 text-center text-xs text-[var(--color-text-faint)]">
            Knockout rule: no draws — exact ties are broken by most #selfhost reports in the match window.
          </p>
        )}
      </Card>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <ContributorTable
          team={homeTeam}
          roster={rosterByTeam.get(match.homeTeamId ?? "") ?? []}
          activityByEmail={activityByEmail}
          startDate={match.startDate}
          endDate={match.endDate}
          outcome={result.outcome}
          side="home"
        />
        <ContributorTable
          team={awayTeam}
          roster={rosterByTeam.get(match.awayTeamId ?? "") ?? []}
          activityByEmail={activityByEmail}
          startDate={match.startDate}
          endDate={match.endDate}
          outcome={result.outcome}
          side="away"
        />
      </div>
    </div>
  );
}
