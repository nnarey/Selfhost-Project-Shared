import { useCallback, useEffect, useMemo, useState } from "react";
import { isHarborHostedUi } from "../config/harbor";
import { relativeTime } from "../config/workingHours";
import { useAuth } from "../context/AuthContext";
import { Link } from "react-router-dom";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import {
  isLocalApiConfigured,
  localCopyScoringDraft,
  localEmergencyActivateScoring,
  localDownloadAssignmentsCsv,
  localFleetManualOwnership,
  localFleetStatus,
  localFleetSync,
  localImportBegin,
  localImportCommit,
  localImportPreview,
  localImportUpload,
  localListParticipants,
  localListQuarantine,
  localListReports,
  localPreviewScoringDraft,
  localRecomputeScores,
  localResetScores,
  localRemindersCancel,
  localRemindersPending,
  localRemindersPreview,
  localRemindersQueue,
  localScheduleScoringDraft,
  localScoringActive,
  localCreateReport,
  localIntakeReports,
  localSnapshotWeek,
  localUpdateScoringDraft,
  localValidateScoringDraft,
  localListChallenges,
  localAwardChallenge,
  localRevokeChallenge,
  localScorePeople,
  localListScoreAdjustments,
  localAdjustScore,
  localRevokeScoreAdjustment,
  localRemoveParticipants,
  localLeaderboardTracks,
  localSetTrackOverride,
  type BiweeklyTrack,
  type LocalScoreDelta,
} from "../data/localApi";

const TOKEN_KEY = "fieldcam_local_admin_token";

type Tab =
  | "signups"
  | "tracks"
  | "import"
  | "evidence"
  | "quarantine"
  | "reminders"
  | "scoring"
  | "adjust"
  | "challenges"
  | "reports";

export default function AdminLocal() {
  const harborHosted = isHarborHostedUi();
  const { session } = useAuth();
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || "");
  const [tab, setTab] = useState<Tab>("signups");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [activeProfileLabel, setActiveProfileLabel] = useState<string | null>(null);

  const configured = isLocalApiConfigured();

  useEffect(() => {
    const stored = sessionStorage.getItem(TOKEN_KEY) || "";
    if (stored && stored !== token) setToken(stored);
  }, [session, token]);

  useEffect(() => {
    if (!token) return;
    void localScoringActive()
      .then((p) => setActiveProfileLabel(`${p.name} (${p.profileId}@${p.version})`))
      .catch(() => setActiveProfileLabel(null));
  }, [token, tab]);

  useEffect(() => {
    if (harborHosted && (tab === "evidence" || tab === "reminders")) {
      setTab("signups");
    }
  }, [harborHosted, tab]);

  if (!configured) {
    return (
      <Card className="mx-auto max-w-lg p-6 text-sm text-[var(--color-text-muted)]">
        Set <code className="text-[var(--color-text)]">VITE_LOCAL_API_URL</code> or run Vite in
        dev with the local API proxy. See README.
      </Card>
    );
  }

  // Hides the screen from anyone whose identity is not on the admin allowlist, including someone
  // who types /#/admin directly. Every admin endpoint independently re-checks the allowlist
  // server-side, so this is the visibility layer rather than the security boundary.
  if (session && !session.isAdmin) {
    return (
      <Card className="mx-auto max-w-lg p-6 text-center text-sm text-[var(--color-text-muted)]">
        <p className="font-medium text-[var(--color-text)]">Admins only</p>
        <p className="mt-2">
          This area is limited to the FieldCam self-host program admins. Head back to the{" "}
          <Link to="/leaderboard" className="text-[var(--color-accent)] underline">
            leaderboard
          </Link>
          .
        </p>
      </Card>
    );
  }

  if (!token) {
    return (
      <div className="mx-auto max-w-md">
        <PageHeader
          eyebrow="Admin"
          title="Admin"
          description="There is no app password. If you should have access and this page is empty, you are not on the admin allowlist."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Local API"
        title="Admin"
        description={
          harborHosted
            ? "CSV import, quarantine, scoring drafts, and report intake."
            : "Paired CSV import, Fleet sync, reminders, scoring drafts, and report intake against the local SQLite backend."
        }
        action={
          <Link
            to="/leaderboard"
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-muted)]"
          >
            Leaderboard
          </Link>
        }
      />

      {activeProfileLabel && (
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Active scoring profile:{" "}
          <span className="text-[var(--color-text)]">{activeProfileLabel}</span>
        </p>
      )}

      {(status || error) && (
        <div
          className={`sticky top-2 z-30 mb-4 space-y-1 rounded-2xl border bg-[var(--color-surface)] p-3 text-sm shadow-lg ${
            error ? "border-[var(--color-danger)]" : "border-[var(--color-border-soft)]"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              {status && <p className="text-[var(--color-text-muted)]">{status}</p>}
              {error && <p className="text-[var(--color-danger)]">{error}</p>}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => {
                setStatus(null);
                setError(null);
              }}
              className="shrink-0 rounded px-2 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {(
          [
            ["signups", "Agency"],
            ["tracks", "Tracks"],
            ["import", "Import"],
            ["evidence", "Fleet API"],
            ["quarantine", "Quarantine"],
            ["reminders", "Reminders"],
            ["scoring", "Scoring"],
            ["adjust", "Adjust scores"],
            ["challenges", "Challenges"],
            ["reports", "Reports"],
          ] as const
        )
          .filter(([id]) => !harborHosted || (id !== "evidence" && id !== "reminders"))
          .map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              tab === id
                ? "bg-[var(--color-accent)] text-[#e8edf4]"
                : "border border-[var(--color-border)] text-[var(--color-text-muted)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "signups" && (
        <SignupsPanel token={token} onStatus={setStatus} onError={setError} />
      )}
      {tab === "tracks" && (
        <TracksPanel token={token} onStatus={setStatus} onError={setError} />
      )}
      {tab === "import" && (
        <ImportPanel token={token} onStatus={setStatus} onError={setError} />
      )}
      {tab === "evidence" && !harborHosted && (
        <EvidencePanel token={token} onStatus={setStatus} onError={setError} />
      )}
      {tab === "quarantine" && (
        <QuarantinePanel token={token} onError={setError} />
      )}
      {tab === "reminders" && !harborHosted && (
        <RemindersPanel token={token} onStatus={setStatus} onError={setError} />
      )}
      {tab === "scoring" && (
        <ScoringPanel token={token} onStatus={setStatus} onError={setError} />
      )}
      {tab === "adjust" && (
        <AdjustScoresPanel token={token} onStatus={setStatus} onError={setError} />
      )}
      {tab === "challenges" && (
        <ChallengesPanel token={token} onStatus={setStatus} onError={setError} />
      )}
      {tab === "reports" && (
        <ReportsPanel token={token} onStatus={setStatus} onError={setError} />
      )}
    </div>
  );
}

function TracksPanel({
  token,
  onStatus,
  onError,
}: {
  token: string;
  onStatus: (s: string | null) => void;
  onError: (s: string | null) => void;
}) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof localLeaderboardTracks>>["rows"]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await localLeaderboardTracks(token);
    setRows(r.rows);
  }, [token]);

  useEffect(() => {
    void load().catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [load, onError]);

  async function move(
    row: { email: string; cameraId: string; name: string },
    track: BiweeklyTrack | null,
  ) {
    setBusy(true);
    onError(null);
    try {
      await localSetTrackOverride(token, row.email, row.cameraId, track);
      onStatus(
        track
          ? `${row.name}'s ${row.cameraId} score moved to the ${track} board.`
          : `${row.name}'s ${row.cameraId} score back to its default board.`,
      );
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-5">
      <div>
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Move a score to the other board</h2>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Boards are split by person as usual. Use this only for exceptions — for example a
          permanent holder who spent a period on a checkout camera: move that one camera&rsquo;s score
          to Checkout and their own camera stays on Permanent. Checkout sums a person&rsquo;s cameras
          into one row; Permanent stays one row per camera.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          No scored cameras yet — import a Splunk batch first.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
              <tr>
                <th className="py-2 pr-3 font-medium">Person</th>
                <th className="py-2 pr-3 font-medium">Camera</th>
                <th className="py-2 pr-3 font-medium">Points</th>
                <th className="py-2 pr-3 font-medium">Board</th>
                <th className="py-2 font-medium">Move to</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.email}-${row.cameraId}`}
                  className="border-t border-[var(--color-border-soft)]"
                >
                  <td className="py-2 pr-3 text-[var(--color-text)]">{row.name}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-[var(--color-text-muted)]">
                    {row.cameraId}
                  </td>
                  <td className="py-2 pr-3 text-[var(--color-text-muted)]">
                    {row.totalPoints.toLocaleString()}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={
                        row.track === "permanent"
                          ? "text-[var(--color-text)]"
                          : "text-[var(--color-accent)]"
                      }
                    >
                      {row.track === "permanent" ? "Permanent" : "Checkout"}
                    </span>
                    {row.overridden && (
                      <span className="ml-1 text-[10px] text-[var(--color-text-faint)]">
                        (moved)
                      </span>
                    )}
                  </td>
                  <td className="py-2">
                    <select
                      value={row.overridden ? row.track : ""}
                      disabled={busy}
                      onChange={(e) =>
                        void move(
                          row,
                          e.target.value === "" ? null : (e.target.value as BiweeklyTrack),
                        )
                      }
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-text)]"
                    >
                      <option value="">Default</option>
                      <option value="permanent">Permanent</option>
                      <option value="checkout">Checkout</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function SignupsPanel({
  token,
  onStatus,
  onError,
}: {
  token: string;
  onStatus: (s: string | null) => void;
  onError: (s: string | null) => void;
}) {
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [participants, setParticipants] = useState<
    Awaited<ReturnType<typeof localListParticipants>>["participants"]
  >([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await localListParticipants(token, filter);
    setParticipants(r.participants);
    setSelected(new Set());
  }, [token, filter]);

  useEffect(() => {
    void load().catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [load, onError]);

  function toggle(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  async function removeSelected() {
    if (selected.size === 0) return;
    const emails = [...selected];
    setBusy(true);
    onError(null);
    try {
      // Dry run first so the confirmation prompt reflects exactly what will be deleted.
      const preview = await localRemoveParticipants(token, emails, true);
      const ok = window.confirm(
        `Remove ${preview.removedParticipants} participant(s): ${preview.emails.join(", ")}?\n\n` +
          `This permanently deletes their scores, ${preview.removedActivityEvents} activity event(s), ` +
          `and ${preview.removedAssignments} assignment record(s). This cannot be undone.`,
      );
      if (!ok) return;
      const result = await localRemoveParticipants(token, emails, false);
      onStatus(`Removed ${result.removedParticipants} participant(s) and recomputed scores.`);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <p className="text-sm text-[var(--color-text-muted)]">
        People who signed up and still need to be added to the Fleet agency. They can already check
        out in the app. Once they appear on an Fleet assignment they leave this list. Check any rows
        below to remove those people (and all their scores/activity) from the system entirely.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setFilter("pending")}
          className={
            filter === "pending"
              ? "rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-bold text-[#e8edf4]"
              : "rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs"
          }
        >
          Awaiting Fleet
        </button>
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={
            filter === "all"
              ? "rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-bold text-[#e8edf4]"
              : "rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs"
          }
        >
          All registered
        </button>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm"
        >
          Refresh
        </button>
        {selected.size > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void removeSelected()}
            className="ml-auto rounded-md border border-[var(--color-danger)] px-3 py-1.5 text-xs font-bold text-[var(--color-danger)] disabled:opacity-50"
          >
            {busy ? "Removing…" : `Remove ${selected.size} selected`}
          </button>
        )}
      </div>
      {participants.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          {filter === "pending"
            ? "Nobody is waiting to be added to the Fleet agency."
            : "No registrations yet."}
        </p>
      ) : (
        <ul className="space-y-2">
          {participants.map((p) => (
            <li
              key={p.email}
              className="flex items-start gap-3 rounded-md border border-[var(--color-border-soft)] p-3 text-sm"
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0"
                checked={selected.has(p.email)}
                onChange={() => toggle(p.email)}
                aria-label={`Select ${p.email} for removal`}
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-[var(--color-text)]">
                  {p.name} · {p.email}
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {p.signupStatus === "pending" ? "Add to Fleet agency" : p.signupStatus} · {p.hub} ·
                  signed up {p.enrolledAt || p.updatedAt}
                </p>
                {p.registration && (
                  <div className="mt-2 space-y-1 text-xs text-[var(--color-text-muted)]">
                    {(p.registration.roleDepartment || p.registration.location) && (
                      <p>
                        {[p.registration.roleDepartment, p.registration.location]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                    {p.registration.expectedHoursPerWeek && (
                      <p>Hours/week: {p.registration.expectedHoursPerWeek}</p>
                    )}
                    {p.registration.dailyFeatures?.length ? (
                      <p>Daily features: {p.registration.dailyFeatures.join("; ")}</p>
                    ) : null}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DeltaTable({ deltas }: { deltas: LocalScoreDelta[] }) {
  if (!deltas.length) {
    return <p className="text-xs text-[var(--color-text-muted)]">No score/rank deltas.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-[var(--color-text-muted)]">
          <tr>
            <th className="py-1">Name</th>
            <th>Δ pts</th>
            <th>Before → after</th>
            <th>Rank</th>
          </tr>
        </thead>
        <tbody>
          {deltas.slice(0, 15).map((d) => (
            <tr key={d.email} className="border-t border-[var(--color-border-soft)]">
              <td className="py-1">{d.name}</td>
              <td className={d.deltaPoints >= 0 ? "text-[var(--color-accent)]" : "text-[var(--color-danger)]"}>
                {d.deltaPoints >= 0 ? "+" : ""}
                {d.deltaPoints}
              </td>
              <td>
                {d.beforePoints} → {d.afterPoints}
              </td>
              <td>
                {d.beforeRank ?? "—"} → {d.afterRank ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvidencePanel({
  token,
  onStatus,
  onError,
}: {
  token: string;
  onStatus: (s: string | null) => void;
  onError: (s: string | null) => void;
}) {
  const [status, setLocalStatus] = useState<Awaited<ReturnType<typeof localFleetStatus>> | null>(
    null,
  );
  const [cameraId, setCameraId] = useState("FC-7727X");
  const [email, setEmail] = useState("alice.chen@northline.example");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const s = await localFleetStatus(token);
    setLocalStatus(s);
  }, [token]);

  useEffect(() => {
    void refresh().catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [refresh, onError]);

  async function runSync() {
    setBusy(true);
    onError(null);
    try {
      const r = await localFleetSync(token);
      onStatus(
        `Fleet sync: opened=${String(r.result.opened)} closed=${String(r.result.closed)} unchanged=${String(r.result.unchanged)} unresolved=${String(r.result.unresolvedOwners)}`,
      );
      await refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function downloadForHip() {
    setBusy(true);
    onError(null);
    try {
      const r = await localDownloadAssignmentsCsv(token);
      onStatus(
        `Downloaded ${r.filename} (${r.rows} assignment rows). Upload that file as the Fleet CSV on Harbor with your Splunk export.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runManual() {
    setBusy(true);
    onError(null);
    try {
      await localFleetManualOwnership(token, cameraId, email.trim() || null);
      onStatus(`Manual ownership set: ${cameraId} → ${email.trim() || "(none)"}`);
      await refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <p className="text-sm text-[var(--color-text-muted)]">
        Laptop only: sync current Fleet owners, then download a canonical assignments CSV to
        upload on Harbor (Harbor cannot call Fleet). Git push does not move this data.
      </p>
      {status && (
        <div className="grid gap-2 sm:grid-cols-3 text-sm">
          <Stat label="Mode" value={`${status.mode}${status.enabled ? "" : " (disabled)"}`} />
          <Stat label="Configured" value={status.configured ? "yes" : "no"} />
          <Stat label="Poll seconds" value={status.pollSeconds} />
          <Stat label="Model filter" value={status.modelFilter || "—"} />
          <Stat label="Last sync" value={status.lastSyncAt || "never"} />
          <Stat
            label="Last opened/closed"
            value={
              status.lastResult
                ? `${String(status.lastResult.opened ?? 0)}/${String(status.lastResult.closed ?? 0)}`
                : "—"
            }
          />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void runSync()}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[#e8edf4] disabled:opacity-50"
        >
          {busy ? "Working…" : "Sync ownership now"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void downloadForHip()}
          className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Download assignments CSV for Harbor
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
          className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Refresh status
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          Camera ID (manual mock)
          <input
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            value={cameraId}
            onChange={(e) => setCameraId(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Owner email (blank = unassign)
          <input
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
      </div>
      <button
        type="button"
        disabled={busy || !cameraId.trim()}
        onClick={() => void runManual()}
        className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        Apply manual ownership (dev)
      </button>
    </Card>
  );
}

function ImportPanel({
  token,
  onStatus,
  onError,
}: {
  token: string;
  onStatus: (s: string | null) => void;
  onError: (s: string | null) => void;
}) {
  const [splunkFile, setSplunkFile] = useState<File | null>(null);
  const [fleetFile, setFleetFile] = useState<File | null>(null);
  const [exportTime, setExportTime] = useState(() => new Date().toISOString().slice(0, 16));
  const [preview, setPreview] = useState<
    (Awaited<ReturnType<typeof localImportPreview>> & { batchId?: string }) | null
  >(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState(false);

  function exportTimeUtc(): string {
    const raw = exportTime.trim();
    if (!raw) throw new Error("Export time is required.");
    const d = new Date(raw.length === 16 ? `${raw}:00` : raw);
    if (Number.isNaN(d.getTime())) throw new Error("Export time is invalid.");
    return d.toISOString();
  }

  async function runPreview() {
    onError(null);
    onStatus(null);
    setCommitted(false);
    if (!splunkFile) {
      onError("Splunk CSV is required.");
      return;
    }
    setBusy(true);
    try {
      const splunkCsv = await splunkFile.text();
      const fleetCsv = fleetFile ? await fleetFile.text() : undefined;
      const begin = await localImportBegin(token, exportTimeUtc(), "America/Phoenix");
      setBatchId(begin.batchId);
      await localImportUpload(token, begin.batchId, splunkCsv, fleetCsv);
      const p = await localImportPreview(token, begin.batchId);
      // Keep batch id on the preview object so Commit never depends on a stale hook value.
      setPreview({ ...p, batchId: begin.batchId });
      onStatus(
        `Preview ready: ${p.acceptedActivity} activity accepted, ${p.quarantinedActivity} quarantined, ${p.rejectedActivity} rejected · ${p.scoreDeltaPreview?.participantsAffected ?? 0} score deltas${fleetFile ? "" : " (Fleet CSV omitted — using Fleet/DB assignments)"}. Click Commit import to save.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runCommit() {
    const id = preview?.batchId || batchId;
    if (!id) {
      onError("Run preview first.");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const result = await localImportCommit(token, id);
      setCommitted(true);
      const scoreCount = result.scores?.count ?? 0;
      const week = result.scores?.weekStart ?? "—";
      onStatus(
        `Committed batch ${id.slice(0, 8)}… Recomputed ${scoreCount} scores for week ${week}. Eligibility: ${result.eligibilityCount ?? 0}.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const canCommit = Boolean((preview?.batchId || batchId) && preview && !committed);

  return (
    <Card className="space-y-4 p-5">
      <p className="text-sm text-[var(--color-text-muted)]">
        Upload a Splunk activity CSV and an assignments CSV. Include every camera in the
        assignments file — rows with only <code className="text-[var(--color-text)]">camera_id</code>{" "}
        (no email) are available stock. Commit replaces Devices inventory with that list.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Export time (local)
        <input
          type="datetime-local"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
          value={exportTime}
          onChange={(e) => setExportTime(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Splunk activity CSV (recordings / uploads — not the assignments file)
        <input
          type="file"
          accept=".csv,text/csv"
          className="file-input mt-1"
          onChange={(e) => setSplunkFile(e.target.files?.[0] || null)}
        />
        {splunkFile ? (
          <span className="text-xs text-[var(--color-text-muted)]">{splunkFile.name}</span>
        ) : null}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Assignments CSV from this laptop (fieldcam-assignments-*.csv)
        <input
          type="file"
          accept=".csv,text/csv"
          className="file-input mt-1"
          onChange={(e) => setFleetFile(e.target.files?.[0] || null)}
        />
        {fleetFile ? (
          <span className="text-xs text-[var(--color-text-muted)]">{fleetFile.name}</span>
        ) : null}
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void runPreview()}
          className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? "Working…" : "Preview import"}
        </button>
        <button
          type="button"
          disabled={busy || !canCommit}
          onClick={() => void runCommit()}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[#e8edf4] disabled:opacity-50"
        >
          {committed ? "Committed" : busy ? "Committing…" : "Commit import"}
        </button>
      </div>
      {preview && !committed && (
        <p className="text-xs text-[var(--color-text-muted)]">
          Preview is ready{typeof preview.acceptedActivity === "number" ? ` (${preview.acceptedActivity} accepted)` : ""}.
          Click <span className="text-[var(--color-text)]">Commit import</span> to write events and
          recompute scores.
        </p>
      )}
      {committed && (
        <p className="text-xs text-[var(--color-accent)]">
          Import committed. Run Preview again if you need to re-import an updated CSV.
        </p>
      )}
      {preview && (
        <div className="space-y-3 text-sm text-[var(--color-text-muted)]">
          <div className="grid gap-2 sm:grid-cols-3">
            <Stat label="Accepted activity" value={preview.acceptedActivity} />
            <Stat label="Quarantined" value={preview.quarantinedActivity} />
            <Stat label="Rejected activity" value={preview.rejectedActivity} />
            <Stat label="Assignments accepted" value={preview.acceptedAssignments} />
            <Stat label="Inventory cameras" value={preview.acceptedInventory ?? 0} />
            <Stat label="Assignments rejected" value={preview.rejectedAssignments} />
            <Stat
              label="Stale checkouts closed"
              value={preview.closedStaleAssignments ?? 0}
            />
            <Stat
              label="Export age (prior)"
              value={
                preview.freshness?.ageHours != null ? `${preview.freshness.ageHours}h` : "none"
              }
            />
          </div>
          <p>
            Batch export time: {preview.exportTimeUtc || "—"} · Week{" "}
            {preview.scoreDeltaPreview?.weekStart ?? "—"}
          </p>
          <div>
            <p className="mb-1 font-medium text-[var(--color-text)]">Score / rank deltas</p>
            <DeltaTable deltas={preview.scoreDeltaPreview?.deltas ?? []} />
          </div>
          {(preview.quarantineSample?.length ?? 0) > 0 && (
            <div>
              <p className="mb-1 font-medium text-[var(--color-text)]">Quarantine sample</p>
              <ul className="space-y-1 text-xs">
                {preview.quarantineSample.slice(0, 8).map((q) => (
                  <li key={q.eventId}>
                    {q.cameraId} · {q.eventType} · {q.eventTimeUtc} — {q.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(preview.errors ?? []).slice(0, 10).map((err, i) => (
            <p key={i} className="text-xs">
              [{err.severity}] {err.sourceKind} row {err.rowNumber}: {err.message}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-[var(--color-border-soft)] px-3 py-2">
      <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
      <p className="text-lg font-semibold text-[var(--color-text)]">{value}</p>
    </div>
  );
}

function QuarantinePanel({
  token,
  onError,
}: {
  token: string;
  onError: (s: string | null) => void;
}) {
  const [items, setItems] = useState<
    Awaited<ReturnType<typeof localListQuarantine>>["items"]
  >([]);

  const load = useCallback(async () => {
    onError(null);
    try {
      const res = await localListQuarantine(token);
      setItems(res.items);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [token, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-[var(--color-text-muted)]">
          Valid activity with no assignment interval — zero points until resolved.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm"
        >
          Refresh
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">No quarantined activity.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {items.map((item) => (
            <li
              key={item.eventId}
              className="rounded-md border border-[var(--color-border-soft)] p-3"
            >
              <p className="font-medium text-[var(--color-text)]">
                {item.cameraId} · {item.eventType}
              </p>
              <p className="text-[var(--color-text-muted)]">
                {item.eventTimeUtc} — {item.reason}
              </p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {item.eventId}
                {item.batchId ? ` · batch ${item.batchId.slice(0, 8)}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RemindersPanel({
  token,
  onStatus,
  onError,
}: {
  token: string;
  onStatus: (s: string | null) => void;
  onError: (s: string | null) => void;
}) {
  const [candidates, setCandidates] = useState<
    Awaited<ReturnType<typeof localRemindersPreview>>["candidates"]
  >([]);
  const [pending, setPending] = useState<
    Awaited<ReturnType<typeof localRemindersPending>>["nudges"]
  >([]);
  const [blocked, setBlocked] = useState(false);
  const [blockReason, setBlockReason] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedPending, setSelectedPending] = useState<Set<string>>(new Set());
  const [kindFilter, setKindFilter] = useState<"all" | "onboarding" | "inactivity">("all");
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  // Re-render once a minute so the "last refreshed" label ages instead of freezing.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    onError(null);
    try {
      const [preview, queued] = await Promise.all([
        localRemindersPreview(token),
        localRemindersPending(token, "queued"),
      ]);
      setCandidates(preview.candidates);
      setBlocked(preview.blocked);
      setBlockReason(preview.blockReason);
      // Deliberately not pre-selected: queueing sends a real Slack DM, so who receives one should
      // be something the operator picks rather than something they have to remember to undo.
      setSelected(new Set());
      setPending(queued.nudges);
      setSelectedPending(new Set());
      const at = Date.now();
      setRefreshedAt(at);
      setNowMs(at);
      // Report what the list actually shows. The raw preview still counts people who are already
      // queued, so quoting it left the status line disagreeing with the rows underneath it.
      const alreadyQueued = new Set(queued.nudges.map((n) => n.email.toLowerCase()));
      const actionable = preview.candidates.filter((c) => !alreadyQueued.has(c.email.toLowerCase()));
      onStatus(
        `Refreshed — ${actionable.length} eligible, ${queued.nudges.length} queued.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [token, onError, onStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Candidates after the type and time-off filters. Everything the buttons act on is derived from
   * this, never from the raw list — otherwise a filtered-out person could still be queued.
   */
  /**
   * Eligibility is computed from activity, so someone stays "eligible" the moment after you queue
   * them — they only drop off once the DM is actually sent. Leaving them in the list made a
   * successful queue look like it had done nothing. They move to the queue section below instead.
   */
  const queuedEmails = useMemo(
    () => new Set(pending.map((n) => n.email.toLowerCase())),
    [pending],
  );

  const decorated = useMemo(
    () => candidates.filter((c) => !queuedEmails.has(c.email.toLowerCase())),
    [candidates, queuedEmails],
  );

  const visible = useMemo(
    () =>
      decorated.filter((c) => kindFilter === "all" || c.kind === kindFilter),
    [decorated, kindFilter],
  );

  const visibleEmails = useMemo(() => new Set(visible.map((c) => c.email)), [visible]);

  /**
   * Who a click actually acts on: selected AND currently visible.
   *
   * Intersecting at use time rather than pruning `selected` on filter change is deliberate —
   * pruning destroyed the selection as soon as you tabbed between filters to look around, so you
   * came back to an empty, disabled button. Someone filtered out of view is never queued either
   * way; this just keeps their checkbox remembered if you switch back.
   */
  const effectiveSelected = useMemo(
    () => [...selected].filter((e) => visibleEmails.has(e)),
    [selected, visibleEmails],
  );

  const hiddenCount = decorated.length - visible.length;
  const hiddenSelectedCount = selected.size - effectiveSelected.length;

  async function queue() {
    onError(null);
    try {
      const result = await localRemindersQueue(token, effectiveSelected);
      // Refresh first: load() sets its own status, so confirming before it would be overwritten
      // and the operator would never see what the click actually did.
      await load();
      if (result.autoSend) {
        onStatus(
          `Sent ${result.sent} Slack DM${result.sent === 1 ? "" : "s"}${result.failed ? `, ${result.failed} failed` : ""}.`,
        );
      } else {
        onStatus(
          `Queued ${result.queued} reminder${result.queued === 1 ? "" : "s"} — they have moved to the queue below. Slack DMs are delivered by /send-fieldcam-reminders.`,
        );
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function cancelSelected() {
    onError(null);
    if (!selectedPending.size) return;
    try {
      const result = await localRemindersCancel(token, [...selectedPending]);
      onStatus(`Cancelled ${result.cancelled} queued reminders.`);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card className="space-y-6 p-5">
      <div className="space-y-3">
        <p className="text-sm text-[var(--color-text-muted)]">
          Preview eligible people, then queue a batch. Queueing marks who should be nudged — the
          Slack DMs are delivered separately by <code>/send-fieldcam-reminders</code> unless the server
          has a Slack bot token configured.
        </p>
        {blocked && (
          <p className="text-sm text-[var(--color-danger)]">{blockReason}</p>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <span className="text-[var(--color-text-muted)]">
            {refreshedAt ? (
              <>
                Last refreshed{" "}
                <span
                  className="font-medium text-[var(--color-text)]"
                  title={new Date(refreshedAt).toLocaleString()}
                >
                  {relativeTime(refreshedAt, nowMs)}
                </span>
              </>
            ) : (
              "Not refreshed yet"
            )}
          </span>

          <span className="flex items-center gap-1">
            <span className="text-[var(--color-text-muted)]">Type</span>
            {(["all", "onboarding", "inactivity"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKindFilter(k)}
                className={`rounded-md px-2 py-1 capitalize ${
                  kindFilter === k
                    ? "bg-[var(--color-accent)] font-semibold text-[#e8edf4]"
                    : "border border-[var(--color-border)] text-[var(--color-text-muted)]"
                }`}
              >
                {k}
                {k !== "all" ? ` (${decorated.filter((c) => c.kind === k).length})` : ""}
              </button>
            ))}
          </span>


          {hiddenCount > 0 && (
            <span className="text-[var(--color-text-faint)]">
              {hiddenCount} hidden
              {hiddenSelectedCount > 0 ? ` (${hiddenSelectedCount} selected, will not be sent)` : ""}
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm"
          >
            Refresh
          </button>
          <button
            type="button"
            disabled={visible.length === 0}
            onClick={() => setSelected(new Set(visible.map((c) => c.email)))}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Select all
          </button>
          <button
            type="button"
            disabled={effectiveSelected.length === 0}
            onClick={() => setSelected(new Set())}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Unselect all
          </button>
          <button
            type="button"
            disabled={blocked || effectiveSelected.length === 0}
            onClick={() => void queue()}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[#e8edf4] disabled:opacity-50"
          >
            Queue and send ({effectiveSelected.length})
          </button>
        </div>
        {visible.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            {decorated.length === 0
              ? pending.length > 0
                ? "Everyone eligible is already queued below."
                : "No eligible recipients."
              : `No recipients match the current filters (${decorated.length} hidden).`}
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((c) => (
              <li
                key={c.email}
                className="flex items-start gap-3 rounded-md border border-[var(--color-border-soft)] p-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.email)}
                  onChange={(e) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(c.email);
                      else next.delete(c.email);
                      return next;
                    });
                  }}
                />
                <div>
                  <p className="font-medium text-[var(--color-text)]">
                    {c.name}{" "}
                    <span className="text-[var(--color-text-muted)]">
                      · {c.cameraId || "no camera"} · {c.kind}
                    </span>
                  </p>
                  <p className="text-[var(--color-text-muted)]">{c.reason}</p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">{c.text}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3 border-t border-[var(--color-border-soft)] pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-[var(--color-text)]">
            Queued for Slack ({pending.length})
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending.length === 0}
              onClick={() => setSelectedPending(new Set(pending.map((n) => n.id)))}
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Select all
            </button>
            <button
              type="button"
              disabled={selectedPending.size === 0}
              onClick={() => setSelectedPending(new Set())}
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Unselect all
            </button>
            <button
              type="button"
              disabled={selectedPending.size === 0}
              onClick={() => void cancelSelected()}
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Cancel selected
            </button>
          </div>
        </div>
        {pending.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">Queue is empty.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((n) => (
              <li
                key={n.id}
                className="flex items-start gap-3 rounded-md border border-[var(--color-border-soft)] p-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selectedPending.has(n.id)}
                  onChange={(e) => {
                    setSelectedPending((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(n.id);
                      else next.delete(n.id);
                      return next;
                    });
                  }}
                />
                <div>
                  <p className="font-medium text-[var(--color-text)]">
                    {n.name || n.email} · {n.kind} · {n.cameraId || "—"}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">{n.text}</p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    queued {n.queuedAt || n.id.slice(0, 8)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function AdjustScoresPanel({
  token,
  onStatus,
  onError,
}: {
  token: string;
  onStatus: (s: string | null) => void;
  onError: (s: string | null) => void;
}) {
  const [people, setPeople] = useState<
    Awaited<ReturnType<typeof localScorePeople>>["people"]
  >([]);
  const [weekStart, setWeekStart] = useState("");
  const [adjustments, setAdjustments] = useState<
    Awaited<ReturnType<typeof localListScoreAdjustments>>["adjustments"]
  >([]);
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"delta" | "set">("delta");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = people.find((p) => p.email === email);

  const load = useCallback(async () => {
    const [roster, listed] = await Promise.all([
      localScorePeople(token),
      localListScoreAdjustments(token),
    ]);
    setPeople(roster.people);
    setWeekStart(roster.weekStart);
    setAdjustments(listed.adjustments);
  }, [token]);

  useEffect(() => {
    void load().catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [load, onError]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(amount);
    if (!Number.isFinite(n)) {
      onError("Enter a number.");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const result = await localAdjustScore(token, {
        email,
        reason,
        ...(mode === "set" ? { setTotal: n } : { delta: n }),
      });
      onStatus(
        `${result.adjustment.name}: ${result.beforePoints} → ${result.afterPoints} (${result.adjustment.deltaPoints > 0 ? "+" : ""}${result.adjustment.deltaPoints}). Leaderboard updated.`,
      );
      setAmount("");
      setReason("");
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(adjustmentId: string) {
    setBusy(true);
    onError(null);
    try {
      await localRevokeScoreAdjustment(token, adjustmentId);
      onStatus("Adjustment revoked and scores recomputed.");
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <p className="text-sm text-[var(--color-text-muted)]">
        Change one person’s score for this competition period. Add or subtract points, or set
        their total. A reason is required and the change stays after imports. Challenge bonuses
        still live on the Challenges tab.
      </p>
      {weekStart && (
        <p className="text-xs text-[var(--color-text-muted)]">Period starting {weekStart}</p>
      )}
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          Person
          <select
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          >
            <option value="">Select participant</option>
            {people.map((p) => (
              <option key={p.email} value={p.email}>
                {p.name} ({p.email}) · {p.totalPoints} pts
                {p.rank != null ? ` · rank ${p.rank}` : ""}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <p className="sm:col-span-2 text-sm text-[var(--color-text)]">
            Current total: <span className="font-semibold">{selected.totalPoints}</span>
            {selected.rank != null ? ` · rank ${selected.rank}` : ""}
          </p>
        )}
        <label className="flex flex-col gap-1 text-sm">
          Change
          <select
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            value={mode}
            onChange={(e) => setMode(e.target.value as "delta" | "set")}
          >
            <option value="delta">Add / subtract points</option>
            <option value="set">Set total to</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {mode === "set" ? "New total" : "Points (use a negative to subtract)"}
          <input
            type="number"
            step="any"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={mode === "set" ? "e.g. 100" : "e.g. 25 or -10"}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          Reason
          <input
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why this person’s score is changing"
            required
          />
        </label>
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[#e8edf4] disabled:opacity-50"
          >
            {busy ? "Saving…" : "Apply score change"}
          </button>
        </div>
      </form>
      {adjustments.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">No admin adjustments this period.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <tr>
              <th className="py-2">Person</th>
              <th className="py-2">Change</th>
              <th className="py-2">Reason</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {adjustments.map((a) => (
              <tr key={a.adjustmentId} className="border-t border-[var(--color-border-soft)]">
                <td className="py-2">{a.name}</td>
                <td className="py-2 font-mono">
                  {a.deltaPoints > 0 ? "+" : ""}
                  {a.deltaPoints}
                  {a.setTo != null ? ` (set to ${a.setTo})` : ""}
                </td>
                <td className="py-2 text-[var(--color-text-muted)]">{a.reason}</td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revoke(a.adjustmentId)}
                    className="text-xs text-[var(--color-danger)] disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ChallengesPanel({
  token,
  onStatus,
  onError,
}: {
  token: string;
  onStatus: (s: string | null) => void;
  onError: (s: string | null) => void;
}) {
  const [people, setPeople] = useState<
    Awaited<ReturnType<typeof localListParticipants>>["participants"]
  >([]);
  const [awards, setAwards] = useState<
    Awaited<ReturnType<typeof localListChallenges>>["awards"]
  >([]);
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [points, setPoints] = useState("50");
  const [notes, setNotes] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [roster, listed] = await Promise.all([
      localListParticipants(token, "all"),
      localListChallenges(token),
    ]);
    setPeople(roster.participants.filter((p) => p.signupStatus !== "rejected"));
    setAwards(listed.awards);
  }, [token]);

  useEffect(() => {
    void load().catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [load, onError]);

  async function award(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError(null);
    try {
      const result = await localAwardChallenge(token, {
        email,
        title,
        points: Number(points),
        notes: notes.trim() || undefined,
        cameraId: cameraId.trim() || undefined,
      });
      onStatus(
        `Awarded ${result.award.points} pts to ${result.award.name} for “${result.award.title}”. Leaderboard recomputed.`,
      );
      setTitle("");
      setNotes("");
      setCameraId("");
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(awardId: string) {
    setBusy(true);
    onError(null);
    try {
      await localRevokeChallenge(token, awardId);
      onStatus("Challenge award revoked and scores recomputed.");
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <p className="text-sm text-[var(--color-text-muted)]">
        Give a one-off bonus for a named challenge (first bicycle recording, best livestream,
        etc.). Points land on this Phoenix week and show as Challenge bonus on the
        leaderboard. Unscoped awards attach to the person’s first camera row so they are
        not double-counted.
      </p>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => void award(e)}>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          Challenge
          <input
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="First bicycle recording"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Person
          <select
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          >
            <option value="">Select participant</option>
            {people.map((p) => (
              <option key={p.email} value={p.email}>
                {p.name} ({p.email})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Points
          <input
            type="number"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Camera (optional)
          <input
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono"
            value={cameraId}
            onChange={(e) => setCameraId(e.target.value)}
            placeholder="Leave blank to attach to their first camera"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Notes (optional)
          <input
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Link to the clip, judge, etc."
          />
        </label>
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[#e8edf4] disabled:opacity-50"
          >
            {busy ? "Saving…" : "Award points"}
          </button>
        </div>
      </form>
      {awards.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">No challenge awards this week.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-[var(--color-text-muted)]">
            <tr>
              <th className="py-2">Challenge</th>
              <th>Person</th>
              <th>Points</th>
              <th>Camera</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {awards.map((a) => (
              <tr key={a.awardId} className="border-t border-[var(--color-border-soft)]">
                <td className="py-2">
                  <div>{a.title}</div>
                  {a.notes ? (
                    <div className="text-xs text-[var(--color-text-muted)]">{a.notes}</div>
                  ) : null}
                </td>
                <td>
                  {a.name}
                  <div className="text-xs text-[var(--color-text-muted)]">{a.email}</div>
                </td>
                <td className="font-semibold">{a.points}</td>
                <td className="font-mono text-xs">{a.cameraId || "—"}</td>
                <td>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revoke(a.awardId)}
                    className="text-xs text-[var(--color-danger)] disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ScoringPanel({
  token,
  onStatus,
  onError,
}: {
  token: string;
  onStatus: (s: string | null) => void;
  onError: (s: string | null) => void;
}) {
  const [active, setActive] = useState<Awaited<ReturnType<typeof localScoringActive>> | null>(
    null,
  );
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof localCopyScoringDraft>> | null>(
    null,
  );
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof localPreviewScoringDraft>
  > | null>(null);
  const [emergencyReason, setEmergencyReason] = useState("");
  const [scheduleReason, setScheduleReason] = useState("");
  // Clearing activity is on by default: scores rebuild from activity_events otherwise, so a reset
  // that keeps it is only a recalculation.
  const [resetActivity, setResetActivity] = useState(true);
  const [resetManual, setResetManual] = useState(false);
  const [resetReports, setResetReports] = useState(false);
  /** Editable copy of the live rules; edits stay local until something needs a draft. */
  const [rules, setRules] = useState<
    Awaited<ReturnType<typeof localCopyScoringDraft>>["rules"]
  >([]);
  const [dirty, setDirty] = useState(false);

  const refreshActive = useCallback(async () => {
    const a = await localScoringActive();
    setActive(a);
    // Seed the editor with what is live, so the breakdown is on screen straight away rather than
    // hidden behind a "copy to draft" step.
    setRules(
      a.rules.map((r) => ({
        metricKey: r.metricKey,
        label: r.label,
        pointsPerUnit: r.pointsPerUnit,
        enabled: r.enabled,
        displayOrder: r.displayOrder,
        aggregation: r.aggregation,
        minimum: r.minimum,
        cap: r.cap,
        paramsJson: r.paramsJson,
      })),
    );
    setDirty(false);
  }, []);

  useEffect(() => {
    void refreshActive().catch((err) =>
      onError(err instanceof Error ? err.message : String(err)),
    );
  }, [onError, refreshActive]);

  /**
   * Anything that leaves the browser needs a draft to write into — the live profile is never edited
   * in place. Created on demand so simply opening the tab does not litter the database with drafts.
   */
  async function ensureDraft(): Promise<{ profileId: string; version: number }> {
    const target = draft ?? (await localCopyScoringDraft(token));
    if (!draft) setDraft(target);
    await localUpdateScoringDraft(token, {
      profileId: target.profileId,
      version: target.version,
      rules,
    });
    return { profileId: target.profileId, version: target.version };
  }

  async function saveDraft() {
    onError(null);
    try {
      const d = await ensureDraft();
      setDirty(false);
      onStatus(`Saved to draft ${d.profileId.slice(0, 8)}…@${d.version}. Not live yet.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function validate() {
    onError(null);
    try {
      const d = await ensureDraft();
      setDirty(false);
      const v = await localValidateScoringDraft(token, d.profileId, d.version);
      if (v.errors.length) onError(v.errors.join("; "));
      else onStatus(`Draft valid. Next Monday Phoenix: ${v.nextMonday}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runPreview() {
    onError(null);
    try {
      const d = await ensureDraft();
      setDirty(false);
      const p = await localPreviewScoringDraft(token, d.profileId, d.version);
      setPreview(p);
      onStatus(
        `Preview: ${p.deltas.length} score/rank deltas for week ${p.weekStart}. Schedule target ${p.nextMonday}.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function schedule() {
    if (!preview) {
      onError("Run preview first so the next-Monday target is known.");
      return;
    }
    onError(null);
    try {
      const d = await ensureDraft();
      await localScheduleScoringDraft(
        token,
        d.profileId,
        d.version,
        preview.nextMonday,
        scheduleReason || "Scheduled for next Monday Phoenix",
      );
      onStatus(`Scheduled for ${preview.nextMonday}.`);
      setDraft(null);
      setPreview(null);
      setDirty(false);
      await refreshActive();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function emergency() {
    if (!emergencyReason.trim()) {
      onError("Emergency midweek activate requires an audit reason.");
      return;
    }
    onError(null);
    try {
      const d = await ensureDraft();
      const result = (await localEmergencyActivateScoring(
        token,
        d.profileId,
        d.version,
        emergencyReason.trim(),
      )) as { weekStart?: string; scores?: { count: number } };
      onStatus(
        `Emergency activated for open week ${result.weekStart}. Recomputed ${result.scores?.count ?? "?"} scores.`,
      );
      setDraft(null);
      setPreview(null);
      setEmergencyReason("");
      await refreshActive();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function recompute() {
    onError(null);
    try {
      const r = await localRecomputeScores(token);
      onStatus(
        `Recomputed ${r.scores.count} scores · profile ${r.scores.profileId}@${r.scores.version}`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resetScores() {
    onError(null);
    try {
      // Dry run first so the confirmation states exactly what disappears.
      const preview = await localResetScores(token, {
        clearActivity: resetActivity,
        clearManual: resetManual,
        clearReports: resetReports,
        dryRun: true,
      });
      const c = preview.cleared;
      const lines = [
        `${c.weeklyScores} score row(s)`,
        `${c.dailyActivity} daily activity row(s)`,
        resetActivity ? `${c.activityEvents} imported recording/upload event(s)` : null,
        resetActivity && c.quarantinedActivity
          ? `${c.quarantinedActivity} quarantined event(s)`
          : null,
        resetManual
          ? `${c.scoreAdjustments} admin adjustment(s) and ${c.challengeAwards} challenge bonus(es)`
          : null,
        resetReports ? `${c.reports} report(s)` : null,
      ].filter(Boolean);
      const ok = window.confirm(
        `Reset every period's scores to zero?\n\nThis permanently deletes:\n· ${lines.join("\n· ")}` +
          (resetActivity
            ? "\n\nThe board stays empty until the next CSV import."
            : "\n\nImported activity is kept, so scores will rebuild to the same numbers — uncheck nothing if you wanted a true reset.") +
          "\n\nThis cannot be undone.",
      );
      if (!ok) return;
      const r = await localResetScores(token, {
        clearActivity: resetActivity,
        clearManual: resetManual,
        clearReports: resetReports,
        dryRun: false,
      });
      onStatus(
        `Scores reset across ${r.weeksRecomputed.length} period(s). Cleared ${r.cleared.weeklyScores} score row(s)` +
          (resetActivity ? ` and ${r.cleared.activityEvents} activity event(s).` : "."),
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function snapshot() {
    onError(null);
    try {
      const s = (await localSnapshotWeek(token, "admin_manual")) as {
        weekStart: string;
        revision: number;
        profileId: string;
        version: number;
      };
      onStatus(
        `Snapshot ${s.weekStart} rev ${s.revision} bound to ${s.profileId}@${s.version}.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  const rows = rules;

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Scoring rules</h2>
          {active && (
            <p className="text-xs text-[var(--color-text-muted)]">
              Live: <strong className="text-[var(--color-text)]">{active.name}</strong> (
              {active.profileId}@{active.version})
            </p>
          )}
        </div>

        <p className="text-xs text-[var(--color-text-faint)]">
          {dirty
            ? "Unsaved edits — nothing changes for participants until you schedule or emergency-activate."
            : "These are the live point values. Edit any of them, then preview the effect before activating."}
        </p>

        <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
                  <tr>
                    <th className="py-2 pr-3">On</th>
                    <th className="py-2 pr-3">Metric</th>
                    <th className="py-2 pr-3">Points / unit</th>
                    <th className="py-2">Cap</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((rule, idx) => (
                    <tr key={rule.metricKey} className="border-t border-[var(--color-border-soft)]">
                      <td className="py-2 pr-3">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5"
                          checked={rule.enabled}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setRules((rs) =>
                              rs.map((r, i) => (i === idx ? { ...r, enabled: checked } : r)),
                            );
                            setDirty(true);
                          }}
                        />
                      </td>
                      <td className="py-2 pr-3 text-[var(--color-text)]">{rule.label}</td>
                      <td className="py-2 pr-3">
                        <input
                          type="number"
                          className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
                          value={rule.pointsPerUnit}
                          onChange={(e) => {
                            const value = Number(e.target.value);
                            setRules((rs) =>
                              rs.map((r, i) => (i === idx ? { ...r, pointsPerUnit: value } : r)),
                            );
                            setDirty(true);
                          }}
                        />
                      </td>
                      <td className="py-2 text-[var(--color-text-muted)]">{rule.cap ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void saveDraft()}
                className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold"
              >
                Save draft
              </button>
              <button
                type="button"
                onClick={() => void validate()}
                className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold"
              >
                Validate
              </button>
              <button
                type="button"
                onClick={() => void runPreview()}
                className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold"
              >
                Preview deltas
              </button>
              <button
                type="button"
                disabled={!dirty}
                onClick={() => {
                  setPreview(null);
                  void refreshActive();
                }}
                className="ml-auto rounded-lg px-3 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40"
              >
                Revert to live
              </button>
            </div>

            {preview && (
              <div className="space-y-2 rounded-md border border-[var(--color-border-soft)] p-4">
                <p className="text-sm font-medium text-[var(--color-text)]">
                  Effect on the current period ({preview.weekStart})
                </p>
                {preview.unavailableMetrics.length > 0 && (
                  <p className="text-xs text-[var(--color-text-muted)]">
                    No reliable source data yet for: {preview.unavailableMetrics.join(", ")}
                  </p>
                )}
                <DeltaTable deltas={preview.deltas} />
              </div>
            )}

            <div className="space-y-3 border-t border-[var(--color-border-soft)] pt-4">
              <h3 className="text-sm font-semibold text-[var(--color-text)]">Activate</h3>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                Schedule reason (optional)
                <input
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-text)]"
                  value={scheduleReason}
                  onChange={(e) => setScheduleReason(e.target.value)}
                  placeholder="Why this profile should start next Monday"
                />
              </label>
              <button
                type="button"
                disabled={!preview}
                title={preview ? undefined : "Preview deltas first"}
                onClick={() => void schedule()}
                className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[#e8edf4] disabled:opacity-50"
              >
                Schedule for next Monday (Phoenix)
              </button>

              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                Emergency midweek reason (required)
                <input
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-text)]"
                  value={emergencyReason}
                  onChange={(e) => setEmergencyReason(e.target.value)}
                  placeholder="Audit reason for open-week activate + full recompute"
                />
              </label>
              <button
                type="button"
                disabled={!emergencyReason.trim()}
                onClick={() => void emergency()}
                className="rounded-lg border border-[var(--color-danger)] px-4 py-2 text-sm font-semibold text-[var(--color-danger)] disabled:opacity-50"
              >
                Emergency activate (recompute open week)
              </button>
            </div>
        </>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Maintenance</h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          Recompute rebuilds the open period from imported activity. Snapshot freezes a versioned
          copy of the standings so a period can be audited later.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void recompute()}
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold"
          >
            Recompute open week
          </button>
          <button
            type="button"
            onClick={() => void snapshot()}
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold"
          >
            Snapshot week
          </button>
        </div>
      </Card>

      <Card className="space-y-3 border-[var(--color-danger)]/40 p-5">
        <h2 className="text-sm font-semibold text-[var(--color-danger)]">Danger zone</h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          Puts every period back to zero. Deleting scores alone does nothing — they rebuild from
          imported activity on the next page load — so clearing activity is included by default and
          the board stays empty until the next CSV import.
        </p>
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              checked={resetActivity}
              onChange={(e) => setResetActivity(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Also clear imported activity (recordings, uploads, livestreams)
          </label>
          <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              checked={resetManual}
              onChange={(e) => setResetManual(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Also clear admin adjustments and challenge bonuses
          </label>
          <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              checked={resetReports}
              onChange={(e) => setResetReports(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Also clear reports
          </label>
        </div>
        <button
          type="button"
          onClick={() => void resetScores()}
          className="rounded-md border border-[var(--color-danger)] px-3 py-1.5 text-xs font-bold text-[var(--color-danger)]"
        >
          Reset all scores…
        </button>
      </Card>
    </div>
  );
}

function ReportsPanel({
  token,
  onStatus,
  onError,
}: {
  token: string;
  onStatus: (s: string | null) => void;
  onError: (s: string | null) => void;
}) {
  const [reports, setReports] = useState<
    Awaited<ReturnType<typeof localListReports>>["reports"]
  >([]);
  const [people, setPeople] = useState<
    Awaited<ReturnType<typeof localListParticipants>>["participants"]
  >([]);
  const [email, setEmail] = useState("");
  const [text, setText] = useState("");
  const [slackUrl, setSlackUrl] = useState("");
  const [reportedAt, setReportedAt] = useState("");
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    onError(null);
    try {
      const [res, roster] = await Promise.all([
        localListReports(token),
        localListParticipants(token, "all"),
      ]);
      setReports(res.reports);
      setPeople(roster.participants.filter((p) => p.signupStatus !== "rejected"));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [token, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addReport(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError(null);
    try {
      const result = await localCreateReport(token, {
        email,
        text: text.trim() || undefined,
        slackMessageUrl: slackUrl.trim() || undefined,
        // A date-only value is midday UTC so the Phoenix day it lands on is unambiguous.
        reportedAtUtc: reportedAt ? `${reportedAt}T12:00:00.000Z` : undefined,
      });
      onStatus(`Report added for ${result.email} \u2014 scores recomputed.`);
      setText("");
      setSlackUrl("");
      setReportedAt("");
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function uploadCsv() {
    if (!csvFile) {
      onError("Choose a reports CSV first.");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const csv = await csvFile.text();
      const result = await localIntakeReports(token, { csv, dryRun: false });
      onStatus(
        `CSV intake: ${result.inserted} added, ${result.skippedDuplicate} already had, ${result.skippedUnknownEmail} off roster, ${result.skippedNoUrl} missing a link` +
          (result.failed ? `, ${result.failed} failed to write.` : "."),
      );
      setCsvFile(null);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const nameByEmail = new Map(people.map((p) => [p.email.toLowerCase(), p.name]));

  return (
    <Card className="space-y-4 p-5">
      <form
        onSubmit={(e) => void addReport(e)}
        className="space-y-3 rounded-md border border-[var(--color-border-soft)] p-4"
      >
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Add a report</h2>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Credit someone for a finding they posted in{" "}
            <code className="text-[var(--color-text)]">#fieldcam-selfhost</code>. Adding it here counts
            it &mdash; there is no separate approval step.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-[var(--color-text-muted)]">
            Person
            <select
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            >
              <option value="">Select a participant&hellip;</option>
              {people.map((p) => (
                <option key={p.email} value={p.email}>
                  {p.name} ({p.email})
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--color-text-muted)]">
            Date (optional &mdash; defaults to today)
            <input
              type="date"
              value={reportedAt}
              onChange={(e) => setReportedAt(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            />
          </label>
        </div>
        <label className="block text-xs text-[var(--color-text-muted)]">
          What they found
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="Event button has dead zones on the USB side of both cameras"
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
        <label className="block text-xs text-[var(--color-text-muted)]">
          Slack link (optional)
          <input
            type="url"
            value={slackUrl}
            onChange={(e) => setSlackUrl(e.target.value)}
            placeholder="https://northline.slack.com/archives/..."
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !email}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-bold text-[#e8edf4] disabled:opacity-50"
        >
          {busy ? "Adding\u2026" : "Add report"}
        </button>
      </form>

      <div className="space-y-2 rounded-md border border-[var(--color-border-soft)] p-4">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Upload reports CSV</h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          Full dump from <code className="text-[var(--color-text)]">npm --prefix server run reports:gather</code>.
          Links already on this instance are skipped; new roster rows are added and score immediately.
        </p>
        <label className="block text-xs text-[var(--color-text-muted)]">
          CSV
          <input
            type="file"
            accept=".csv,text/csv"
            className="file-input mt-1"
            onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
          />
          {csvFile ? (
            <span className="mt-1 block text-xs text-[var(--color-text-muted)]">{csvFile.name}</span>
          ) : null}
        </label>
        <button
          type="button"
          disabled={busy || !csvFile}
          onClick={() => void uploadCsv()}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-bold text-[#e8edf4] disabled:opacity-50"
        >
          {busy ? "Uploading\u2026" : "Upload CSV"}
        </button>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-[var(--color-text)]">
          Report history{reports.length ? ` (${reports.length})` : ""}
        </h2>
        {reports.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">No reports yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {reports.map((r) => (
              <li
                key={r.reportId}
                className="rounded-md border border-[var(--color-border-soft)] p-3 text-sm"
              >
                <p className="font-medium text-[var(--color-text)]">
                  {nameByEmail.get(r.email.toLowerCase()) || r.email}
                  {r.status !== "approved" && (
                    <span className="ml-2 text-xs font-normal text-[var(--color-text-faint)]">
                      {r.status}
                    </span>
                  )}
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Reported {formatReportDate(r.reportedAtUtc)}
                  {r.createdBy ? ` \u00b7 added by ${r.createdBy}` : ""}
                  {r.createdAt ? ` on ${formatReportDate(r.createdAt)}` : ""}
                </p>
                {r.text && (
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">{r.text}</p>
                )}
                {r.slackMessageUrl && (
                  <a
                    className="text-xs text-[var(--color-accent)] underline"
                    href={r.slackMessageUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Slack message
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function formatReportDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
