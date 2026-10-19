/** When true, Harbor hides checkout devices and the checkout leaderboard. */
export function isHarborPermanentOnly(): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(import.meta.env.VITE_HARBOR_PERMANENT_ONLY || "").toLowerCase(),
  );
}

/** Harbor production bundle (Dockerfile). Laptop Vite keeps VITE_LOCAL_API_URL set. */
export function isHarborHostedUi(): boolean {
  return Boolean(import.meta.env.PROD) && !String(import.meta.env.VITE_LOCAL_API_URL || "").trim();
}

/**
 * A load failure explained for wherever the user actually is.
 *
 * The old text told everyone to "Start the local API on :8787" regardless of environment. On Harbor
 * there is no :8787 and nothing for the reader to start, so a genuine server error read as a
 * local setup problem — it sent two separate investigations to the wrong place before anyone
 * noticed the string was hardcoded.
 */
export function apiErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return isHarborHostedUi()
    ? `Could not reach the server (${detail}).`
    : `Start the local API on :8787 (${detail}).`;
}
