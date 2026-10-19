import { Link } from "react-router-dom";
import type { StandingsRow } from "../data/tournament";
import TeamCrest from "./TeamCrest";

export default function GroupTable({ title, rows }: { title: string; rows: StandingsRow[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)]">
      <div className="border-b border-[var(--color-border-soft)] px-4 py-3">
        <h3 className="text-sm font-semibold text-[var(--color-text)]">{title}</h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
            <th className="px-4 py-2 font-medium">#</th>
            <th className="px-2 py-2 font-medium">Team</th>
            <th className="px-2 py-2 text-center font-medium">P</th>
            <th className="px-2 py-2 text-center font-medium">W</th>
            <th className="px-2 py-2 text-center font-medium">D</th>
            <th className="px-2 py-2 text-center font-medium">L</th>
            <th className="px-2 py-2 text-center font-medium">Pts</th>
            <th className="px-4 py-2 text-right font-medium">Activity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const qualifies = idx < 2;
            return (
              <tr
                key={row.team.id}
                className={`border-t border-[var(--color-border-soft)] ${
                  qualifies ? "bg-[var(--color-pitch)]/[0.06]" : ""
                }`}
              >
                <td className="px-4 py-2.5 font-medium text-[var(--color-text-faint)]">{idx + 1}</td>
                <td className="px-2 py-2.5">
                  <Link to={`/teams/${row.team.id}`} className="crest-lift flex items-center gap-2 hover:opacity-80">
                    <TeamCrest team={row.team} size="sm" />
                    <span className="font-medium text-[var(--color-text)]">{row.team.name}</span>
                  </Link>
                </td>
                <td className="px-2 py-2.5 text-center text-[var(--color-text-muted)]">{row.played}</td>
                <td className="px-2 py-2.5 text-center text-[var(--color-text-muted)]">{row.won}</td>
                <td className="px-2 py-2.5 text-center text-[var(--color-text-muted)]">{row.drawn}</td>
                <td className="px-2 py-2.5 text-center text-[var(--color-text-muted)]">{row.lost}</td>
                <td className="px-2 py-2.5 text-center font-bold text-[var(--color-text)]">{row.points}</td>
                <td className="px-4 py-2.5 text-right text-[var(--color-text-muted)]">
                  {row.activityScore.toFixed(0)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="border-t border-[var(--color-border-soft)] px-4 py-2 text-[11px] text-[var(--color-text-faint)]">
        <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--color-pitch)] align-middle" /> Top 2
        advance to the semifinals
      </div>
    </div>
  );
}
