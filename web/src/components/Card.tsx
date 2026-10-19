import type { CSSProperties, ReactNode } from "react";

export default function Card({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={style}
      className={`neon-border rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] ${className}`}
    >
      {children}
    </div>
  );
}
