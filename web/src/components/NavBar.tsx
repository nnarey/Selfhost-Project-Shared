import { NavLink } from "react-router-dom";
import { isHarborHostedUi, isHarborPermanentOnly } from "../config/harbor";
import { useAuth } from "../context/AuthContext";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
    isActive
      ? "bg-[var(--color-surface-2)] text-[var(--color-accent)]"
      : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
  }`;

export default function NavBar() {
  const { session } = useAuth();
  const harborHosted = isHarborHostedUi();
  const staticBoard = import.meta.env.VITE_STATIC_LEADERBOARD === "true";

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-elevated)]/95 backdrop-blur">
      {!harborHosted && !staticBoard && (
      <div className="bg-[var(--color-accent)]/20 px-6 py-1 text-center text-[11px] text-[var(--color-text-muted)]">
        <span className="font-bold uppercase tracking-wider text-[var(--color-accent)]">
          Local
        </span>{" "}
        · not Harbor · start <code className="text-[var(--color-text)]">server/</code> on :8787
        for live leaderboard imports
      </div>
      )}
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
        <NavLink to="/" className="flex items-center gap-2 shrink-0">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--color-accent)] text-sm font-black text-[var(--color-text)]">
            FC
          </span>
          <span className="hidden text-sm font-semibold tracking-wide text-[var(--color-text)] sm:block">
            Self-Host
          </span>
        </NavLink>

        {staticBoard ? (
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          <NavLink to="/" end className={linkClass}>
            Home
          </NavLink>
          <NavLink to="/leaderboard" className={linkClass}>
            Leaderboard
          </NavLink>
          <NavLink to="/stats" className={linkClass}>
            Stats
          </NavLink>
          <NavLink to="/devices" className={linkClass}>
            Devices
          </NavLink>
        </nav>
        ) : (
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          <NavLink to="/" end className={linkClass}>
            Home
          </NavLink>
          <NavLink to="/leaderboard" className={linkClass}>
            Leaderboard
          </NavLink>
          <NavLink to="/stats" className={linkClass}>
            Stats
          </NavLink>
          {!isHarborPermanentOnly() && (
          <NavLink to="/devices" className={linkClass}>
            Devices
          </NavLink>
          )}
          <NavLink to="/my-profile" className={linkClass}>
            My Profile
          </NavLink>
          <NavLink to="/sign-up" className={linkClass}>
            Sign up
          </NavLink>
          {session?.isAdmin && (
          <NavLink to="/admin" className={linkClass}>
            Admin
          </NavLink>
          )}
        </nav>
        )}

        <div className="flex shrink-0 items-center gap-2">
          {session && (
            <span className="hidden text-xs text-[var(--color-text-muted)] sm:inline">
              {session.email}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
