export default function Footer() {
  return (
    <footer className="mt-16 border-t border-[var(--color-border-soft)] py-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-2 px-6 text-xs text-[var(--color-text-faint)] sm:flex-row sm:items-center sm:justify-between">
        <p>FieldCam Self-Host</p>
        <p>
          Questions? Post in{" "}
          <span className="text-[var(--color-text-muted)]">#fieldcam-selfhost</span>
        </p>
      </div>
    </footer>
  );
}
