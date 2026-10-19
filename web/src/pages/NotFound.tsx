import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <p className="text-5xl">🟥</p>
      <h1 className="text-xl font-bold text-[var(--color-text)]">Page not found</h1>
      <p className="text-sm text-[var(--color-text-muted)]">That page doesn't exist — maybe a red card?</p>
      <Link to="/" className="mt-2 text-sm font-medium text-[var(--color-accent)] hover:underline">
        Back to home
      </Link>
    </div>
  );
}
