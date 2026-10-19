import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import { ParticipantAvatar } from "../components/ParticipantName";
import ScoreBreakdown from "../components/ScoreBreakdown";
import StatTile from "../components/StatTile";
import StatusPill from "../components/StatusPill";
import TeamCrest from "../components/TeamCrest";
import { WAITLIST_TEAM_ID, isCompetingTeam, isWaitlisted } from "../config/teams";
import { useAuth } from "../context/AuthContext";
import { useTournament } from "../context/TournamentContext";
import {
  fetchLocalDevices,
  fetchLocalLeaderboard,
  isLocalApiConfigured,
  localParticipantDisplayName,
  localParticipantPhoto,
  resolveLocalPhotoUrl,
  type LocalDeviceRow,
  type LocalLeaderboardEntry,
  type LocalLeaderboardResponse,
} from "../data/localApi";
import { computePersonScore } from "../data/scoring";
import { isPermanentHolderEmail } from "../config/permanentHolders";

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function emailHandle(email: string): string {
  return email.trim().toLowerCase().split("@")[0] || email;
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function LocalMyProfile({
  email,
  name,
  photoUrl,
  emailHash,
}: {
  email: string;
  name: string;
  photoUrl?: string | null;
  emailHash?: string;
}) {
  const { session, patchSession } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [board, setBoard] = useState<LocalLeaderboardResponse | null>(null);
  const [entry, setEntry] = useState<LocalLeaderboardEntry | null>(null);
  const [cameras, setCameras] = useState<LocalDeviceRow[]>([]);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [displayPhoto, setDisplayPhoto] = useState<string | undefined>(
    resolveLocalPhotoUrl(photoUrl),
  );
  const [displayName, setDisplayName] = useState(name || emailHandle(email));
  const [nameDraft, setNameDraft] = useState(name || emailHandle(email));
  const [nameMsg, setNameMsg] = useState<string | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(ev: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [devicesRes, boardRes] = await Promise.all([
        fetchLocalDevices(),
        fetchLocalLeaderboard(
          undefined,
          isPermanentHolderEmail(email) ? "permanent" : "checkout",
        ),
      ]);
      const mine = devicesRes.devices.filter(
        (d) =>
          d.status === "Checked out" &&
          d.holderEmail?.toLowerCase() === email.toLowerCase(),
      );
      setCameras(mine);
      setBoard(boardRes);
      const handle = emailHandle(email);
      const myRows = boardRes.entries.filter(
        (e) =>
          (emailHash && e.emailHash === emailHash) ||
          e.name.toLowerCase() === handle ||
          e.name.toLowerCase() === displayName.toLowerCase(),
      );
      const match = myRows[0] ?? null;
      setEntry(match);
      if (match?.name) {
        setDisplayName(match.name);
        setNameDraft(match.name);
      }
      if (match?.photoUrl) {
        setDisplayPhoto(resolveLocalPhotoUrl(match.photoUrl));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBoard(null);
      setEntry(null);
      setCameras([]);
    } finally {
      setLoading(false);
    }
  }, [email, emailHash, displayName]);

  useEffect(() => {
    void load();
    // Intentionally once per email/hash — avoid loop when displayName updates from load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, emailHash]);

  async function onPhoto(file: File | null) {
    if (!file || !(session?.password || session?.harborSso)) {
      setPhotoMsg(
        session?.password || session?.harborSso
          ? null
          : "Finish Sign up before uploading a photo.",
      );
      return;
    }
    setPhotoMsg(null);
    setPhotoBusy(true);
    try {
      if (file.size >= 1024 * 1024) {
        throw new Error("Image must be less than 1MB.");
      }
      const dataUrl = await readFileAsDataUrl(file);
      const result = await localParticipantPhoto(session.email, session.password || "", dataUrl);
      const resolved = resolveLocalPhotoUrl(result.photoUrl);
      setDisplayPhoto(resolved);
      patchSession({ photoUrl: result.photoUrl });
      setPhotoMsg("Profile photo updated — it will show on the Leaderboard.");
      await load();
    } catch (err) {
      setPhotoMsg(err instanceof Error ? err.message : "Could not upload photo.");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function onSaveName(e: React.FormEvent) {
    e.preventDefault();
    if (!session?.password && !session?.harborSso) {
      setNameMsg("Finish Sign up before changing your display name.");
      return;
    }
    setNameMsg(null);
    setNameBusy(true);
    try {
      const result = await localParticipantDisplayName(
        session.email,
        session.password || "",
        nameDraft,
      );
      setDisplayName(result.name);
      setNameDraft(result.name);
      patchSession({ name: result.name });
      setNameMsg("Display name updated — it will show on the Leaderboard.");
      setEditingName(false);
      await load();
    } catch (err) {
      setNameMsg(err instanceof Error ? err.message : "Could not update display name.");
    } finally {
      setNameBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        eyebrow="Personal"
        title="My Profile"
        description="Your display name, photo, biweekly points, and open camera assignments."
      />

      <Card className="p-6">
        <div>
        <div className="relative z-20 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3" ref={menuRef}>
            <div className="relative shrink-0">
              <ParticipantAvatar
                name={displayName || emailHandle(email)}
                photoUrl={displayPhoto}
                seed={emailHash || email}
                size="lg"
              />
              <button
                type="button"
                title="Edit profile"
                aria-label="Edit profile"
                onClick={() => {
                  setMenuOpen((open) => !open);
                  setEditingName(false);
                }}
                className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-accent)] text-[#e8edf4] shadow-sm hover:opacity-90"
              >
                <PencilIcon className="h-3.5 w-3.5" />
              </button>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-[var(--color-text)]">
                  {displayName || emailHandle(email)}
                </h2>
                <div className="relative">
                  <button
                    type="button"
                    title="Edit profile"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((open) => !open)}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                  >
                    <PencilIcon className="h-3.5 w-3.5" />
                    Edit
                  </button>
                  {menuOpen && (
                    <div className="absolute left-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] py-1 shadow-lg">
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                        onClick={() => {
                          setMenuOpen(false);
                          setEditingName(false);
                          fileRef.current?.click();
                        }}
                      >
                        Upload profile picture
                      </button>
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                        onClick={() => {
                          setMenuOpen(false);
                          setEditingName(true);
                          setNameDraft(displayName || emailHandle(email));
                        }}
                      >
                        Change display name
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <p className="text-xs text-[var(--color-text-faint)]">{email}</p>
            </div>
          </div>
          <StatusPill status={cameras.length > 0 ? "Active" : "Inactive"} />
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          disabled={photoBusy}
          onChange={(e) => {
            void onPhoto(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />

        {editingName && (
          <form className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={onSaveName}>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
              Display name (shown on Leaderboard)
              <input
                className="input text-sm"
                value={nameDraft}
                maxLength={40}
                autoFocus
                onChange={(e) => setNameDraft(e.target.value)}
                disabled={nameBusy}
                required
              />
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={nameBusy || nameDraft.trim() === displayName.trim()}
                className="shrink-0 rounded-md bg-[var(--color-accent)] px-4 py-2 text-xs font-bold text-[#e8edf4] disabled:opacity-50"
              >
                {nameBusy ? "Saving…" : "Save name"}
              </button>
              <button
                type="button"
                className="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-text-muted)]"
                onClick={() => {
                  setEditingName(false);
                  setNameDraft(displayName);
                  setNameMsg(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {(nameMsg || photoMsg || photoBusy) && (
          <p
            className={`mt-2 text-xs ${
              (nameMsg || photoMsg || "").toLowerCase().includes("updated")
                ? "text-[var(--color-pitch)]"
                : photoBusy
                  ? "text-[var(--color-text-muted)]"
                  : "text-[var(--color-danger)]"
            }`}
          >
            {photoBusy ? "Uploading photo…" : nameMsg || photoMsg}
          </p>
        )}

        {loading ? (
          <p className="mt-4 text-sm text-[var(--color-text-muted)]">Loading profile…</p>
        ) : error ? (
          <p className="mt-4 text-sm text-[var(--color-danger)]">
            Couldn’t load local profile: {error}
          </p>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatTile
                label="Best camera rank"
                value={entry ? `#${entry.rank}` : "—"}
                hint={
                  board
                    ? board.entries.filter((e) => e.emailHash === entry?.emailHash).length > 1
                      ? board.entries
                          .filter((e) => e.emailHash === entry?.emailHash)
                          .map((e) => `#${e.rank} ${e.cameraId || "—"}`)
                          .join(" · ")
                      : entry?.cameraId || undefined
                    : undefined
                }
                accent
              />
              <StatTile
                label="Week points"
                value={
                  entry
                    ? board
                      ? board.entries
                          .filter((e) => e.emailHash === entry.emailHash)
                          .reduce((sum, e) => sum + e.totalPoints, 0)
                          .toFixed(0)
                      : entry.totalPoints.toFixed(0)
                    : "0"
                }
                hint={
                  board
                    ? `${new Date(board.weekStart).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })} – ${new Date(
                        new Date(board.weekEnd).getTime() - 12 * 60 * 60 * 1000,
                      ).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                    : undefined
                }
              />
              <StatTile
                label="Cameras out"
                value={cameras.length}
                hint={cameras.map((c) => c.cameraId).join(", ") || "None open"}
              />
            </div>

            {cameras.length > 0 ? (
              <div className="mt-4 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-text)]">
                Checked out:{" "}
                <span className="font-mono text-[var(--color-accent)]">
                  {cameras.map((c) => c.cameraId).join(", ")}
                </span>
                .{" "}
                <Link to="/devices" className="underline text-[var(--color-accent)]">
                  Manage on Devices
                </Link>
              </div>
            ) : (
              <p className="mt-4 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-text-faint)]">
                No open camera assignment.{" "}
                <Link to="/devices" className="underline text-[var(--color-accent)]">
                  Check one out
                </Link>
                .
              </p>
            )}

            {entry && entry.breakdown.length > 0 ? (
              <div className="mt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
                  Score breakdown
                </p>
                {(board?.entries.filter((e) => e.emailHash === entry.emailHash) ?? [entry]).map(
                  (row) => (
                    <div key={row.cameraId || "none"} className="mb-3 last:mb-0">
                      {row.cameraId ? (
                        <p className="mb-1 font-mono text-xs text-[var(--color-accent)]">
                          #{row.rank} · {row.cameraId} · {row.totalPoints.toFixed(1)} pts
                        </p>
                      ) : null}
                      <ul className="space-y-1.5 text-sm">
                        {row.breakdown
                          .filter((b) => b.enabled)
                          .sort((a, b) => a.displayOrder - b.displayOrder)
                          .map((b) => (
                            <li
                              key={`${row.cameraId}-${b.metricKey}`}
                              className="flex items-center justify-between gap-3 border-t border-[var(--color-border-soft)] py-1.5 first:border-t-0"
                            >
                              <span className="text-[var(--color-text-muted)]">{b.label}</span>
                              <span className="font-mono text-[var(--color-text)]">
                                {b.points.toFixed(0)}
                                <span className="ml-2 text-[10px] text-[var(--color-text-faint)]">
                                  raw {b.raw}
                                </span>
                              </span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  ),
                )}
              </div>
            ) : (
              <p className="mt-4 text-xs text-[var(--color-text-faint)]">
                No score for this period yet — scores appear once the next activity update lands.
              </p>
            )}
          </>
        )}
        </div>
      </Card>
    </div>
  );
}

function DemoMyProfile() {
  const { session } = useAuth();
  const { participants, teams, activity, updateProfilePhoto } = useTournament();
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);

  const participant = session
    ? participants.find((p) => p.email.toLowerCase() === session.email.toLowerCase())
    : undefined;
  const team =
    participant && isCompetingTeam(participant.teamId)
      ? teams.find((t) => t.id === participant.teamId)
      : undefined;
  const waitlisted = participant
    ? isWaitlisted(participant.teamId) || participant.teamId === WAITLIST_TEAM_ID
    : false;
  const records = participant ? activity.filter((a) => a.email === participant.email) : [];
  const breakdown = participant
    ? computePersonScore(participant, records, new Date().toISOString())
    : null;

  if (!session || (!session.isParticipant && session.role === "admin")) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader
          eyebrow="Personal"
          title="My Profile"
          description="Finish Sign up if you do not have a self-host row yet."
        />
        <Card className="p-6 text-center text-sm text-[var(--color-text-muted)]">
          <Link to="/sign-up" className="text-[var(--color-accent)] underline">
            Sign up
          </Link>{" "}
          if you have not registered yet.
        </Card>
      </div>
    );
  }

  if (!participant || !breakdown) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="My Profile" />
        <Card className="p-6 text-center text-sm text-[var(--color-text-muted)]">
          You are signed in as {session.email}. Scores show after the next activity import. If the
          camera will not assign in Fleet, an admin still needs to add you to the agency.
        </Card>
      </div>
    );
  }

  const participantEmail = participant.email;

  async function onPhoto(file: File | null) {
    if (!file) return;
    setPhotoMsg(null);
    try {
      const url = await readFileAsDataUrl(file);
      await updateProfilePhoto(participantEmail, url);
      setPhotoMsg("Photo updated.");
    } catch {
      setPhotoMsg("Could not upload photo.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        eyebrow="Personal"
        title="My Profile"
        description="Your tournament score, photo, and assignment."
      />

      <Card className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <ParticipantAvatar name={participant.name} photoUrl={participant.photoUrl} size="lg" />
            <div>
              <h2 className="text-lg font-bold text-[var(--color-text)]">{participant.name}</h2>
              <p className="text-xs text-[var(--color-text-faint)]">
                {participant.role} · {participant.hub}
              </p>
            </div>
          </div>
          <StatusPill status={participant.status} />
        </div>

        <label className="mt-4 block text-xs text-[var(--color-text-muted)]">
          Upload profile photo
          <input
            type="file"
            accept="image/*"
            className="file-input mt-1 block"
            onChange={(e) => void onPhoto(e.target.files?.[0] ?? null)}
          />
        </label>
        {photoMsg && <p className="mt-1 text-xs text-[var(--color-pitch)]">{photoMsg}</p>}

        {team ? (
          <Link
            to={`/teams/${team.id}`}
            className="mt-4 flex items-center gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 hover:opacity-90"
          >
            <TeamCrest team={team} size="sm" />
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-[var(--color-text)]">{team.name}</span>
              <p className="text-[11px] text-[var(--color-accent)]">Edit name, color & logo →</p>
            </div>
            <span className="text-xs text-[var(--color-text-faint)]">Group {team.group}</span>
          </Link>
        ) : waitlisted ? (
          <p className="mt-4 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3 py-2 text-sm text-[var(--color-text)]">
            You are on the <span className="font-semibold">Waitlist</span> — not yet on a competing
            team. You can still track stats.
          </p>
        ) : (
          <p className="mt-4 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-text-faint)]">
            Not yet assigned — an admin will place you on a team or the waitlist.
          </p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="Total score" value={breakdown.total.toFixed(0)} accent />
          <StatTile label="Streak" value={`${breakdown.streakDays}d`} hint={`+${breakdown.streakBonus} bonus`} />
          <StatTile label="Reports filed" value={breakdown.totals.reports} />
          <StatTile label="Recordings" value={breakdown.totals.recordings} />
          <StatTile label="Hours recorded" value={breakdown.totals.hours.toFixed(1)} />
          <StatTile label="Uploads" value={breakdown.totals.uploads} />
        </div>

        <div className="mt-4">
          <ScoreBreakdown breakdown={breakdown} label="Full score breakdown" />
        </div>
      </Card>
    </div>
  );
}

export default function MyProfile() {
  const { session } = useAuth();
  const usesLocalApi = isLocalApiConfigured();

  if (usesLocalApi) {
    if (!session || (!session.isParticipant && session.role === "admin")) {
      return (
        <div className="mx-auto max-w-2xl">
          <PageHeader
            eyebrow="Personal"
            title="My Profile"
            description="If you have not registered yet, finish Sign up."
          />
          <Card className="p-6 text-center text-sm text-[var(--color-text-muted)]">
            <Link to="/sign-up" className="text-[var(--color-accent)] underline">
              Sign up
            </Link>{" "}
            if you do not have a self-host row yet.
          </Card>
        </div>
      );
    }
    return (
      <LocalMyProfile
        email={session.email}
        name={session.name}
        photoUrl={session.photoUrl}
        emailHash={session.emailHash}
      />
    );
  }

  return <DemoMyProfile />;
}
