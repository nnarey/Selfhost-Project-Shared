import { Link } from "react-router-dom";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import TeamCrest from "../components/TeamCrest";
import { useTournament } from "../context/TournamentContext";
import { getTeamById } from "../data/derived";
import type { Match } from "../data/types";

function formatDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const STAGE_LABEL: Record<Match["stage"], string> = {
  group: "Group Stage",
  semifinal: "Semifinal",
  final: "Final",
  thirdPlace: "3rd Place Match",
};

export default function Matches() {
  const { teams, matches } = useTournament();

  const sections: { title: string; items: Match[] }[] = [
    { title: "Group A", items: matches.filter((m) => m.stage === "group" && m.group === "A") },
    { title: "Group B", items: matches.filter((m) => m.stage === "group" && m.group === "B") },
    { title: "Knockouts", items: matches.filter((m) => m.stage !== "group") },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Full schedule"
        title="Matches"
        description="Every group-stage and knockout fixture. Click a match for the head-to-head score and contributor breakdown."
      />

      <div className="flex flex-col gap-8">
        {sections.map((section) => (
          <div key={section.title}>
            <h2 className="tournament-eyebrow mb-3">
              {section.title === "Knockouts" ? "Knockout stage" : `Group stage · ${section.title}`}
            </h2>
            <Card className="divide-y divide-[var(--color-border-soft)] overflow-hidden">
              {section.items.map((m) => {
                const home = getTeamById(teams, m.homeTeamId);
                const away = getTeamById(teams, m.awayTeamId);
                const accent = home?.color ?? away?.color ?? "var(--color-accent)";
                return (
                  <Link
                    key={m.id}
                    to={`/matches/${m.id}`}
                    className="match-row-accent flex flex-col gap-2 px-4 py-3 hover:bg-[var(--color-surface-2)] sm:flex-row sm:items-center sm:justify-between"
                    style={{ borderLeftColor: accent }}
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-24 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
                        {STAGE_LABEL[m.stage]}
                      </span>
                      <div className="flex items-center gap-2 text-sm">
                        {home ? (
                          <span className="crest-lift inline-flex">
                            <TeamCrest team={home} size="sm" />
                          </span>
                        ) : (
                          <span className="h-8 w-8" />
                        )}
                        <span className="text-[var(--color-text)]">{home?.name ?? "TBD"}</span>
                        <span className="text-[var(--color-text-faint)]">vs</span>
                        <span className="text-[var(--color-text)]">{away?.name ?? "TBD"}</span>
                        {away && (
                          <span className="crest-lift inline-flex">
                            <TeamCrest team={away} size="sm" />
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 pl-[calc(6rem+0.75rem)] text-xs sm:pl-0">
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
        ))}
      </div>
    </div>
  );
}
