import { useEffect, useState } from "react";
import { fetchLocalSeason, isLocalApiConfigured } from "../data/localApi";
import { readSnapshotSeason } from "../data/leaderboardSnapshot";

function parts(msRemaining: number) {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

/**
 * Counts down to the first real competition period. The target comes from the server rather than a
 * hard-coded date so the countdown and the board's own kickoff can never drift apart, and so the
 * clock is not at the mercy of whatever timezone the viewer's machine is set to.
 */
export default function SeasonCountdown() {
  const [startsAt, setStartsAt] = useState<number | null>(null);
  const [started, setStarted] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const staticBoard = import.meta.env.VITE_STATIC_LEADERBOARD === "true";
    if (!staticBoard && !isLocalApiConfigured()) return;
    const load = staticBoard ? readSnapshotSeason() : fetchLocalSeason();
    void load
      .then((s) => {
        setStartsAt(new Date(s.startsAtUtc).getTime());
        setStarted(s.started);
      })
      .catch(() => setStartsAt(null));
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (startsAt == null) return null;

  const remaining = startsAt - now;
  // The server does the actual reset; this just stops counting and flips the label.
  if (started || remaining <= 0) {
    return (
      <div className="flex flex-col justify-center rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-4 py-2">
        <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)]">
          Competition
        </p>
        <p className="text-sm font-bold text-[var(--color-accent)]">Underway</p>
      </div>
    );
  }

  const { days, hours, minutes, seconds } = parts(remaining);
  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <div className="flex flex-col justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-4 py-2 backdrop-blur-sm">
      <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-faint)]">
        Competition starts
      </p>
      <p className="font-mono text-sm font-bold tabular-nums text-[var(--color-text)]">
        {days}d {pad(hours)}:{pad(minutes)}:{pad(seconds)}
      </p>
    </div>
  );
}
