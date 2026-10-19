import type { Team } from "../data/types";

const SIZES = {
  sm: "h-8 w-8 text-base",
  md: "h-11 w-11 text-xl",
  lg: "h-16 w-16 text-3xl",
};

export default function TeamCrest({
  team,
  size = "md",
}: {
  team: Pick<Team, "color" | "crest" | "logoUrl">;
  size?: keyof typeof SIZES;
}) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl border ${SIZES[size]}`}
      style={{
        backgroundColor: `${team.color}22`,
        borderColor: `${team.color}55`,
      }}
    >
      {team.logoUrl ? (
        <img src={team.logoUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span>{team.crest}</span>
      )}
    </div>
  );
}
