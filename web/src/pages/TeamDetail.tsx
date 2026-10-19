import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Card from "../components/Card";
import ParticipantName from "../components/ParticipantName";
import ScoreBreakdown from "../components/ScoreBreakdown";
import StatTile from "../components/StatTile";
import StatusPill from "../components/StatusPill";
import TeamCrest from "../components/TeamCrest";
import { useAuth } from "../context/AuthContext";
import { useTournament } from "../context/TournamentContext";
import { buildActivityByEmail } from "../data/derived";
import { ValidationError } from "../data/dataSource";
import { computePersonScore } from "../data/scoring";

const COLOR_OPTIONS = [
  "#3b82f6",
  "#f2782f",
  "#e5484d",
  "#2f9e6e",
  "#a855f7",
  "#0ea5b7",
  "#f2b705",
  "#4c9a5f",
  "#ec4899",
  "#64748b",
];

const CREST_OPTIONS = ["⚡", "🔋", "🌵", "🛡️", "📡", "📍", "🔥", "🎬", "⚽", "🏆", "🚀", "🎯", "💪", "🌟", "🦊", "🦅"];

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

export default function TeamDetail() {
  const { teamId } = useParams();
  const { session } = useAuth();
  const { teams, participants, activity, updateTeamProfile, updateTeamProfileAsAdmin } =
    useTournament();
  const team = teams.find((t) => t.id === teamId);
  const activityByEmail = buildActivityByEmail(activity);
  const now = new Date().toISOString();

  const onRoster =
    session?.role === "participant" &&
    Boolean(
      participants.find(
        (p) =>
          p.email.toLowerCase() === session.email.toLowerCase() && p.teamId === teamId,
      ),
    );
  const canEdit = onRoster || session?.role === "admin";

  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(team?.name ?? "");
  const [colorInput, setColorInput] = useState(team?.color ?? "");
  const [crestInput, setCrestInput] = useState(team?.crest ?? "⚡");
  const [logoUrl, setLogoUrl] = useState<string | null>(team?.logoUrl ?? null);
  const [logoMode, setLogoMode] = useState<"emoji" | "image">(
    team?.logoUrl ? "image" : "emoji",
  );
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState(false);

  const roster = useMemo(
    () =>
      participants
        .filter((p) => p.teamId === teamId)
        .map((p) => ({
          participant: p,
          breakdown: computePersonScore(p, activityByEmail.get(p.email) ?? [], now),
        }))
        .sort((a, b) => b.breakdown.total - a.breakdown.total),
    [participants, teamId, activityByEmail, now],
  );

  if (!team) {
    return (
      <Card className="p-8 text-center text-[var(--color-text-muted)]">
        Team not found.{" "}
        <Link to="/teams" className="text-[var(--color-accent)] underline">
          Back to teams
        </Link>
      </Card>
    );
  }

  const teamTotal = roster.reduce((sum, r) => sum + r.breakdown.total, 0);
  const previewTeam = {
    ...team,
    name: nameInput || team.name,
    color: colorInput || team.color,
    crest: crestInput || team.crest,
    logoUrl: logoMode === "image" && logoUrl ? logoUrl : undefined,
  };

  function openEditor() {
    setNameInput(team!.name);
    setColorInput(team!.color);
    setCrestInput(team!.crest);
    setLogoUrl(team!.logoUrl ?? null);
    setLogoMode(team!.logoUrl ? "image" : "emoji");
    setEditError(null);
    setEditSuccess(false);
    setEditing(true);
  }

  async function handleSaveProfile() {
    if (!team || !session) return;
    setEditError(null);
    setEditSuccess(false);
    try {
      const updates = {
        name: nameInput.trim() || team.name,
        color: colorInput || team.color,
        crest: crestInput || team.crest,
        logoUrl: logoMode === "image" && logoUrl ? logoUrl : null,
      };
      if (session.role === "admin") await updateTeamProfileAsAdmin(team.id, updates);
      else await updateTeamProfile(team.id, updates, session.email);
      setEditSuccess(true);
      setEditing(false);
    } catch (err) {
      if (err instanceof ValidationError) setEditError(err.message);
      else setEditError("Something went wrong.");
    }
  }

  async function onLogoFile(file: File | null) {
    if (!file) return;
    const url = await readFileAsDataUrl(file);
    setLogoUrl(url);
    setLogoMode("image");
  }

  return (
    <div>
      <Link
        to="/teams"
        className="mb-4 inline-block text-sm text-[var(--color-text-faint)] hover:text-[var(--color-accent)]"
      >
        ← All teams
      </Link>

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-4">
          <TeamCrest team={editing ? previewTeam : team} size="lg" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-text-faint)]">
              Group {team.group}
            </p>
            <h1 className="text-2xl font-bold text-[var(--color-text)]">
              {editing ? previewTeam.name : team.name}
            </h1>
            <p className="text-xs text-[var(--color-text-faint)]">Originally "{team.defaultName}"</p>
          </div>
        </div>
        {canEdit ? (
          <button
            onClick={() => (editing ? setEditing(false) : openEditor())}
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-text)] hover:border-[var(--color-accent)]"
          >
            {editing ? "Cancel" : "Edit team"}
          </button>
        ) : (
          <p className="max-w-xs text-right text-xs text-[var(--color-text-faint)]">
            {session ? (
              "You need to be a member of this team to edit name, color, and logo."
            ) : (
              <>
                You need a roster row for this team to edit name, color, and logo.{" "}
                <Link to="/sign-up" className="text-[var(--color-accent)] underline">
                  Sign up
                </Link>
              </>
            )}
          </p>
        )}
      </div>

      {editSuccess && (
        <p className="mt-4 rounded-lg bg-[var(--color-pitch)]/15 px-3 py-2 text-sm text-[var(--color-pitch)]">
          Team profile updated.
        </p>
      )}

      {editing && canEdit && (
        <Card className="mt-4 p-5">
          <p className="mb-3 text-sm text-[var(--color-text-muted)]">
            Change the team name, color, and logo (emoji or uploaded image). Last save wins for the
            whole roster.
          </p>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-[var(--color-text)]">Team name</span>
            <input className="input" value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
          </label>

          <div className="mt-4">
            <p className="mb-2 text-sm font-medium text-[var(--color-text)]">Color</p>
            <div className="flex flex-wrap gap-2">
              {COLOR_OPTIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColorInput(c)}
                  className="h-8 w-8 rounded-full border-2"
                  style={{
                    backgroundColor: c,
                    borderColor: colorInput === c ? "#fff" : "transparent",
                  }}
                  aria-label={c}
                />
              ))}
            </div>
          </div>

          <div className="mt-4">
            <p className="mb-2 text-sm font-medium text-[var(--color-text)]">Logo</p>
            <div className="mb-3 flex gap-2">
              <button
                type="button"
                onClick={() => setLogoMode("emoji")}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                  logoMode === "emoji"
                    ? "bg-[var(--color-accent)] text-[var(--color-text)]"
                    : "border border-[var(--color-border)] text-[var(--color-text-muted)]"
                }`}
              >
                Emoji
              </button>
              <button
                type="button"
                onClick={() => setLogoMode("image")}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                  logoMode === "image"
                    ? "bg-[var(--color-accent)] text-[var(--color-text)]"
                    : "border border-[var(--color-border)] text-[var(--color-text-muted)]"
                }`}
              >
                Upload image
              </button>
            </div>

            {logoMode === "emoji" ? (
              <div className="flex flex-wrap gap-2">
                {CREST_OPTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      setCrestInput(emoji);
                      setLogoMode("emoji");
                    }}
                    className={`flex h-10 w-10 items-center justify-center rounded-lg border text-xl ${
                      crestInput === emoji && logoMode === "emoji"
                        ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]"
                        : "border-[var(--color-border)]"
                    }`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <input
                  type="file"
                  accept="image/*"
                  className="file-input"
                  onChange={(e) => void onLogoFile(e.target.files?.[0] ?? null)}
                />
                {logoUrl && (
                  <img
                    src={logoUrl}
                    alt="Logo preview"
                    className="h-16 w-16 rounded-xl object-cover border border-[var(--color-border)]"
                  />
                )}
              </div>
            )}
          </div>

          {editError && (
            <p className="mt-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
              {editError}
            </p>
          )}

          <button
            type="button"
            onClick={handleSaveProfile}
            className="mt-4 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[var(--color-text)]"
          >
            Save changes
          </button>
        </Card>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Roster size" value={roster.length} />
        <StatTile label="Team total score" value={teamTotal.toFixed(0)} accent />
        <StatTile
          label="Active members"
          value={roster.filter((r) => r.participant.status === "Active").length}
        />
        <StatTile
          label="Inactive members"
          value={roster.filter((r) => r.participant.status === "Inactive").length}
        />
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-[var(--color-border-soft)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Roster</h2>
          <p className="text-xs text-[var(--color-text-faint)]">
            Public stats for teammate accountability. Emails and device serials are never shown here.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-2 py-2 font-medium">Role</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 text-right font-medium">Score</th>
              <th className="px-4 py-2 text-right font-medium"> </th>
            </tr>
          </thead>
          <tbody>
            {roster.map(({ participant, breakdown }) => (
              <tr key={participant.email} className="border-t border-[var(--color-border-soft)]">
                <td className="px-4 py-2.5">
                  <ParticipantName name={participant.name} photoUrl={participant.photoUrl} />
                </td>
                <td className="px-2 py-2.5 text-[var(--color-text-muted)]">{participant.role}</td>
                <td className="px-2 py-2.5">
                  <StatusPill status={participant.status} />
                </td>
                <td className="px-2 py-2.5 text-right font-bold text-[var(--color-text)]">
                  {breakdown.total.toFixed(0)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <ScoreBreakdown breakdown={breakdown} label="Details" />
                </td>
              </tr>
            ))}
            {roster.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-faint)]">
                  No members assigned yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
