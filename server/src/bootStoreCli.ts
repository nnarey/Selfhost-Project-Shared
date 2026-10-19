import { closeDb } from "./db.js";
import { initDataStore } from "./bootStore.js";

// Runs in its own process so the HTTP thread can keep answering /health.
// Harbor restarts the container when that check takes longer than 5 seconds.
try {
  initDataStore();
  closeDb();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Database init failed (health still returns 200): ${message}`);
  try {
    closeDb();
  } catch {
    // The file may already be closed after a failed open.
  }
  process.exit(1);
}
