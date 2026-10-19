import { v4 as uuid } from "uuid";
import { audit, getDb, nowISO } from "../db.js";

/**
 * Provisional QR checkout. Scoring still prefers Fleet intervals from Fleet sync.
 * Return closes QR (and open Fleet if same camera+email) so reminders/penalties can stop.
 */
export function recordQrCheckout(email: string, cameraId: string) {
  const db = getDb();
  const now = nowISO();
  const normalizedEmail = email.trim().toLowerCase();
  const cam = cameraId.trim();
  if (!normalizedEmail || !cam) throw new Error("email and cameraId required");

  const person = db
    .prepare(`SELECT signup_status FROM participants WHERE lower(email) = lower(?)`)
    .get(normalizedEmail) as { signup_status: string } | undefined;
  if (!person) {
    throw new Error("Sign up first, then check out a camera.");
  }
  if (person.signup_status === "rejected") {
    throw new Error("This registration cannot check out a camera.");
  }

  db.prepare(
    `INSERT INTO cameras (camera_id, label, created_at) VALUES (?, ?, ?)
     ON CONFLICT(camera_id) DO NOTHING`,
  ).run(cam, null, now);

  // Close any open QR row for this camera
  db.prepare(
    `UPDATE assignment_history
     SET unassigned_at_utc = ?, status = 'closed'
     WHERE camera_id = ? AND source = 'QR' AND status = 'open' AND unassigned_at_utc IS NULL`,
  ).run(now, cam);

  const id = uuid();
  db.prepare(
    `INSERT INTO assignment_history (
      assignment_id, camera_id, email, assigned_at_utc, unassigned_at_utc,
      source, status, import_batch_id, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'QR', 'open', NULL, ?)`,
  ).run(id, cam, normalizedEmail, now, now);

  db.prepare(`UPDATE participants SET camera_id = ?, updated_at = ? WHERE email = ?`).run(
    cam,
    now,
    normalizedEmail,
  );

  audit(normalizedEmail, "qr.checkout", {
    entityType: "assignment",
    entityId: id,
    newValue: { cameraId: cam, email: normalizedEmail, provisional: true },
  });

  return {
    provisional: true,
    assignmentId: id,
    cameraId: cam,
    email: normalizedEmail,
    assignedAtUtc: now,
    message:
      "Provisional QR checkout recorded. Fleet API sync remains authoritative for scoring.",
  };
}

export function recordQrReturn(cameraId: string, email?: string) {
  const db = getDb();
  const now = nowISO();
  const cam = cameraId.trim();
  if (!cam) throw new Error("cameraId required");

  const open = db
    .prepare(
      `SELECT assignment_id, email, source
       FROM assignment_history
       WHERE camera_id = ? AND status = 'open' AND unassigned_at_utc IS NULL
       ORDER BY assigned_at_utc DESC`,
    )
    .all(cam) as Array<{ assignment_id: string; email: string; source: string }>;

  const targetEmail = email?.trim().toLowerCase();
  let closed = 0;
  for (const row of open) {
    if (targetEmail && row.email.toLowerCase() !== targetEmail) continue;
    // Return closes QR immediately; also close Fleet for this holder so penalties stop
    // until Evidence reports a new owner.
    db.prepare(
      `UPDATE assignment_history
       SET unassigned_at_utc = ?, status = 'closed'
       WHERE assignment_id = ?`,
    ).run(now, row.assignment_id);
    closed += 1;
  }

  if (targetEmail) {
    db.prepare(
      `UPDATE participants SET camera_id = NULL, updated_at = ?
       WHERE camera_id = ? AND lower(email) = lower(?)`,
    ).run(now, cam, targetEmail);
  } else {
    db.prepare(
      `UPDATE participants SET camera_id = NULL, updated_at = ? WHERE camera_id = ?`,
    ).run(now, cam);
  }

  audit(targetEmail || "qr-return", "qr.return", {
    entityType: "camera",
    entityId: cam,
    newValue: { closed, email: targetEmail || null },
  });

  return {
    returned: true,
    cameraId: cam,
    email: targetEmail || null,
    closed,
    message: closed
      ? "Return recorded; open assignment intervals closed."
      : "No open assignment found for this camera.",
  };
}
