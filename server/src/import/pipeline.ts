import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { getDb, nowISO, audit } from "../db.js";
import { ensureParticipant } from "../participants.js";
import {
  IMPORT_LOOKBACK_HOURS,
  periodWeekStartUtcISO,
  isInImportLookback,
  weekStartForEvent,
} from "../week.js";
import {
  diffScoreRows,
  getImportFreshness,
  readWeekScoreRows,
  recomputeWeekScores,
  type ScoreRowSnapshot,
} from "../scoring/engine.js";
import { recomputeReminderEligibility } from "../reminders.js";
import { parseCsv, detectHeaders } from "./csv.js";
import {
  applyMapping,
  DEFAULT_FLEET_MAPPING,
  DEFAULT_SPLUNK_MAPPING,
  inferMapping,
} from "./mapping.js";
import type { ColumnMapping } from "../types.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface BatchRow {
  batch_id: string;
  status: string;
  export_time_utc: string | null;
  export_timezone: string | null;
  /** Hours of history the export covers. NULL on batches created before this existed. */
  export_window_hours: number | null;
  uploader: string | null;
  preview_json: string | null;
}

function getBatch(batchId: string): BatchRow {
  const row = getDb()
    .prepare(`SELECT * FROM import_batches WHERE batch_id = ?`)
    .get(batchId) as BatchRow | undefined;
  if (!row) throw new Error("Import batch not found");
  return row;
}

export function beginImport(
  actor: string,
  opts: {
    exportTimeUtc: string;
    exportTimezone: string;
    /**
     * Hours of history this export covers. Omit for the routine 24h pull. A backfill must declare
     * its span, or the import lookback rejects everything older than 36h — see validateAndPartition.
     */
    exportWindowHours?: number;
  },
) {
  if (!opts.exportTimeUtc) throw new Error("exportTimeUtc is required");
  const batchId = uuid();
  const now = nowISO();
  getDb()
    .prepare(
      `INSERT INTO import_batches (
        batch_id, status, export_time_utc, export_timezone, uploader, created_at, export_window_hours
      ) VALUES (?, 'begun', ?, ?, ?, ?, ?)`,
    )
    .run(
      batchId,
      opts.exportTimeUtc,
      opts.exportTimezone || "UTC",
      actor,
      now,
      Number.isFinite(opts.exportWindowHours) && (opts.exportWindowHours ?? 0) > 0
        ? Number(opts.exportWindowHours)
        : null,
    );

  audit(actor, "import.begin", { entityType: "import_batch", entityId: batchId });
  return { batchId, status: "begun" };
}

export function uploadImportFiles(
  actor: string,
  batchId: string,
  files: {
    splunkCsv: string;
    fleetCsv?: string;
    splunkMapping?: ColumnMapping[];
    fleetMapping?: ColumnMapping[];
  },
) {
  const batch = getBatch(batchId);
  if (!files.splunkCsv?.trim()) {
    throw new Error("Splunk CSV is required");
  }
  const fleetCsv = files.fleetCsv?.trim() || "";
  // Fleet CSV is optional when Fleet API (or prior imports) already maintain assignment_history.

  const db = getDb();
  db.prepare(`DELETE FROM import_staging WHERE batch_id = ?`).run(batchId);
  db.prepare(`DELETE FROM import_errors WHERE batch_id = ?`).run(batchId);

  const splunkHeaders = detectHeaders(files.splunkCsv);
  const fleetHeaders = fleetCsv ? detectHeaders(fleetCsv) : [];
  const headerSet = (headers: string[]) => new Set(headers.map((h) => h.trim().toLowerCase()));
  const splunkSet = headerSet(splunkHeaders);
  const fleetSet = headerSet(fleetHeaders);
  if (splunkSet.has("assignment_id") && splunkSet.has("assigned_at_utc")) {
    throw new Error(
      "The first file is the assignments CSV. Put the Splunk activity export in “Splunk activity CSV” and fieldcam-assignments-*.csv in the second slot.",
    );
  }
  if (fleetSet.has("event time") || fleetSet.has("stable event id") || fleetSet.has("event_time_utc")) {
    throw new Error(
      "The second file looks like Splunk activity. Put fieldcam-assignments-*.csv in “Assignments CSV”, not the Splunk export.",
    );
  }
  const splunkMapping =
    files.splunkMapping?.length
      ? files.splunkMapping
      : inferMapping(splunkHeaders, "splunk").length
        ? inferMapping(splunkHeaders, "splunk")
        : DEFAULT_SPLUNK_MAPPING;
  const fleetMapping = fleetCsv
    ? files.fleetMapping?.length
      ? files.fleetMapping
      : inferMapping(fleetHeaders, "fleet").length
        ? inferMapping(fleetHeaders, "fleet")
        : DEFAULT_FLEET_MAPPING
    : [];

  const splunkRows = parseCsv(files.splunkCsv);
  const fleetRows = fleetCsv ? parseCsv(fleetCsv) : [];

  const stage = db.prepare(
    `INSERT INTO import_staging (batch_id, source_kind, row_index, payload_json) VALUES (?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    splunkRows.forEach((row, i) => {
      stage.run(batchId, "splunk", i + 1, JSON.stringify(applyMapping(row, splunkMapping)));
    });
    fleetRows.forEach((row, i) => {
      stage.run(batchId, "fleet", i + 1, JSON.stringify(applyMapping(row, fleetMapping)));
    });
    db.prepare(
      `UPDATE import_batches SET
        status = 'uploaded',
        splunk_hash = ?,
        fleet_hash = ?,
        mapping_splunk_id = ?,
        mapping_fleet_id = ?
       WHERE batch_id = ?`,
    ).run(
      sha256(files.splunkCsv),
      fleetCsv ? sha256(fleetCsv) : null,
      JSON.stringify(splunkMapping),
      fleetMapping.length ? JSON.stringify(fleetMapping) : null,
      batchId,
    );
  });
  tx();

  audit(actor, "import.upload", {
    entityType: "import_batch",
    entityId: batchId,
    newValue: {
      splunkRows: splunkRows.length,
      fleetRows: fleetRows.length,
      fleetOptional: !fleetCsv,
      splunkHeaders,
      fleetHeaders,
    },
  });

  return {
    batchId,
    status: "uploaded",
    splunkRows: splunkRows.length,
    fleetRows: fleetRows.length,
    fleetOptional: !fleetCsv,
    splunkHeaders,
    fleetHeaders,
    splunkMapping,
    fleetMapping,
    exportTimeUtc: batch.export_time_utc,
  };
}

interface ScoreDelta {
  email: string;
  name: string;
  beforePoints: number;
  afterPoints: number;
  deltaPoints: number;
  beforeRank: number | null;
  afterRank: number | null;
}

interface PreviewResult {
  batchId: string;
  acceptedActivity: number;
  rejectedActivity: number;
  quarantinedActivity: number;
  acceptedAssignments: number;
  rejectedAssignments: number;
  acceptedInventory: number;
  /** Open assignments this snapshot no longer corroborates, so they get closed on commit. */
  closedStaleAssignments: number;
  exportTimeUtc: string | null;
  freshness: ReturnType<typeof getImportFreshness>;
  quarantineSample: Array<{
    eventId: string;
    cameraId: string;
    eventTimeUtc: string;
    eventType: string;
    reason: string;
  }>;
  errors: Array<{
    sourceKind: string;
    rowNumber: number;
    stableId?: string;
    severity: string;
    message: string;
  }>;
  scoreDeltaPreview: {
    participantsAffected: number;
    weekStart: string;
    deltas: ScoreDelta[];
  };
}

function validateAndPartition(batchId: string): {
  preview: PreviewResult;
  activityAccepted: Record<string, string>[];
  activityQuarantine: Record<string, string>[];
  assignmentsAccepted: Record<string, string>[];
  inventoryCameraIds: string[];
} {
  const db = getDb();
  const weekStart = periodWeekStartUtcISO(new Date());
  /*
   * The lookback window is measured from when the export was *taken*, not from now.
   *
   * The daily GitHub Action overwrites data/splunk-activity.csv with a fresh 24h slice, and the
   * server imports it at boot. Miss a boot and that day only survives in git history — and
   * replaying it used to be impossible, because every row was judged against wall-clock now and
   * rejected as "outside last 36h". Anchoring to export_time_utc makes a snapshot mean the same
   * thing whenever it is replayed. Routine imports are unaffected: their export time is minutes
   * old, so the window lands where it always did.
   */
  const batchRow = getBatch(batchId);
  const batchExportTime = batchRow.export_time_utc;
  const lookbackAsOf =
    batchExportTime && !Number.isNaN(Date.parse(batchExportTime))
      ? new Date(batchExportTime)
      : new Date();
  /*
   * How far back this batch is allowed to reach.
   *
   * The routine daily pull covers 24h and the 36h default gives it headroom. A backfill covering
   * 14 days would otherwise have every row older than 36h rejected, which made backfilling
   * impossible even with the data in hand. An export that declares its own span gets a window
   * matching it, plus the same headroom; anything that does not declare one keeps the old default.
   */
  const declaredWindow = Number(batchRow.export_window_hours);
  const hasDeclaredWindow = Number.isFinite(declaredWindow) && declaredWindow > 0;
  let lookbackHours = hasDeclaredWindow
    ? Math.max(IMPORT_LOOKBACK_HOURS, declaredWindow + 12)
    : IMPORT_LOOKBACK_HOURS;
  const roster = new Set(
    (
      db.prepare(`SELECT email FROM participants`).all() as Array<{
        email: string;
      }>
    ).map((r) => r.email.toLowerCase()),
  );

  const staged = db
    .prepare(`SELECT source_kind, row_index, payload_json FROM import_staging WHERE batch_id = ?`)
    .all(batchId) as Array<{ source_kind: string; row_index: number; payload_json: string }>;

  // A hand upload does not declare a span. Cover every event in the file so a backfill
  // reaches the overall board instead of being cut to the daily 36h window.
  if (!hasDeclaredWindow) {
    let oldest = Infinity;
    for (const row of staged) {
      if (row.source_kind !== "splunk") continue;
      const data = JSON.parse(row.payload_json) as { event_time_utc?: string };
      const t = Date.parse(data.event_time_utc || "");
      if (!Number.isNaN(t)) oldest = Math.min(oldest, t);
    }
    if (oldest < lookbackAsOf.getTime()) {
      const spanHours = (lookbackAsOf.getTime() - oldest) / (60 * 60 * 1000);
      lookbackHours = Math.max(lookbackHours, Math.ceil(spanHours) + 12);
    }
  }

  const errors: PreviewResult["errors"] = [];
  const pushErr = (
    sourceKind: string,
    rowNumber: number,
    severity: string,
    message: string,
    stableId?: string,
  ) => {
    errors.push({ sourceKind, rowNumber, severity, message, stableId });
  };

  const assignmentsAccepted: Record<string, string>[] = [];
  const activityAccepted: Record<string, string>[] = [];
  const activityQuarantine: Record<string, string>[] = [];
  const inventoryIds = new Set<string>();

  // First pass: Fleet inventory + assignments. camera_id alone lists an available device.
  for (const row of staged.filter((s) => s.source_kind === "fleet")) {
    const data = JSON.parse(row.payload_json) as Record<string, string>;
    const cameraId = (data.camera_id || "").trim();
    if (!cameraId) {
      pushErr("fleet", row.row_index, "error", "Missing camera_id", data.assignment_id);
      continue;
    }
    inventoryIds.add(cameraId);

    const email = (data.email || "").trim().toLowerCase();
    const assignedAt = (data.assigned_at_utc || "").trim();
    if (!email && !assignedAt) continue;

    if (!email || !assignedAt) {
      pushErr(
        "fleet",
        row.row_index,
        "error",
        "Assignment rows need email and assigned_at_utc (or leave both blank for available inventory)",
        data.assignment_id,
      );
      continue;
    }
    const id =
      (data.assignment_id || "").trim() || `fleet:${cameraId}:${email}:${assignedAt}`;
    if (Number.isNaN(Date.parse(assignedAt))) {
      pushErr("fleet", row.row_index, "error", "Invalid assigned_at_utc", id);
      continue;
    }
    if (data.unassigned_at_utc && Number.isNaN(Date.parse(data.unassigned_at_utc))) {
      pushErr("fleet", row.row_index, "error", "Invalid unassigned_at_utc", id);
      continue;
    }
    if (!roster.has(email)) {
      pushErr(
        "fleet",
        row.row_index,
        "warning",
        "Assignee has not signed up yet — will be added from Fleet",
        id,
      );
    }
    assignmentsAccepted.push({
      ...data,
      email,
      camera_id: cameraId,
      assignment_id: id,
      source: (data.source || "fleet"),
      status: data.status || (data.unassigned_at_utc ? "closed" : "open"),
    });
  }

  // Intervals from this batch PLUS existing Fleet history in DB
  const dbIntervals = (
    db
      .prepare(
        `SELECT email, camera_id, assigned_at_utc, unassigned_at_utc, source
         FROM assignment_history
         WHERE source IN ('fleet')`,
      )
      .all() as Array<{
      email: string;
      camera_id: string;
      assigned_at_utc: string;
      unassigned_at_utc: string | null;
      source: string;
    }>
  ).map((a) => ({
    email: a.email.toLowerCase(),
    cameraId: a.camera_id,
    start: new Date(a.assigned_at_utc).getTime(),
    end: a.unassigned_at_utc ? new Date(a.unassigned_at_utc).getTime() : Infinity,
  }));

  const batchIntervals = assignmentsAccepted
    .filter((a) => a.source === "fleet")
    .map((a) => ({
      email: a.email,
      cameraId: a.camera_id,
      start: new Date(a.assigned_at_utc).getTime(),
      end: a.unassigned_at_utc ? new Date(a.unassigned_at_utc).getTime() : Infinity,
    }));

  // Batch rows override overlapping DB rows for the same camera+start when present
  const intervals = [...dbIntervals, ...batchIntervals];

  const seenEvents = new Set<string>();
  for (const row of staged.filter((s) => s.source_kind === "splunk")) {
    const data = JSON.parse(row.payload_json) as Record<string, string>;
    const id = (data.event_id || "").trim();
    const cameraId = (data.camera_id || "").trim();
    const eventTime = (data.event_time_utc || "").trim();
    const eventType = (data.event_type || "").trim().toLowerCase();
    if (!id || !cameraId || !eventTime || !eventType) {
      pushErr("splunk", row.row_index, "error", "Missing required activity fields", id);
      continue;
    }
    if (Number.isNaN(Date.parse(eventTime))) {
      pushErr("splunk", row.row_index, "error", "Invalid event_time_utc", id);
      continue;
    }
    if (
      !["recording", "upload", "livestream", "locationtime", "availability", "battery", "power", "pov_state", "mobile", "registration", "connectivity", "videoquality"].includes(
        eventType,
      )
    ) {
      pushErr("splunk", row.row_index, "error", `Unknown event_type ${eventType}`, id);
      continue;
    }
    if (seenEvents.has(id)) {
      pushErr("splunk", row.row_index, "error", "Duplicate event_id in batch", id);
      continue;
    }
    seenEvents.add(id);

    if (!isInImportLookback(eventTime, lookbackAsOf, lookbackHours)) {
      pushErr(
        "splunk",
        row.row_index,
        "warning",
        `Event outside the ${lookbackHours}h lookback ending ${lookbackAsOf.toISOString()} (export time), ignored`,
        id,
      );
      continue;
    }

    const t = new Date(eventTime).getTime();
    const onCamera = intervals
      .filter((iv) => iv.cameraId === cameraId)
      .sort((a, b) => a.start - b.start);
    // Fleet often has no real assigned_at, so the stored start is only an attribution
    // window. Activity on that camera before the first interval still belongs to that holder.
    const containing = onCamera
      .filter((iv) => t >= iv.start && t < iv.end)
      .sort((a, b) => b.start - a.start)[0];
    const holder = containing || (onCamera[0] && t < onCamera[0].start ? onCamera[0] : undefined);
    const eventWeekStart = weekStartForEvent(eventTime);
    const normalized = {
      ...data,
      event_id: id,
      camera_id: cameraId,
      event_time_utc: eventTime,
      event_type: eventType,
      email: holder?.email || "",
      week_start: eventWeekStart,
    };
    if (!holder) {
      activityQuarantine.push(normalized);
      pushErr("splunk", row.row_index, "warning", "No assignment interval — quarantined", id);
    } else {
      activityAccepted.push(normalized);
    }
  }

  const batch = getBatch(batchId);
  const preview: PreviewResult = {
    batchId,
    acceptedActivity: activityAccepted.length,
    rejectedActivity: errors.filter((e) => e.sourceKind === "splunk" && e.severity === "error")
      .length,
    quarantinedActivity: activityQuarantine.length,
    acceptedAssignments: assignmentsAccepted.length,
    rejectedAssignments: errors.filter((e) => e.sourceKind === "fleet" && e.severity === "error")
      .length,
    acceptedInventory: inventoryIds.size,
    closedStaleAssignments: 0,
    exportTimeUtc: batch.export_time_utc,
    freshness: getImportFreshness(),
    quarantineSample: activityQuarantine.slice(0, 25).map((e) => ({
      eventId: e.event_id,
      cameraId: e.camera_id,
      eventTimeUtc: e.event_time_utc,
      eventType: e.event_type,
      reason: "No valid assignment interval",
    })),
    errors,
    scoreDeltaPreview: {
      participantsAffected: new Set(activityAccepted.map((a) => a.email).filter(Boolean)).size,
      weekStart,
      deltas: [],
    },
  };

  return {
    preview,
    activityAccepted,
    activityQuarantine,
    assignmentsAccepted,
    inventoryCameraIds: [...inventoryIds],
  };
}

function applyAcceptedRows(
  batchId: string,
  weekStart: string,
  activityAccepted: Record<string, string>[],
  activityQuarantine: Record<string, string>[],
  assignmentsAccepted: Record<string, string>[],
  inventoryCameraIds: string[],
  markCommitted: boolean,
  preview: PreviewResult,
): void {
  const db = getDb();
  const now = nowISO();

  const upsertAssign = db.prepare(
    `INSERT INTO assignment_history (
      assignment_id, camera_id, email, assigned_at_utc, unassigned_at_utc,
      source, status, import_batch_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(assignment_id) DO UPDATE SET
      camera_id = excluded.camera_id,
      email = excluded.email,
      assigned_at_utc = excluded.assigned_at_utc,
      unassigned_at_utc = excluded.unassigned_at_utc,
      source = excluded.source,
      status = excluded.status,
      import_batch_id = excluded.import_batch_id`,
  );

  const upsertEvent = db.prepare(
    `INSERT INTO activity_events (
      event_id, event_time_utc, camera_id, event_type, duration_seconds,
      purpose, status, recording_source, upload_transport, avg_power_mw, recording_resolution,
      email, week_start, import_batch_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      event_time_utc = excluded.event_time_utc,
      camera_id = excluded.camera_id,
      event_type = excluded.event_type,
      duration_seconds = excluded.duration_seconds,
      purpose = excluded.purpose,
      status = excluded.status,
      recording_source = excluded.recording_source,
      upload_transport = excluded.upload_transport,
      avg_power_mw = excluded.avg_power_mw,
      recording_resolution = excluded.recording_resolution,
      email = excluded.email,
      week_start = excluded.week_start,
      import_batch_id = excluded.import_batch_id`,
  );

  const upsertQuarantine = db.prepare(
    `INSERT INTO quarantined_activity (
      event_id, event_time_utc, camera_id, event_type, duration_seconds,
      purpose, status, batch_id, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      reason = excluded.reason,
      batch_id = excluded.batch_id`,
  );

  const upsertCamera = db.prepare(
    `INSERT INTO cameras (camera_id, label, created_at) VALUES (?, ?, ?)
     ON CONFLICT(camera_id) DO NOTHING`,
  );

  if (inventoryCameraIds.length) {
    const ids = [...new Set(inventoryCameraIds.map((id) => id.trim()).filter(Boolean))];
    for (const id of ids) upsertCamera.run(id, id, now);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM cameras WHERE camera_id NOT IN (${placeholders})`).run(...ids);
  }

  const sorted = [...assignmentsAccepted].sort(
    (a, b) => Date.parse(a.assigned_at_utc) - Date.parse(b.assigned_at_utc),
  );
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    upsertCamera.run(a.camera_id, a.camera_id, now);
    if (!a.unassigned_at_utc) {
      const next = sorted.find(
        (b, j) =>
          j > i &&
          b.camera_id === a.camera_id &&
          Date.parse(b.assigned_at_utc) > Date.parse(a.assigned_at_utc),
      );
      if (next) a.unassigned_at_utc = next.assigned_at_utc;
    }
    upsertAssign.run(
      a.assignment_id,
      a.camera_id,
      a.email,
      a.assigned_at_utc,
      a.unassigned_at_utc || null,
      a.source,
      a.unassigned_at_utc ? "closed" : "open",
      batchId,
      now,
    );
    ensureParticipant(a.email, {
      cameraId: a.unassigned_at_utc ? null : a.camera_id,
      viaAssignment: true,
    });
    if (!a.unassigned_at_utc) {
      db.prepare(`UPDATE participants SET camera_id = ?, updated_at = ? WHERE email = ?`).run(
        a.camera_id,
        now,
        a.email,
      );
    }
  }

  // The Fleet CSV is a full current-inventory snapshot (available stock included), so it is
  // authoritative for who holds a camera *right now*. Without this reconcile, an assignment row
  // created with a blank unassigned_at_utc stays status='open' forever — nothing in the import
  // closes it, and on Harbor the Fleet sync that would normally close it is disabled. That is what
  // makes a camera keep showing as "checked out" to someone the latest CSV no longer assigns it to.
  //
  // Closing sets an end date rather than deleting the row, so historical attribution survives:
  // activity_events already carry the resolved email/camera, so points earned during the window
  // stay exactly as they were. Only "who currently holds this" changes.
  if (inventoryCameraIds.length) {
    const inventory = [...new Set(inventoryCameraIds.map((id) => id.trim()).filter(Boolean))];
    const invPlaceholders = inventory.map(() => "?").join(",");

    // Built from `sorted` (post-chaining) so a row auto-closed by a later assignment above is
    // not mistaken for a still-open holder.
    const openByCamera = new Map<string, Set<string>>();
    for (const a of sorted) {
      if (a.unassigned_at_utc) continue;
      const holders = openByCamera.get(a.camera_id) ?? new Set<string>();
      holders.add(a.email.toLowerCase());
      openByCamera.set(a.camera_id, holders);
    }

    const openRows = db
      .prepare(
        `SELECT assignment_id, camera_id, email, assigned_at_utc
         FROM assignment_history
         WHERE status = 'open' AND unassigned_at_utc IS NULL
           AND source IN ('fleet')
           AND camera_id IN (${invPlaceholders})`,
      )
      .all(...inventory) as Array<{
      assignment_id: string;
      camera_id: string;
      email: string;
      assigned_at_utc: string;
    }>;

    const closeAssign = db.prepare(
      `UPDATE assignment_history SET unassigned_at_utc = ?, status = 'closed'
       WHERE assignment_id = ?`,
    );
    const clearParticipantCamera = db.prepare(
      `UPDATE participants SET camera_id = NULL, updated_at = ?
       WHERE lower(email) = lower(?) AND camera_id = ?`,
    );

    const dbOpenByCamera = new Map<string, typeof openRows>();
    for (const row of openRows) {
      const list = dbOpenByCamera.get(row.camera_id) ?? [];
      list.push(row);
      dbOpenByCamera.set(row.camera_id, list);
    }

    // Close as of the export snapshot — that is the moment we have evidence they no longer hold it.
    const exportTime = getBatch(batchId).export_time_utc || now;
    let closed = 0;

    for (const [cameraId, rows] of dbOpenByCamera) {
      const csvHolders = openByCamera.get(cameraId);

      // A camera can only be held by one person at a time, so keep at most one open row: the most
      // recent whose holder this snapshot still corroborates. Everything else is stale (wrong
      // holder) or a duplicate — exports that change assignment_id between runs insert a second
      // open row for the same camera+holder instead of updating the first, which double-counts the
      // device and makes "who has it" ambiguous.
      const keep = csvHolders?.size
        ? rows
            .filter((r) => csvHolders.has(r.email.toLowerCase()))
            .sort(
              (a, b) =>
                Date.parse(b.assigned_at_utc) - Date.parse(a.assigned_at_utc) ||
                a.assignment_id.localeCompare(b.assignment_id),
            )[0]
        : undefined;

      for (const row of rows) {
        if (keep && row.assignment_id === keep.assignment_id) continue;
        // Guard against re-importing an older export, which would otherwise end the interval
        // before it began.
        const endAt =
          Date.parse(exportTime) > Date.parse(row.assigned_at_utc)
            ? exportTime
            : row.assigned_at_utc;
        closeAssign.run(endAt, row.assignment_id);
        if (!keep) clearParticipantCamera.run(now, row.email, row.camera_id);
        closed += 1;
      }
    }

    // A camera missing from the snapshot has left inventory — retired, or never a camera in the
    // first place (the Fleet device list also returns docks, and names whoever registered one
    // as its owner). The camera row is already deleted above, which drops it from the device list,
    // but its open interval would outlive it and keep the hardware pinned to that holder in
    // scoring and on their profile.
    const droppedOpen = db
      .prepare(
        `SELECT assignment_id, camera_id, email, assigned_at_utc
         FROM assignment_history
         WHERE status = 'open' AND unassigned_at_utc IS NULL
           AND source IN ('fleet')
           AND camera_id NOT IN (${invPlaceholders})`,
      )
      .all(...inventory) as typeof openRows;

    for (const row of droppedOpen) {
      const endAt =
        Date.parse(exportTime) > Date.parse(row.assigned_at_utc) ? exportTime : row.assigned_at_utc;
      closeAssign.run(endAt, row.assignment_id);
      clearParticipantCamera.run(now, row.email, row.camera_id);
      closed += 1;
    }

    preview.closedStaleAssignments = closed;
  }

  for (const e of activityAccepted) {
    if (e.email) ensureParticipant(e.email, { cameraId: e.camera_id || null });
    const eventWeek = e.week_start || weekStartForEvent(e.event_time_utc) || weekStart;
    upsertEvent.run(
      e.event_id,
      e.event_time_utc,
      e.camera_id,
      e.event_type,
      e.duration_seconds != null ? Number(e.duration_seconds) : null,
      e.purpose || null,
      e.status || null,
      e.recording_source || null,
      e.upload_transport || null,
      // Only `power` rows carry this; a blank or unparseable value stays NULL rather than 0,
      // so it is excluded from the median instead of dragging it down.
      Number.isFinite(Number(e.avg_power_mw)) && String(e.avg_power_mw).trim() !== ""
        ? Number(e.avg_power_mw)
        : null,
      e.recording_resolution || null,
      e.email,
      eventWeek,
      batchId,
      now,
    );
  }

  for (const e of activityQuarantine) {
    upsertQuarantine.run(
      e.event_id,
      e.event_time_utc,
      e.camera_id,
      e.event_type,
      e.duration_seconds != null ? Number(e.duration_seconds) : null,
      e.purpose || null,
      e.status || null,
      batchId,
      "No valid assignment interval",
      now,
    );
  }

  if (markCommitted) {
    db.prepare(
      `UPDATE import_batches SET
        status = 'committed',
        accepted_count = ?,
        rejected_count = ?,
        quarantined_count = ?,
        preview_json = ?,
        committed_at = ?
       WHERE batch_id = ?`,
    ).run(
      preview.acceptedActivity + preview.acceptedAssignments,
      preview.rejectedActivity + preview.rejectedAssignments,
      preview.quarantinedActivity,
      JSON.stringify(preview),
      now,
      batchId,
    );
  }
}

function dryRunScoreDeltas(
  batchId: string,
  weekStart: string,
  activityAccepted: Record<string, string>[],
  activityQuarantine: Record<string, string>[],
  assignmentsAccepted: Record<string, string>[],
  inventoryCameraIds: string[],
  preview: PreviewResult,
): ScoreDelta[] {
  const before = readWeekScoreRows(weekStart);
  const db = getDb();
  const ROLLBACK = "FIELDCAM_IMPORT_PREVIEW_ROLLBACK";
  let after: ScoreRowSnapshot[] = [];
  try {
    db.transaction(() => {
      applyAcceptedRows(
        batchId,
        weekStart,
        activityAccepted,
        activityQuarantine,
        assignmentsAccepted,
        inventoryCameraIds,
        false,
        preview,
      );
      const recomputed = recomputeWeekScores(weekStart);
      after = recomputed.entries;
      throw new Error(ROLLBACK);
    })();
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) throw err;
  }
  return diffScoreRows(before, after);
}

export function previewImport(actor: string, batchId: string) {
  getBatch(batchId);
  const { preview, activityAccepted, activityQuarantine, assignmentsAccepted, inventoryCameraIds } =
    validateAndPartition(batchId);
  const weekStart = preview.scoreDeltaPreview.weekStart;
  preview.scoreDeltaPreview.deltas = dryRunScoreDeltas(
    batchId,
    weekStart,
    activityAccepted,
    activityQuarantine,
    assignmentsAccepted,
    inventoryCameraIds,
    preview,
  );
  preview.scoreDeltaPreview.participantsAffected = preview.scoreDeltaPreview.deltas.length;

  const db = getDb();
  db.prepare(`DELETE FROM import_errors WHERE batch_id = ?`).run(batchId);
  const insertErr = db.prepare(
    `INSERT INTO import_errors (batch_id, source_kind, row_number, stable_id, severity, message)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const e of preview.errors) {
      insertErr.run(
        batchId,
        e.sourceKind,
        e.rowNumber,
        e.stableId ?? null,
        e.severity,
        e.message,
      );
    }
    db.prepare(
      `UPDATE import_batches SET
        status = 'previewed',
        accepted_count = ?,
        rejected_count = ?,
        quarantined_count = ?,
        preview_json = ?
       WHERE batch_id = ?`,
    ).run(
      preview.acceptedActivity + preview.acceptedAssignments,
      preview.rejectedActivity + preview.rejectedAssignments,
      preview.quarantinedActivity,
      JSON.stringify(preview),
      batchId,
    );
  });
  tx();

  audit(actor, "import.preview", { entityType: "import_batch", entityId: batchId });
  return preview;
}

export function commitImport(actor: string, batchId: string) {
  getBatch(batchId);
  const { preview, activityAccepted, activityQuarantine, assignmentsAccepted, inventoryCameraIds } =
    validateAndPartition(batchId);
  const weekStart = preview.scoreDeltaPreview.weekStart;
  const db = getDb();

  const tx = db.transaction(() => {
    applyAcceptedRows(
      batchId,
      weekStart,
      activityAccepted,
      activityQuarantine,
      assignmentsAccepted,
      inventoryCameraIds,
      true,
      preview,
    );
  });
  tx();

  const weekStarts = [
    ...new Set(
      activityAccepted.map((e) => e.week_start || weekStartForEvent(e.event_time_utc) || weekStart),
    ),
  ];
  if (!weekStarts.length) weekStarts.push(weekStart);
  const scoresByWeek = weekStarts.map((ws) => recomputeWeekScores(ws));
  const scores = scoresByWeek.find((s) => s.weekStart === weekStart) || scoresByWeek[0];
  const eligibility = recomputeReminderEligibility();

  audit(actor, "import.commit", {
    entityType: "import_batch",
    entityId: batchId,
    newValue: {
      preview,
      scores,
      scoresByWeek: scoresByWeek.map((s) => ({ weekStart: s.weekStart, count: s.count })),
      eligibilityCount: eligibility.length,
    },
  });

  return {
    batchId,
    status: "committed",
    preview,
    weeksRecomputed: weekStarts,
    scores,
    eligibilityCount: eligibility.length,
  };
}

export function listQuarantinedActivity(limit = 100) {
  return getDb()
    .prepare(
      `SELECT event_id as eventId, event_time_utc as eventTimeUtc, camera_id as cameraId,
              event_type as eventType, duration_seconds as durationSeconds, purpose, status,
              batch_id as batchId, reason, created_at as createdAt
       FROM quarantined_activity
       ORDER BY event_time_utc DESC
       LIMIT ?`,
    )
    .all(limit);
}
