import { Link } from "react-router-dom";
import TeamCrest from "./TeamCrest";
import type { Team } from "../data/types";

export default function TeamPennants({ teams }: { teams: Team[] }) {
  const ordered = [...teams].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

  return (
    <div className="w-full overflow-x-auto scrollbar-thin">
      <div className="flex min-w-max items-end justify-center gap-2 px-1 pb-1 pt-2 sm:gap-3">
        {ordered.map((team) => (
          <Link
            key={team.id}
            to={`/teams/${team.id}`}
            className="pennant group flex w-[4.5rem] flex-col items-center sm:w-20"
            title={team.name}
          >
            <div
              className="relative flex w-full flex-col items-center rounded-t-md px-1.5 pb-3 pt-2 shadow-lg"
              style={{
                background: `linear-gradient(180deg, ${team.color}dd 0%, ${team.color}66 70%, transparent 100%)`,
                clipPath: "polygon(0 0, 100% 0, 100% 78%, 50% 100%, 0 78%)",
                minHeight: "5.5rem",
              }}
            >
              <div className="crest-lift">
                <TeamCrest team={team} size="sm" />
              </div>
              <span className="mt-1 max-w-full truncate px-0.5 text-center text-[9px] font-bold uppercase tracking-wide text-[var(--color-text)]/95 drop-shadow-sm sm:text-[10px]">
                {team.name}
              </span>
            </div>
            <span className="mt-1 text-[9px] font-semibold uppercase tracking-widest text-[var(--color-text-faint)]">
              {team.group}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
