import { ENV } from "../env.js";
import { syncFleetOwnership } from "./sync.js";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startEvidencePoller(): void {
  if (!ENV.fleetEnabled || ENV.fleetMode === "off") {
    console.log("Fleet ownership sync disabled (no outbound Fleet calls)");
    return;
  }
  if (timer) return;

  const seconds = Math.max(30, ENV.fleetPollSeconds);
  console.log(
    `Fleet ownership sync enabled (mode=${ENV.fleetMode}, every ${seconds}s)`,
  );

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await syncFleetOwnership("fleet-poller");
      if (result.errors.length) {
        console.warn("Fleet sync errors:", result.errors.slice(0, 3).join(" | "));
      } else {
        console.log(
          `Fleet sync: agency=${result.agencyName || "?"} ${result.agencyDomain || ""} seen=${result.devicesSeen} fieldcam=${result.fieldcamDevices} opened=${result.opened} closed=${result.closed} unchanged=${result.unchanged} pruned=${result.prunedCameras}`,
        );
      }
    } catch (err) {
      console.warn("Fleet sync failed:", err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };

  // Kick once shortly after boot, then on interval
  setTimeout(() => void tick(), 1500);
  timer = setInterval(() => void tick(), seconds * 1000);
}

export function stopEvidencePoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
