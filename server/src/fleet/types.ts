export interface FleetDeviceOwner {
  id: string;
  email?: string | null;
  assignedAtUtc?: string | null;
}

export interface FleetDevice {
  /** Serial / camera id matching Splunk Camera ID */
  cameraId: string;
  model?: string | null;
  label?: string | null;
  /** JSON:API relationships.agency.data.id when present */
  agencyId?: string | null;
  owner: FleetDeviceOwner | null;
  raw?: unknown;
}

export interface EvidenceAgencyInfo {
  id: string;
  name: string | null;
  domain: string | null;
}

export interface EvidenceSyncResult {
  mode: "live" | "mock" | "disabled";
  polledAt: string;
  devicesSeen: number;
  fieldcamDevices: number;
  opened: number;
  closed: number;
  unchanged: number;
  unresolvedOwners: number;
  prunedCameras: number;
  /** Model string -> count for agency devices the model filter rejected (docks, older cameras). */
  skippedModels?: Record<string, number>;
  errors: string[];
  agencyName?: string | null;
  agencyDomain?: string | null;
}
