import { useMemo, useState } from "react";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import ParticipantName, { ParticipantAvatar } from "../components/ParticipantName";
import StatusPill from "../components/StatusPill";
import { WAITLIST_TEAM_ID } from "../config/teams";
import { useAuth } from "../context/AuthContext";
import { useTournament } from "../context/TournamentContext";
import {
  buildPendingNudgeSlackPayload,
  previewNudges,
} from "../data/nudgeNotify";
import { computeInactiveDays, getLastRecordingDate } from "../data/scoring";
import type {
  ActivityRecord,
  Match,
  MatchStage,
  NudgeJobResult,
  NudgeKind,
  Participant,
  PendingNudge,
} from "../data/types";

type AdminTab = "queue" | "roster" | "activity" | "schedule" | "nudges";

export default function Admin() {
  const { session } = useAuth();
  if (!session) {
    return (
      <Card className="mx-auto max-w-md p-6 text-center text-sm text-[var(--color-text-muted)]">
        Admin access requires an allowlisted identity.
      </Card>
    );
  }
  if (session.role !== "admin" && !session.isAdmin) {
    return (
      <Card className="mx-auto max-w-md p-6 text-center text-sm text-[var(--color-text-muted)]">
        Admin access requires an allowlisted email.
      </Card>
    );
  }
  return <AdminContent />;
}

function AdminContent() {
  const {
    backend,
    participants,
    teams,
    activity,
    unassignedSignups,
    pendingNudges,
    assignTeam,
    updateSerial,
    recordReturn,
    setStatus,
    runNudgeJob,
    forceNudge,
    markNudgeSent,
    markNudgeFailed,
    resetDemoData,
  } = useTournament();

  const [tab, setTab] = useState<AdminTab>("queue");
  const [query, setQuery] = useState("");
  const now = new Date().toISOString();

  const activityByEmail = useMemo(() => {
    const map = new Map<string, ActivityRecord[]>();
    for (const r of activity) {
      const list = map.get(r.email) ?? [];
      list.push(r);
      map.set(r.email, list);
    }
    return map;
  }, [activity]);

  const waitlisted = participants.filter((p) => p.teamId === WAITLIST_TEAM_ID);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return participants;
    return participants.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        p.serial.toLowerCase().includes(q),
    );
  }, [participants, query]);

  const tabs: { id: AdminTab; label: string }[] = [
    { id: "queue", label: "Signup queue" },
    { id: "roster", label: "Roster" },
    { id: "activity", label: "Activity" },
    { id: "schedule", label: "Schedule" },
    { id: "nudges", label: "Nudges" },
  ];

  function handleCheckout(p: Participant) {
    const serial = window.prompt(`Device serial for ${p.name}:`, p.serial || "FC-");
    if (serial) updateSerial(p.email, serial);
  }

  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Program admin"
        description="Assign Form signups, edit activity (scores), manage schedule, and run inactivity nudges."
        action={
          <button
            onClick={() => {
              if (confirm("Reset all demo data?")) resetDemoData();
            }}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-muted)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
          >
            Reset demo data
          </button>
        }
      />

      <div className="mb-6 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              tab === t.id
                ? "bg-[var(--color-accent)] text-[var(--color-text)]"
                : "border border-[var(--color-border)] text-[var(--color-text-muted)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "queue" && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-text)]">
            Unassigned Form signups ({unassignedSignups.length})
          </h2>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 font-medium">Email</th>
                  <th className="px-2 py-2 font-medium">Hub</th>
                  <th className="px-2 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium">Assign bucket</th>
                </tr>
              </thead>
              <tbody>
                {unassignedSignups.map((s) => (
                  <tr key={s.email} className="border-t border-[var(--color-border-soft)]">
                    <td className="px-4 py-2.5">
                      <ParticipantName name={s.name} />
                    </td>
                    <td className="px-2 py-2.5 text-[var(--color-text-muted)]">{s.email}</td>
                    <td className="px-2 py-2.5 text-[var(--color-text-muted)]">{s.hub}</td>
                    <td className="px-2 py-2.5 text-[var(--color-text-muted)]">{s.role}</td>
                    <td className="px-4 py-2.5">
                      <select
                        className="input"
                        defaultValue=""
                        onChange={(e) => e.target.value && assignTeam(s.email, e.target.value)}
                      >
                        <option value="" disabled>
                          Select…
                        </option>
                        <option value={WAITLIST_TEAM_ID}>Waitlist</option>
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} (Group {t.group})
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
                {unassignedSignups.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-faint)]">
                      No unassigned Form responses (demo queue empty).
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          <h2 className="mb-3 mt-8 text-sm font-semibold text-[var(--color-text)]">
            Waitlist ({waitlisted.length})
          </h2>
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {waitlisted.map((p) => (
                  <tr key={p.email} className="border-t border-[var(--color-border-soft)]">
                    <td className="px-4 py-2.5">
                      <ParticipantName name={p.name} photoUrl={p.photoUrl} />
                    </td>
                    <td className="px-2 py-2.5 text-[var(--color-text-muted)]">{p.email}</td>
                    <td className="px-4 py-2.5">
                      <select
                        className="input"
                        defaultValue=""
                        onChange={(e) => e.target.value && assignTeam(p.email, e.target.value)}
                      >
                        <option value="" disabled>
                          Move to team…
                        </option>
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
                {waitlisted.length === 0 && (
                  <tr>
                    <td className="px-4 py-6 text-center text-[var(--color-text-faint)]">
                      Waitlist is empty.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        </section>
      )}

      {tab === "roster" && (
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-text)]">
              All participants ({participants.length})
            </h2>
            <input
              className="input max-w-xs"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 font-medium">Email</th>
                  <th className="px-2 py-2 font-medium">Team</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="px-2 py-2 font-medium">Last recording</th>
                  <th className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const team = teams.find((t) => t.id === p.teamId);
                  const records = activityByEmail.get(p.email) ?? [];
                  return (
                    <tr key={p.email} className="border-t border-[var(--color-border-soft)]">
                      <td className="px-4 py-2.5">
                        <ParticipantName name={p.name} photoUrl={p.photoUrl} />
                      </td>
                      <td className="px-2 py-2.5 text-[var(--color-text-muted)]">{p.email}</td>
                      <td className="px-2 py-2.5 text-[var(--color-text-muted)]">
                        {p.teamId === WAITLIST_TEAM_ID ? "Waitlist" : (team?.name ?? "—")}
                      </td>
                      <td className="px-2 py-2.5">
                        <StatusPill status={p.status} />
                        <span className="ml-2 text-[11px] text-[var(--color-text-faint)]">
                          {computeInactiveDays(p, records, now)}d inactive
                        </span>
                      </td>
                      <td className="px-2 py-2.5 text-[var(--color-text-muted)]">
                        {getLastRecordingDate(records) ?? "Never"}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1.5">
                          <select
                            className="input max-w-[140px]"
                            value={p.teamId ?? ""}
                            onChange={(e) => e.target.value && assignTeam(p.email, e.target.value)}
                          >
                            <option value="" disabled>
                              Bucket…
                            </option>
                            <option value={WAITLIST_TEAM_ID}>Waitlist</option>
                            {teams.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => handleCheckout(p)}
                            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px]"
                          >
                            Checkout
                          </button>
                          <button
                            onClick={() => recordReturn(p.email)}
                            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px]"
                          >
                            Return
                          </button>
                          <button
                            onClick={() => setStatus(p.email, p.status === "Active" ? "Inactive" : "Active")}
                            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px]"
                          >
                            Mark {p.status === "Active" ? "Inactive" : "Active"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </section>
      )}

      {tab === "activity" && <ActivityEditor />}
      {tab === "schedule" && <ScheduleEditor />}
      {tab === "nudges" && (
        <NudgePanel
          backend={backend}
          participants={participants}
          activity={activity}
          pendingNudges={pendingNudges}
          runNudgeJob={runNudgeJob}
          forceNudge={forceNudge}
          markNudgeSent={markNudgeSent}
          markNudgeFailed={markNudgeFailed}
        />
      )}
    </div>
  );
}

function NudgePanel({
  backend,
  participants,
  activity,
  pendingNudges,
  runNudgeJob,
  forceNudge,
  markNudgeSent,
  markNudgeFailed,
}: {
  backend: "local" | "sheets";
  participants: Participant[];
  activity: ActivityRecord[];
  pendingNudges: PendingNudge[];
  runNudgeJob: (dryRun: boolean) => Promise<NudgeJobResult>;
  forceNudge: (
    email: string,
    kind: NudgeKind,
    dryRun: boolean,
  ) => Promise<Record<string, unknown>>;
  markNudgeSent: (id: string) => Promise<void>;
  markNudgeFailed: (id: string, error?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<NudgeJobResult | null>(null);
  const [forceEmail, setForceEmail] = useState("");
  const [forceKind, setForceKind] = useState<NudgeKind>("slack_1d");
  const [message, setMessage] = useState<string | null>(null);

  const localPreview = useMemo(
    () => previewNudges(participants, activity),
    [participants, activity],
  );

  const openNudges = pendingNudges.filter((n) => n.status === "pending");

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <Card className="p-4 text-sm text-[var(--color-text-muted)]">
        <p>
          <strong className="text-[var(--color-text)]">Rules:</strong> first checkout → 7-day
          onboarding (Slack queue + email) with stats links. 1 day no action while still checked out
          → Slack use/return. 2+ days → email. Returned devices never get inactivity reminders.
          Repeat checkouts skip onboarding.
        </p>
        <p className="mt-2">
          Backend: <strong className="text-[var(--color-text)]">{backend}</strong>
          {backend === "local" &&
            " — preview only. Deploy Apps Script + set VITE_APPS_SCRIPT_URL to enqueue/send."}
        </p>
        <p className="mt-2 text-xs text-[var(--color-text-faint)]">
          UAT tip: set Script Property <code>NUDGE_TEST_ALLOWLIST</code> to your email before running
          a live job.
        </p>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Run nudge job</h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || backend !== "sheets"}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
            onClick={() =>
              withBusy(async () => {
                const result = await runNudgeJob(true);
                setLastResult(result);
                setMessage(
                  `Dry run: ${result.slack.length} Slack, ${result.email.length} email, ${result.skipped.length} skipped.`,
                );
              })
            }
          >
            Dry run (Sheets)
          </button>
          <button
            type="button"
            disabled={busy || backend !== "sheets"}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] disabled:opacity-40"
            onClick={() => {
              if (
                !confirm(
                  "Enqueue Slack nudges and send emails for eligible participants? Use allowlist for UAT.",
                )
              ) {
                return;
              }
              void withBusy(async () => {
                const result = await runNudgeJob(false);
                setLastResult(result);
                setMessage(
                  `Live run: queued ${result.slack.length} Slack, emailed ${result.email.length}.`,
                );
              });
            }}
          >
            Run live job
          </button>
        </div>
        {message && <p className="mt-3 text-xs text-[var(--color-text)]">{message}</p>}
        {lastResult && (
          <pre className="mt-3 max-h-48 overflow-auto rounded-md bg-[var(--color-bg-elevated)] p-3 text-[10px] text-[var(--color-text-muted)]">
            {JSON.stringify(lastResult, null, 2)}
          </pre>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text)]">
          Local preview (client rules)
        </h2>
        <p className="mb-2 text-xs text-[var(--color-text-faint)]">
          {localPreview.slack.length} would get Slack · {localPreview.email.length} would get email ·{" "}
          {localPreview.skipped.length} skipped (cooldown)
        </p>
        <button
          type="button"
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold"
          onClick={() => {
            console.info("Local nudge preview", localPreview);
            alert("Preview logged to console.");
          }}
        >
          Log preview to console
        </button>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Force nudge (test)</h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            Email
            <input
              className="input mt-1 block min-w-[220px]"
              value={forceEmail}
              onChange={(e) => setForceEmail(e.target.value)}
              placeholder="you@northline.example"
            />
          </label>
          <label className="text-xs">
            Kind
            <select
              className="input mt-1 block"
              value={forceKind}
              onChange={(e) => setForceKind(e.target.value as NudgeKind)}
            >
              <option value="onboarding_7day">Onboarding (7-day plan + stats)</option>
              <option value="slack_1d">Slack (1d no action — use/return)</option>
              <option value="email_2d">Email (2d no activity)</option>
            </select>
          </label>
          <button
            type="button"
            disabled={busy || backend !== "sheets" || !forceEmail.trim()}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
            onClick={() =>
              withBusy(async () => {
                const result = await forceNudge(forceEmail.trim(), forceKind, true);
                console.info("Force nudge dry run", result);
                setMessage("Force dry run logged to console.");
              })
            }
          >
            Preview
          </button>
          <button
            type="button"
            disabled={busy || backend !== "sheets" || !forceEmail.trim()}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
            onClick={() => {
              if (!confirm(`Force ${forceKind} for ${forceEmail}?`)) return;
              void withBusy(async () => {
                const result = await forceNudge(forceEmail.trim(), forceKind, false);
                console.info("Force nudge result", result);
                setMessage(`Forced ${forceKind} for ${forceEmail}.`);
              });
            }}
          >
            Send / enqueue
          </button>
        </div>
      </Card>

      <Card className="overflow-x-auto">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">
            Pending Slack nudges ({openNudges.length})
          </h2>
          {openNudges.length > 0 && (
            <button
              type="button"
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold"
              onClick={() => {
                const payloads = openNudges.map(buildPendingNudgeSlackPayload);
                console.info(
                  "Pending inactivity Slack payloads — use Slack MCP send_slack_bot_message with channel=email",
                  payloads,
                );
                alert(
                  `${payloads.length} payload(s) logged. In Cursor: send_slack_bot_message channel=<email>. Then Mark sent.`,
                );
              }}
            >
              Log MCP payloads
            </button>
          )}
        </div>
        <table className="w-full min-w-[700px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
              <th className="px-4 py-2 font-medium">To</th>
              <th className="px-2 py-2 font-medium">Kind</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium">Created</th>
              <th className="px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {pendingNudges.map((n) => (
              <tr key={n.id} className="border-t border-[var(--color-border-soft)] align-top">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-[var(--color-text)]">{n.name || n.email}</div>
                  <div className="text-xs text-[var(--color-text-faint)]">
                    {n.email} · {n.serial}
                  </div>
                </td>
                <td className="px-2 py-2.5 text-[var(--color-text-muted)]">{n.kind}</td>
                <td className="px-2 py-2.5 text-[var(--color-text-muted)]">{n.status}</td>
                <td className="px-2 py-2.5 text-xs text-[var(--color-text-faint)]">
                  {n.createdAt ? new Date(n.createdAt).toLocaleString() : "—"}
                </td>
                <td className="px-4 py-2.5">
                  {n.status === "pending" && (
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs"
                        onClick={() => {
                          console.info("Slack MCP payload", buildPendingNudgeSlackPayload(n));
                          alert("Payload logged. Send with send_slack_bot_message, then Mark sent.");
                        }}
                      >
                        Log
                      </button>
                      <button
                        type="button"
                        disabled={busy || backend !== "sheets"}
                        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-40"
                        onClick={() =>
                          withBusy(async () => {
                            await markNudgeSent(n.id);
                            setMessage(`Marked ${n.id} sent.`);
                          })
                        }
                      >
                        Mark sent
                      </button>
                      <button
                        type="button"
                        disabled={busy || backend !== "sheets"}
                        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-40"
                        onClick={() =>
                          withBusy(async () => {
                            await markNudgeFailed(n.id, "manual_fail");
                            setMessage(`Marked ${n.id} failed.`);
                          })
                        }
                      >
                        Fail
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {pendingNudges.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-faint)]">
                  No pending nudges yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

function ActivityEditor() {
  const { participants, activity, upsertActivity, deleteActivity } = useTournament();
  const [email, setEmail] = useState(participants[0]?.email ?? "");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [recordings, setRecordings] = useState(1);
  const [hours, setHours] = useState(1);
  const [uploads, setUploads] = useState(0);
  const [livestreams, setLivestreams] = useState(0);
  const [reports, setReports] = useState(0);
  const selected = participants.find((p) => p.email === email);

  const rows = activity
    .filter((a) => a.email === email)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));

  function save() {
    upsertActivity({ email, date, recordings, hours, uploads, livestreams, reports });
  }

  return (
    <section className="grid gap-6 lg:grid-cols-2">
      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Edit activity (feeds scores)</h2>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            Participant
            <div className="flex items-center gap-2">
              {selected && (
                <ParticipantAvatar name={selected.name} photoUrl={selected.photoUrl} size="md" />
              )}
              <select className="input flex-1" value={email} onChange={(e) => setEmail(e.target.value)}>
                {participants.map((p) => (
                  <option key={p.email} value={p.email}>
                    {p.name} ({p.email})
                  </option>
                ))}
              </select>
            </div>
          </label>
          <label className="flex flex-col gap-1">
            Date
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          {(
            [
              ["Recordings", recordings, setRecordings],
              ["Hours", hours, setHours],
              ["Uploads", uploads, setUploads],
              ["Livestreams", livestreams, setLivestreams],
              ["Reports", reports, setReports],
            ] as const
          ).map(([label, value, set]) => (
            <label key={label} className="flex flex-col gap-1">
              {label}
              <input
                className="input"
                type="number"
                min={0}
                step={label === "Hours" ? 0.1 : 1}
                value={value}
                onChange={(e) => set(Number(e.target.value))}
              />
            </label>
          ))}
          <button
            type="button"
            onClick={save}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[var(--color-text)]"
          >
            Save activity row
          </button>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <div className="border-b border-[var(--color-border-soft)] px-4 py-3 text-sm font-semibold">
          Rows for selected person
        </div>
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.email}-${r.date}`} className="border-t border-[var(--color-border-soft)]">
                <td className="px-4 py-2 font-mono text-xs">{r.date}</td>
                <td className="px-2 py-2 text-[var(--color-text-muted)]">
                  rec {r.recordings} · hr {r.hours} · up {r.uploads} · live {r.livestreams} · rpt{" "}
                  {r.reports}
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    className="text-xs text-[var(--color-danger)]"
                    onClick={() => deleteActivity(r.email, r.date)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-[var(--color-text-faint)]" colSpan={3}>
                  No activity rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

function ScheduleEditor() {
  const { teams, matches, upsertMatch, deleteMatch, createMatch } = useTournament();
  const [draft, setDraft] = useState({
    stage: "group" as MatchStage,
    group: "A" as "A" | "B",
    homeTeamId: teams[0]?.id ?? "",
    awayTeamId: teams[1]?.id ?? "",
    startDate: new Date().toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
  });

  function patch(match: Match, updates: Partial<Match>) {
    upsertMatch({ ...match, ...updates });
  }

  return (
    <section className="flex flex-col gap-6">
      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold">Add match</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          <label className="flex flex-col gap-1">
            Stage
            <select
              className="input"
              value={draft.stage}
              onChange={(e) => setDraft({ ...draft, stage: e.target.value as MatchStage })}
            >
              <option value="group">group</option>
              <option value="semifinal">semifinal</option>
              <option value="final">final</option>
              <option value="thirdPlace">thirdPlace</option>
            </select>
          </label>
          {draft.stage === "group" && (
            <label className="flex flex-col gap-1">
              Group
              <select
                className="input"
                value={draft.group}
                onChange={(e) => setDraft({ ...draft, group: e.target.value as "A" | "B" })}
              >
                <option value="A">A</option>
                <option value="B">B</option>
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1">
            Home
            <select
              className="input"
              value={draft.homeTeamId}
              onChange={(e) => setDraft({ ...draft, homeTeamId: e.target.value })}
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Away
            <select
              className="input"
              value={draft.awayTeamId}
              onChange={(e) => setDraft({ ...draft, awayTeamId: e.target.value })}
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Start
            <input
              className="input"
              type="date"
              value={draft.startDate}
              onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            End
            <input
              className="input"
              type="date"
              value={draft.endDate}
              onChange={(e) => setDraft({ ...draft, endDate: e.target.value })}
            />
          </label>
        </div>
        <button
          type="button"
          className="mt-4 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[var(--color-text)]"
          onClick={() =>
            createMatch({
              stage: draft.stage,
              group: draft.stage === "group" ? draft.group : undefined,
              homeTeamId: draft.homeTeamId || null,
              awayTeamId: draft.awayTeamId || null,
              startDate: draft.startDate,
              endDate: draft.endDate,
            })
          }
        >
          Create match
        </button>
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[800px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
              <th className="px-4 py-2">ID</th>
              <th className="px-2 py-2">Stage</th>
              <th className="px-2 py-2">Home</th>
              <th className="px-2 py-2">Away</th>
              <th className="px-2 py-2">Window</th>
              <th className="px-2 py-2">Played</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {matches.map((m) => (
              <tr key={m.id} className="border-t border-[var(--color-border-soft)]">
                <td className="px-4 py-2 font-mono text-xs">{m.id}</td>
                <td className="px-2 py-2">{m.stage}</td>
                <td className="px-2 py-2">
                  <select
                    className="input"
                    value={m.homeTeamId ?? ""}
                    onChange={(e) => patch(m, { homeTeamId: e.target.value || null })}
                  >
                    <option value="">TBD</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-2">
                  <select
                    className="input"
                    value={m.awayTeamId ?? ""}
                    onChange={(e) => patch(m, { awayTeamId: e.target.value || null })}
                  >
                    <option value="">TBD</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-2">
                  <div className="flex gap-1">
                    <input
                      className="input"
                      type="date"
                      value={m.startDate}
                      onChange={(e) => patch(m, { startDate: e.target.value })}
                    />
                    <input
                      className="input"
                      type="date"
                      value={m.endDate}
                      onChange={(e) => patch(m, { endDate: e.target.value })}
                    />
                  </div>
                </td>
                <td className="px-2 py-2">
                  <input
                    type="checkbox"
                    checked={m.played}
                    onChange={(e) => patch(m, { played: e.target.checked })}
                  />
                </td>
                <td className="px-4 py-2">
                  <button
                    type="button"
                    className="text-xs text-[var(--color-danger)]"
                    onClick={() => {
                      if (confirm(`Delete ${m.id}?`)) deleteMatch(m.id);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

