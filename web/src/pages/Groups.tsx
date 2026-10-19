import { Link } from "react-router-dom";
import Card from "../components/Card";
import GroupTable from "../components/GroupTable";
import PageHeader from "../components/PageHeader";
import TeamCrest from "../components/TeamCrest";
import { useTournament } from "../context/TournamentContext";
import { buildActivityByEmail, buildRosterByTeam, getTeamById } from "../data/derived";
import { computeGroupStandings } from "../data/tournament";

function formatDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function Groups() {
  const { teams, participants, activity, matches } = useTournament();
  const rosterByTeam = buildRosterByTeam(participants);
  const activityByEmail = buildActivityByEmail(activity);

  const standingsA = computeGroupStandings("A", teams, matches, rosterByTeam, activityByEmail);
  const standingsB = computeGroupStandings("B", teams, matches, rosterByTeam, activityByEmail);

  return (
    <div>
      <PageHeader
        eyebrow="Group stage"
        title="Standings"
        description="Round robin — each team plays the other 3 in its group. Top 2 advance to the semifinals. Ranked by match points, then total activity score, then head-to-head."
      />

      <div className="grid gap-8 lg:grid-cols-2">
        {[
          { group: "A" as const, rows: standingsA },
          { group: "B" as const, rows: standingsB },
        ].map(({ group, rows }) => {
          const groupMatches = matches.filter((m) => m.stage === "group" && m.group === group);
          return (
            <div key={group}>
              <p className="tournament-eyebrow mb-2">Group {group}</p>
              <GroupTable title={`Group ${group}`} rows={rows} />
              <Card className="mt-4 divide-y divide-[var(--color-border-soft)] overflow-hidden">
                {groupMatches.map((m) => {
                  const home = getTeamById(teams, m.homeTeamId);
                  const away = getTeamById(teams, m.awayTeamId);
                  return (
                    <Link
                      key={m.id}
                      to={`/matches/${m.id}`}
                      className="match-row-accent flex items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--color-surface-2)]"
                      style={{ borderLeftColor: home?.color ?? "var(--color-accent)" }}
                    >
                      <div className="flex min-w-0 items-center gap-2 text-sm">
                        {home && (
                          <span className="crest-lift inline-flex">
                            <TeamCrest team={home} size="sm" />
                          </span>
                        )}
                        <span className="truncate text-[var(--color-text)]">{home?.name ?? "TBD"}</span>
                        <span className="text-[var(--color-text-faint)]">vs</span>
                        <span className="truncate text-[var(--color-text)]">{away?.name ?? "TBD"}</span>
                        {away && (
                          <span className="crest-lift inline-flex">
                            <TeamCrest team={away} size="sm" />
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-xs">
                        <span className="text-[var(--color-text-faint)]">
                          {formatDate(m.startDate)}–{formatDate(m.endDate)}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 font-medium ${
                            m.played
                              ? "bg-[var(--color-pitch)]/15 text-[var(--color-pitch)]"
                              : "bg-[var(--color-info)]/15 text-[var(--color-info)]"
                          }`}
                        >
                          {m.played ? "Final" : "Upcoming"}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}
