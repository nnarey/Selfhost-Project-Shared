import { Link } from "react-router-dom";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import TeamCrest from "../components/TeamCrest";
import { useTournament } from "../context/TournamentContext";
import { buildActivityByEmail, buildRosterByTeam } from "../data/derived";
import { computePersonScore } from "../data/scoring";

export default function Teams() {
  const { teams, participants, activity } = useTournament();
  const rosterByTeam = buildRosterByTeam(participants);
  const activityByEmail = buildActivityByEmail(activity);
  const now = new Date().toISOString();

  const teamScores = teams.map((team) => {
    const roster = rosterByTeam.get(team.id) ?? [];
    const total = roster.reduce((sum, p) => {
      const breakdown = computePersonScore(p, activityByEmail.get(p.email) ?? [], now);
      return sum + breakdown.total;
    }, 0);
    return { team, roster, total };
  });

  return (
    <div>
      <PageHeader
        eyebrow="8 teams · 2 groups"
        title="Teams"
        description="Preset names and colors — any roster member can rename their team and pick a new color from the team page."
      />

      {["A", "B"].map((group) => (
        <section key={group} className="mb-8">
          <h2 className="tournament-eyebrow mb-3">Group {group}</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {teamScores
              .filter((t) => t.team.group === group)
              .sort((a, b) => b.total - a.total)
              .map(({ team, roster, total }) => (
                <Link key={team.id} to={`/teams/${team.id}`} className="crest-lift block">
                  <Card
                    className="h-full p-5 transition-colors hover:border-[var(--color-accent)]/50"
                    style={{ borderTop: `3px solid ${team.color}` }}
                  >
                    <div className="flex items-center gap-3">
                      <TeamCrest team={team} size="lg" />
                      <div>
                        <p className="font-bold text-[var(--color-text)]">{team.name}</p>
                        <p className="text-xs text-[var(--color-text-faint)]">{roster.length} members</p>
                      </div>
                    </div>
                    <div className="mt-4 flex items-center justify-between border-t border-[var(--color-border-soft)] pt-3">
                      <span className="text-xs text-[var(--color-text-faint)]">Total activity score</span>
                      <span className="text-lg font-bold text-[var(--color-accent)]">{total.toFixed(0)}</span>
                    </div>
                  </Card>
                </Link>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
