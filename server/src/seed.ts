import { getDb, nowISO, audit } from "./db.js";
import { PERMANENT_HOLDER_EMAILS } from "./config/permanentHolders.js";
import { suppressParticipants } from "./removedParticipants.js";
import { ensureDefaultMappingProfiles } from "./import/mapping.js";
import { listLeaderboardWeeks, recomputeWeekScores } from "./scoring/engine.js";
import { weekStartUtcISO } from "./week.js";

/** Synthetic demo roster — not used in live Fleet/Splunk mode. */
const DEMO_PARTICIPANTS = [
  { email: "alice@northline.example", name: "Alice Chen", hub: "Phoenix" },
  { email: "bob@northline.example", name: "Bob Rivera", hub: "Phoenix" },
  { email: "cara@northline.example", name: "Cara Nguyen", hub: "Seattle" },
  { email: "devon@northline.example", name: "Devon Park", hub: "Phoenix" },
  { email: "elena@northline.example", name: "Elena Brooks", hub: "Boston" },
  { email: "frank@northline.example", name: "Frank Okonkwo", hub: "Phoenix" },
  { email: "grace@northline.example", name: "Grace Kim", hub: "Seattle" },
  { email: "hank@northline.example", name: "Hank Morales", hub: "Phoenix" },
];

const DEMO_CAMERAS = [
  "FC-1001",
  "FC-1002",
  "FC-1003",
  "FC-1004",
  "FC-1005",
  "FC-1006",
  "FC-1007",
  "FC-1008",
];

const DEMO_EMAILS = DEMO_PARTICIPANTS.map((p) => p.email);

/**
 * Opt-in only (fixtures / local demos). Do not call on API boot when using live Fleet.
 */
export function seedDemoData(actor = "system"): {
  participants: number;
  cameras: number;
  weekStart: string;
} {
  const db = getDb();
  ensureDefaultMappingProfiles();
  const now = nowISO();

  const upsertP = db.prepare(
    `INSERT INTO participants (
      email, name, hub, signup_status, enrolled_at, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'approved', ?, 'Active', ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = excluded.name,
      hub = excluded.hub,
      signup_status = 'approved',
      updated_at = excluded.updated_at`,
  );

  const upsertC = db.prepare(
    `INSERT INTO cameras (camera_id, label, created_at) VALUES (?, ?, ?)
     ON CONFLICT(camera_id) DO NOTHING`,
  );

  const tx = db.transaction(() => {
    for (const p of DEMO_PARTICIPANTS) {
      upsertP.run(p.email, p.name, p.hub, now, now, now);
    }
    for (const c of DEMO_CAMERAS) {
      upsertC.run(c, c, now);
    }
  });
  tx();

  const weekStart = weekStartUtcISO(new Date());
  recomputeWeekScores(weekStart);

  audit(actor, "seed.demo", {
    newValue: { participants: DEMO_PARTICIPANTS.length, cameras: DEMO_CAMERAS.length },
  });

  return {
    participants: DEMO_PARTICIPANTS.length,
    cameras: DEMO_CAMERAS.length,
    weekStart,
  };
}

/** Remove synthetic roster, FC-100x cameras, and all rows tied to them. */
export function purgeDemoData(actor = "system"): {
  removedParticipants: number;
  removedCameras: number;
  removedEvents: number;
  removedAssignments: number;
  weeksRecomputed: string[];
} {
  const db = getDb();
  const emailPlaceholders = DEMO_EMAILS.map(() => "?").join(",");
  const camPlaceholders = DEMO_CAMERAS.map(() => "?").join(",");

  const beforeParticipants = (
    db
      .prepare(`SELECT count(*) AS c FROM participants WHERE email IN (${emailPlaceholders})`)
      .get(...DEMO_EMAILS) as { c: number }
  ).c;
  const beforeCameras = (
    db
      .prepare(`SELECT count(*) AS c FROM cameras WHERE camera_id IN (${camPlaceholders})`)
      .get(...DEMO_CAMERAS) as { c: number }
  ).c;
  const beforeEvents = (
    db
      .prepare(
        `SELECT count(*) AS c FROM activity_events
         WHERE camera_id IN (${camPlaceholders}) OR email IN (${emailPlaceholders})`,
      )
      .get(...DEMO_CAMERAS, ...DEMO_EMAILS) as { c: number }
  ).c;
  const beforeAssignments = (
    db
      .prepare(
        `SELECT count(*) AS c FROM assignment_history
         WHERE camera_id IN (${camPlaceholders}) OR email IN (${emailPlaceholders})`,
      )
      .get(...DEMO_CAMERAS, ...DEMO_EMAILS) as { c: number }
  ).c;

  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM activity_events
       WHERE camera_id IN (${camPlaceholders}) OR email IN (${emailPlaceholders})`,
    ).run(...DEMO_CAMERAS, ...DEMO_EMAILS);
    db.prepare(
      `DELETE FROM quarantined_activity
       WHERE camera_id IN (${camPlaceholders})`,
    ).run(...DEMO_CAMERAS);
    db.prepare(
      `DELETE FROM assignment_history
       WHERE camera_id IN (${camPlaceholders}) OR email IN (${emailPlaceholders})`,
    ).run(...DEMO_CAMERAS, ...DEMO_EMAILS);
    db.prepare(
      `DELETE FROM daily_activity WHERE email IN (${emailPlaceholders})`,
    ).run(...DEMO_EMAILS);
    db.prepare(
      `DELETE FROM weekly_scores WHERE email IN (${emailPlaceholders})`,
    ).run(...DEMO_EMAILS);
    db.prepare(
      `DELETE FROM pending_nudges WHERE email IN (${emailPlaceholders})`,
    ).run(...DEMO_EMAILS);
    db.prepare(
      `DELETE FROM reports WHERE email IN (${emailPlaceholders})`,
    ).run(...DEMO_EMAILS);
    db.prepare(
      `DELETE FROM participants WHERE email IN (${emailPlaceholders})`,
    ).run(...DEMO_EMAILS);
    db.prepare(
      `DELETE FROM cameras WHERE camera_id IN (${camPlaceholders})`,
    ).run(...DEMO_CAMERAS);
  });
  tx();

  const weeks = listLeaderboardWeeks();
  for (const ws of weeks) {
    recomputeWeekScores(ws);
  }

  audit(actor, "seed.purge_demo", {
    newValue: {
      removedParticipants: beforeParticipants,
      removedCameras: beforeCameras,
      removedEvents: beforeEvents,
      removedAssignments: beforeAssignments,
      weeksRecomputed: weeks,
    },
  });

  return {
    removedParticipants: beforeParticipants,
    removedCameras: beforeCameras,
    removedEvents: beforeEvents,
    removedAssignments: beforeAssignments,
    weeksRecomputed: weeks,
  };
}

const CHECKOUT_INVENTORY_RESET_KEY = "checkout_inventory_reset";
const CHECKOUT_INVENTORY_RESET_VALUE = "2026-08-24-demo-agency";

/**
 * One-time Harbor/local wipe of checkout cameras and checkout users.
 * Permanent holders and their camera assignments stay, so a rebuilt database can still
 * attribute Splunk rows. Checkout cameras with no remaining assignment are removed.
 */
export function purgeCheckoutInventoryOnce(actor = "boot"): {
  ran: boolean;
  removedCameras: number;
  removedParticipants: number;
} {
  const db = getDb();
  const row = db
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(CHECKOUT_INVENTORY_RESET_KEY) as { value: string } | undefined;
  if (row?.value === CHECKOUT_INVENTORY_RESET_VALUE) {
    return { ran: false, removedCameras: 0, removedParticipants: 0 };
  }

  const keep = [...PERMANENT_HOLDER_EMAILS];
  const placeholders = keep.map(() => "?").join(",");
  const beforeCameras = (db.prepare(`SELECT count(*) AS c FROM cameras`).get() as { c: number }).c;
  const beforePeople = (
    db
      .prepare(`SELECT count(*) AS c FROM participants WHERE lower(email) NOT IN (${placeholders})`)
      .get(...keep) as { c: number }
  ).c;

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM weekly_scores`).run();
    db.prepare(`DELETE FROM daily_activity`).run();
    db.prepare(`DELETE FROM weekly_snapshots`).run();
    db.prepare(`DELETE FROM score_adjustments`).run();
    db.prepare(`DELETE FROM activity_events`).run();
    db.prepare(`DELETE FROM quarantined_activity`).run();
    db.prepare(`DELETE FROM assignment_history WHERE lower(email) NOT IN (${placeholders})`).run(...keep);
    db.prepare(`DELETE FROM pending_nudges`).run();
    db.prepare(`DELETE FROM challenge_awards`).run();
    db.prepare(
      `DELETE FROM cameras WHERE camera_id NOT IN (SELECT camera_id FROM assignment_history)`,
    ).run();
    db.prepare(`UPDATE participants SET camera_id = NULL`).run();
    db.prepare(`DELETE FROM participants WHERE lower(email) NOT IN (${placeholders})`).run(...keep);
    db.prepare(
      `INSERT INTO sync_meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(CHECKOUT_INVENTORY_RESET_KEY, CHECKOUT_INVENTORY_RESET_VALUE);
  });
  tx();

  audit(actor, "seed.purge_checkout_inventory", {
    newValue: {
      removedCameras: beforeCameras,
      removedParticipants: beforePeople,
      keepPermanentHolders: keep.length,
    },
  });
  console.log(
    `Checkout inventory reset: removed ${beforeCameras} cameras and ${beforePeople} checkout users`,
  );
  return { ran: true, removedCameras: beforeCameras, removedParticipants: beforePeople };
}

/**
 * On-demand removal of every participant who is NOT on the fixed `PERMANENT_HOLDERS` roster,
 * plus all of their scoring/activity data. Unlike `purgeCheckoutInventoryOnce`, this is callable
 * any time an admin wants it (no once-only guard) and scopes deletes to just those emails —
 * it does not touch permanent holders' own activity, scores, or camera inventory.
 *
 * `dryRun: true` (default) only reports who would be removed; pass `dryRun: false` to actually
 * delete. Always call with dryRun first — this is not reversible.
 */
export function purgeNonPermanentParticipants(
  actor: string,
  opts: { dryRun?: boolean } = {},
): {
  dryRun: boolean;
  emails: string[];
  removedParticipants: number;
  removedActivityEvents: number;
  removedAssignments: number;
  weeksRecomputed: string[];
} {
  const dryRun = opts.dryRun !== false;
  const db = getDb();
  const keep = [...PERMANENT_HOLDER_EMAILS];
  const keepPlaceholders = keep.map(() => "?").join(",");

  const emails = (
    db
      .prepare(`SELECT email FROM participants WHERE lower(email) NOT IN (${keepPlaceholders})`)
      .all(...keep) as Array<{ email: string }>
  ).map((r) => r.email);

  if (!emails.length) {
    return {
      dryRun,
      emails: [],
      removedParticipants: 0,
      removedActivityEvents: 0,
      removedAssignments: 0,
      weeksRecomputed: [],
    };
  }

  const emailPlaceholders = emails.map(() => "?").join(",");
  const countIn = (table: string, col = "email") =>
    (
      db
        .prepare(`SELECT count(*) AS c FROM ${table} WHERE ${col} IN (${emailPlaceholders})`)
        .get(...emails) as { c: number }
    ).c;

  const removedActivityEvents = countIn("activity_events");
  const removedAssignments = countIn("assignment_history");

  if (dryRun) {
    return {
      dryRun,
      emails,
      removedParticipants: emails.length,
      removedActivityEvents,
      removedAssignments,
      weeksRecomputed: [],
    };
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM weekly_scores WHERE email IN (${emailPlaceholders})`).run(...emails);
    db.prepare(`DELETE FROM daily_activity WHERE email IN (${emailPlaceholders})`).run(...emails);
    db.prepare(`DELETE FROM score_adjustments WHERE email IN (${emailPlaceholders})`).run(...emails);
    db.prepare(`DELETE FROM activity_events WHERE email IN (${emailPlaceholders})`).run(...emails);
    db.prepare(`DELETE FROM assignment_history WHERE email IN (${emailPlaceholders})`).run(...emails);
    db.prepare(`DELETE FROM pending_nudges WHERE email IN (${emailPlaceholders})`).run(...emails);
    db.prepare(`DELETE FROM challenge_awards WHERE email IN (${emailPlaceholders})`).run(...emails);
    db.prepare(`DELETE FROM reports WHERE email IN (${emailPlaceholders})`).run(...emails);
    db.prepare(`DELETE FROM participants WHERE email IN (${emailPlaceholders})`).run(...emails);
  });
  tx();

  const weeks = listLeaderboardWeeks();
  for (const ws of weeks) {
    recomputeWeekScores(ws);
  }

  suppressParticipants(actor, emails, "purged: not a permanent holder");

  audit(actor, "seed.purge_non_permanent", {
    newValue: { emails, removedActivityEvents, removedAssignments, weeksRecomputed: weeks },
  });

  return {
    dryRun,
    emails,
    removedParticipants: emails.length,
    removedActivityEvents,
    removedAssignments,
    weeksRecomputed: weeks,
  };
}

const CHECKOUT_ROSTER_RESET_KEY = "checkout_roster_reset";
const CHECKOUT_ROSTER_RESET_VALUE = "2026-08-24-new-slate";

/**
 * One-time Harbor wipe of checkout-tab people (everyone not on PERMANENT_HOLDERS) so they must
 * sign up again. Permanent holders and their scores stay. Guarded by sync_meta so later
 * restarts do not delete new signups.
 */
export function purgeNonPermanentParticipantsOnce(actor = "boot"): {
  ran: boolean;
  emails: string[];
  removedParticipants: number;
} {
  const db = getDb();
  const row = db
    .prepare(`SELECT value FROM sync_meta WHERE key = ?`)
    .get(CHECKOUT_ROSTER_RESET_KEY) as { value: string } | undefined;
  if (row?.value === CHECKOUT_ROSTER_RESET_VALUE) {
    return { ran: false, emails: [], removedParticipants: 0 };
  }

  const result = purgeNonPermanentParticipants(actor, { dryRun: false });
  db.prepare(
    `INSERT INTO sync_meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(CHECKOUT_ROSTER_RESET_KEY, CHECKOUT_ROSTER_RESET_VALUE);

  console.log(
    `Checkout roster reset: removed ${result.removedParticipants} non-permanent participants`,
  );
  return {
    ran: true,
    emails: result.emails,
    removedParticipants: result.removedParticipants,
  };
}

/**
 * Manual admin removal of one or more specific participants (checked by email), plus all of their
 * scoring/activity data. Unlike `purgeNonPermanentParticipants`, this doesn't care whether the
 * email is a permanent holder — it removes exactly whoever the admin selected.
 *
 * `dryRun: true` (default) only reports what would be removed; pass `dryRun: false` to actually
 * delete. Always dry-run first — this is not reversible.
 */
export function removeParticipants(
  actor: string,
  emails: string[],
  opts: { dryRun?: boolean } = {},
): {
  dryRun: boolean;
  emails: string[];
  removedParticipants: number;
  removedActivityEvents: number;
  removedAssignments: number;
  weeksRecomputed: string[];
} {
  const dryRun = opts.dryRun !== false;
  const db = getDb();
  const normalized = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];

  if (!normalized.length) {
    return {
      dryRun,
      emails: [],
      removedParticipants: 0,
      removedActivityEvents: 0,
      removedAssignments: 0,
      weeksRecomputed: [],
    };
  }

  const placeholders = normalized.map(() => "?").join(",");
  const existing = (
    db
      .prepare(`SELECT email FROM participants WHERE lower(email) IN (${placeholders})`)
      .all(...normalized) as Array<{ email: string }>
  ).map((r) => r.email);

  if (!existing.length) {
    return {
      dryRun,
      emails: [],
      removedParticipants: 0,
      removedActivityEvents: 0,
      removedAssignments: 0,
      weeksRecomputed: [],
    };
  }

  const existingPlaceholders = existing.map(() => "?").join(",");
  const countIn = (table: string) =>
    (
      db
        .prepare(`SELECT count(*) AS c FROM ${table} WHERE email IN (${existingPlaceholders})`)
        .get(...existing) as { c: number }
    ).c;

  const removedActivityEvents = countIn("activity_events");
  const removedAssignments = countIn("assignment_history");

  if (dryRun) {
    return {
      dryRun,
      emails: existing,
      removedParticipants: existing.length,
      removedActivityEvents,
      removedAssignments,
      weeksRecomputed: [],
    };
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM weekly_scores WHERE email IN (${existingPlaceholders})`).run(...existing);
    db.prepare(`DELETE FROM daily_activity WHERE email IN (${existingPlaceholders})`).run(...existing);
    db.prepare(`DELETE FROM score_adjustments WHERE email IN (${existingPlaceholders})`).run(...existing);
    db.prepare(`DELETE FROM activity_events WHERE email IN (${existingPlaceholders})`).run(...existing);
    db.prepare(`DELETE FROM assignment_history WHERE email IN (${existingPlaceholders})`).run(...existing);
    db.prepare(`DELETE FROM pending_nudges WHERE email IN (${existingPlaceholders})`).run(...existing);
    db.prepare(`DELETE FROM challenge_awards WHERE email IN (${existingPlaceholders})`).run(...existing);
    db.prepare(`DELETE FROM reports WHERE email IN (${existingPlaceholders})`).run(...existing);
    db.prepare(`DELETE FROM participants WHERE email IN (${existingPlaceholders})`).run(...existing);
  });
  tx();

  const weeks = listLeaderboardWeeks();
  for (const ws of weeks) {
    recomputeWeekScores(ws);
  }

  // Tombstone them so the permanent-holder seed and activity backfill cannot re-add them on the
  // next leaderboard load. Registering a camera in the agency again lifts this.
  suppressParticipants(actor, existing, "removed by admin");

  audit(actor, "participants.remove", {
    newValue: { emails: existing, removedActivityEvents, removedAssignments, weeksRecomputed: weeks },
  });

  return {
    dryRun,
    emails: existing,
    removedParticipants: existing.length,
    removedActivityEvents,
    removedAssignments,
    weeksRecomputed: weeks,
  };
}
