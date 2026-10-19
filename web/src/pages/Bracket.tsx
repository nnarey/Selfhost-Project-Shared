import BracketView from "../components/BracketView";
import PageHeader from "../components/PageHeader";
import { useTournament } from "../context/TournamentContext";
import { buildActivityByEmail, buildRosterByTeam } from "../data/derived";
import { computeBracket } from "../data/tournament";

export default function Bracket() {
  const { teams, participants, activity, matches } = useTournament();
  const rosterByTeam = buildRosterByTeam(participants);
  const activityByEmail = buildActivityByEmail(activity);
  const bracket = computeBracket(teams, matches, rosterByTeam, activityByEmail);

  return (
    <div>
      <PageHeader
        eyebrow="Knockout stage"
        title="Bracket"
        description="Semifinal matchups reflect group standings to date and are provisional until the final group-stage round completes."
      />
      <BracketView bracket={bracket} />
    </div>
  );
}
