import { Link } from "react-router-dom";
import type { BracketData } from "../data/tournament";
import type { Team } from "../data/types";
import TeamCrest from "./TeamCrest";

function TeamRow({ team }: { team: Team | null }) {
  if (!team) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-faint)]">
        <div className="h-8 w-8 rounded-xl border border-dashed border-[var(--color-border)]" />
        TBD
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm">
      <TeamCrest team={team} size="sm" />
      <span className="font-medium text-[var(--color-text)]">{team.name}</span>
    </div>
  );
}

function BracketCard({
  title,
  home,
  away,
  provisional,
  matchId,
}: {
  title: string;
  home: Team | null;
  away: Team | null;
  provisional?: boolean;
  matchId?: string;
}) {
  const content = (
    <div className="w-56 overflow-hidden rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-accent)]/50">
      <div className="flex items-center justify-between border-b border-[var(--color-border-soft)] px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
          {title}
        </span>
        {provisional && (
          <span className="rounded-full bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
            Provisional
          </span>
        )}
      </div>
      <TeamRow team={home} />
      <div className="border-t border-[var(--color-border-soft)]" />
      <TeamRow team={away} />
    </div>
  );

  if (matchId) {
    return (
      <Link to={`/matches/${matchId}`} className="block">
        {content}
      </Link>
    );
  }
  return content;
}

export default function BracketView({ bracket }: { bracket: BracketData }) {
  return (
    <div className="scrollbar-thin overflow-x-auto pb-4">
      <div className="flex min-w-[820px] items-center justify-center gap-10 px-4 py-6">
        <div className="flex flex-col gap-10">
          <BracketCard
            title="Semifinal 1"
            home={bracket.semis[0].home}
            away={bracket.semis[0].away}
            provisional={bracket.semis[0].provisional}
            matchId={bracket.semis[0].match?.id}
          />
          <BracketCard
            title="Semifinal 2"
            home={bracket.semis[1].home}
            away={bracket.semis[1].away}
            provisional={bracket.semis[1].provisional}
            matchId={bracket.semis[1].match?.id}
          />
        </div>

        <div className="flex flex-col items-center gap-3">
          <span className="text-3xl" aria-hidden>
            🏆
          </span>
          <BracketCard
            title="Final"
            home={bracket.final.home}
            away={bracket.final.away}
            provisional
            matchId={bracket.final.match?.id}
          />
          <div className="mt-6">
            <BracketCard
              title="3rd Place"
              home={bracket.thirdPlace.home}
              away={bracket.thirdPlace.away}
              provisional
              matchId={bracket.thirdPlace.match?.id}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
