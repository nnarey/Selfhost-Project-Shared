import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Card from "../components/Card";
import SeasonCountdown from "../components/SeasonCountdown";
import StatTile from "../components/StatTile";
import { isHarborPermanentOnly } from "../config/harbor";
import { useTournament } from "../context/TournamentContext";
import {
  fetchLocalDevices,
  fetchLocalRosterSummary,
  isLocalApiConfigured,
} from "../data/localApi";
import { readSnapshotDevices, readSnapshotRoster } from "../data/leaderboardSnapshot";

export default function Landing() {
  const permanentOnly = isHarborPermanentOnly();
  const { participants } = useTournament();
  const [deviceSummary, setDeviceSummary] = useState<{ available: number; checkedOut: number } | null>(
    null,
  );
  const [roster, setRoster] = useState<{ enrolled: number; active: number } | null>(null);

  useEffect(() => {
    const staticBoard = import.meta.env.VITE_STATIC_LEADERBOARD === "true";
    if (!staticBoard && !isLocalApiConfigured()) return;
    const load = staticBoard ? readSnapshotRoster() : fetchLocalRosterSummary();
    void load
      .then((res) => setRoster({ enrolled: res.enrolled, active: res.active }))
      .catch(() => setRoster(null));
  }, []);

  useEffect(() => {
    const staticBoard = import.meta.env.VITE_STATIC_LEADERBOARD === "true";
    if (permanentOnly || (!staticBoard && !isLocalApiConfigured())) return;
    const load = staticBoard ? readSnapshotDevices() : fetchLocalDevices();
    void load
      .then((res) =>
        setDeviceSummary({
          available: res.summary.available,
          checkedOut: res.summary.checkedOut,
        }),
      )
      .catch(() => setDeviceSummary(null));
  }, [permanentOnly]);

  // Roster counts come from the API, not the local mock seed — that seed invents its own
  // "Participant N" people, which is why this tile used to disagree with the real roster.
  const enrolledCount = roster?.enrolled ?? participants.length;
  const activeCount = roster?.active ?? participants.filter((p) => p.status === "Active").length;
  const checkedOut = deviceSummary?.checkedOut ?? 0;
  const availableDevices = deviceSummary?.available ?? 0;

  return (
    <div className="flex flex-col gap-14">
      <section className="stadium-hero neon-border neon-border--hero px-6 py-10 sm:px-10 sm:py-14">
        <p className="tournament-eyebrow mb-3 text-center sm:text-left">FieldCam Self-Host</p>
        <h1 className="font-display text-center text-5xl leading-none text-[var(--color-text)] sm:text-left sm:text-6xl md:text-7xl">
          Self-Host <span className="text-[var(--color-accent)]">Leaderboard</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-center text-sm text-[var(--color-text-muted)] sm:mx-0 sm:text-left sm:text-base">
          {permanentOnly
            ? "Use your assigned FieldCam through real workdays, post findings in #fieldcam-selfhost, and climb the standings."
            : "Use an FieldCam through real workdays, post findings in #fieldcam-selfhost, and climb the weekly individual standings."}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3 sm:justify-start">
          <Link
            to="/sign-up"
            className="rounded-lg bg-[var(--color-accent)] px-5 py-2.5 text-sm font-bold text-[#e8edf4] transition-transform hover:scale-[1.02]"
          >
            Sign up for self-host
          </Link>
          <Link
            to="/leaderboard"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-5 py-2.5 text-sm font-semibold text-[var(--color-text)] backdrop-blur-sm transition-colors hover:border-[var(--color-accent)]"
          >
            View leaderboard
          </Link>
          {!permanentOnly && (
          <Link
            to="/devices"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-5 py-2.5 text-sm font-semibold text-[var(--color-text)] backdrop-blur-sm transition-colors hover:border-[var(--color-accent)]"
          >
            Devices
          </Link>
          )}
          <SeasonCountdown />
        </div>
      </section>

      <section className={`grid gap-3 sm:grid-cols-2 ${permanentOnly ? "" : "lg:grid-cols-4"}`}>
        <StatTile label="Enrolled" value={enrolledCount} hint="Registered roster" />
        <StatTile label="Active" value={activeCount} accent hint="Recorded in last 24h" />
        {!permanentOnly && (
          <>
            <StatTile label="Checked out" value={checkedOut} hint="Cameras in use" />
            <StatTile label="Available" value={availableDevices} hint="No open assignment" />
          </>
        )}
      </section>

      <section className={`grid gap-4 ${permanentOnly ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
        {!permanentOnly && (
        <Card className="p-5">
          <p className="tournament-eyebrow">Devices</p>
          <h3 className="mt-2 text-sm font-semibold text-[var(--color-text)]">See what’s out</h3>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Open Devices to see which cameras are available or assigned from the Fleet import.
          </p>
          <Link to="/devices" className="mt-3 inline-block text-sm font-medium text-[var(--color-accent)] hover:underline">
            Devices →
          </Link>
        </Card>
        )}
        <Card className="p-5">
          <p className="tournament-eyebrow">Biweekly scores</p>
          <h3 className="mt-2 text-sm font-semibold text-[var(--color-text)]">Climb the board</h3>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Recordings, hours, uploads, livestreams, and approved reports earn points.
            {permanentOnly
              ? " Permanent cameras reset every two Mondays (Phoenix time)."
              : " Checkout and permanent cameras reset every two Mondays (Phoenix time)."}
          </p>
          <Link
            to="/leaderboard"
            className="mt-3 inline-block text-sm font-medium text-[var(--color-accent)] hover:underline"
          >
            Leaderboard →
          </Link>
        </Card>
        <Card className="p-5">
          <p className="tournament-eyebrow">#fieldcam-selfhost</p>
          <h3 className="mt-2 text-sm font-semibold text-[var(--color-text)]">Report what you find</h3>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Post findings in Slack. Approved reports count toward your weekly score.
          </p>
          <Link
            to="/my-profile"
            className="mt-3 inline-block text-sm font-medium text-[var(--color-accent)] hover:underline"
          >
            My Profile →
          </Link>
        </Card>
      </section>
    </div>
  );
}
