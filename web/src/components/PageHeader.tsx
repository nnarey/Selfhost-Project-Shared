import type { ReactNode } from "react";

export default function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow && <p className="tournament-eyebrow mb-1">{eyebrow}</p>}
        <h1 className="font-display text-3xl tracking-wide text-[var(--color-text)] sm:text-4xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm text-[var(--color-text-muted)]">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
