export default function StatusPill({ status }: { status: "Active" | "Inactive" }) {
  if (status === "Active") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-pitch)]/15 px-2 py-0.5 text-xs font-medium text-[var(--color-pitch)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-pitch)]" /> Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-danger)]/15 px-2 py-0.5 text-xs font-medium text-[var(--color-danger)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-danger)]" /> Inactive
    </span>
  );
}
