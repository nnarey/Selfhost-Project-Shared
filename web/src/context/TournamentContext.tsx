import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ADMIN_PASSWORD } from "../config/admin";
import * as ds from "../data/dataSource";
import {
  adminAuthFromSession,
  fetchSheetsSnapshot,
  isSheetsConfigured,
  sheetsAssignTeam,
  sheetsCheckoutDevice,
  sheetsCreateComplaint,
  sheetsCreateMatch,
  sheetsDeleteActivity,
  sheetsDeleteMatch,
  sheetsForceNudge,
  sheetsMarkNudgeFailed,
  sheetsMarkNudgeSent,
  sheetsRecordReturn,
  sheetsResolveComplaint,
  sheetsReturnDevice,
  sheetsRunNudgeJob,
  sheetsSetStatus,
  sheetsUpdateProfilePhoto,
  sheetsUpdateSerial,
  sheetsUpdateTeamProfile,
  sheetsUpsertActivity,
  sheetsUpsertMatch,
} from "../data/sheetsApi";
import { useAuth } from "./AuthContext";
import type {
  ActivityRecord,
  Complaint,
  Device,
  FormSignup,
  Match,
  MatchStage,
  NewParticipantInput,
  NudgeJobResult,
  NudgeKind,
  Participant,
  PendingNudge,
  Team,
} from "../data/types";

const POLL_INTERVAL_MS = 3 * 60 * 1000;

interface TournamentContextValue {
  backend: "local" | "sheets";
  loading: boolean;
  backendError: string | null;
  participants: Participant[];
  teams: Team[];
  activity: ActivityRecord[];
  matches: Match[];
  devices: Device[];
  formSignups: FormSignup[];
  unassignedSignups: Omit<FormSignup, "password">[];
  complaints: Complaint[];
  pendingSlackReminders: { channel: string; text: string }[];
  /** Sheets-backed Slack inactivity queue (empty in local mode). */
  pendingNudges: PendingNudge[];
  lastUpdated: Date;
  refresh: () => void;
  addParticipant: (input: NewParticipantInput) => Promise<Participant>;
  assignTeam: (email: string, teamId: string) => Promise<void>;
  updateSerial: (email: string, serial: string) => Promise<void>;
  checkoutDevice: (email: string, serial: string) => Promise<void>;
  returnDevice: (email: string) => Promise<void>;
  recordReturn: (email: string) => Promise<void>;
  setStatus: (email: string, status: "Active" | "Inactive") => Promise<void>;
  updateTeamProfile: (
    teamId: string,
    updates: { name?: string; color?: string; logoUrl?: string | null; crest?: string },
    requesterEmail: string,
  ) => Promise<void>;
  updateTeamProfileAsAdmin: (
    teamId: string,
    updates: { name?: string; color?: string; logoUrl?: string | null; crest?: string },
  ) => Promise<void>;
  updateProfilePhoto: (email: string, photoUrl: string) => Promise<void>;
  upsertActivity: (record: ActivityRecord) => Promise<void>;
  deleteActivity: (email: string, date: string) => Promise<void>;
  upsertMatch: (match: Match) => Promise<void>;
  deleteMatch: (matchId: string) => Promise<void>;
  createMatch: (input: {
    stage: MatchStage;
    group?: Match["group"];
    round?: number;
    homeTeamId: string | null;
    awayTeamId: string | null;
    startDate: string;
    endDate: string;
  }) => Promise<Match>;
  createComplaint: (email: string, body: string) => Promise<Complaint>;
  resolveComplaint: (id: string, adminNote?: string) => Promise<void>;
  clearPendingSlackReminders: () => void;
  runNudgeJob: (dryRun: boolean) => Promise<NudgeJobResult>;
  forceNudge: (email: string, kind: NudgeKind, dryRun: boolean) => Promise<Record<string, unknown>>;
  markNudgeSent: (id: string) => Promise<void>;
  markNudgeFailed: (id: string, error?: string) => Promise<void>;
  resetDemoData: () => void;
}

const TournamentContext = createContext<TournamentContextValue | null>(null);

const emptySnapshot = {
  participants: [] as Participant[],
  teams: [] as Team[],
  activity: [] as ActivityRecord[],
  matches: [] as Match[],
  devices: [] as Device[],
  formSignups: [] as FormSignup[],
  unassignedSignups: [] as Omit<FormSignup, "password">[],
  complaints: [] as Complaint[],
  pendingNudges: [] as PendingNudge[],
};

export function TournamentProvider({ children }: { children: ReactNode }) {
  const sheets = isSheetsConfigured();
  const { session } = useAuth();
  const [tick, setTick] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [loading, setLoading] = useState(sheets);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [remote, setRemote] = useState(emptySnapshot);

  const bumpLocal = useCallback(() => {
    setTick((t) => t + 1);
    setLastUpdated(new Date());
  }, []);

  const loadSheets = useCallback(async () => {
    if (!isSheetsConfigured()) return;
    try {
      const snap = await fetchSheetsSnapshot();
      setRemote(snap);
      setBackendError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setBackendError(err instanceof Error ? err.message : "Failed to load Sheets data");
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    if (isSheetsConfigured()) {
      void loadSheets();
    } else {
      bumpLocal();
    }
  }, [bumpLocal, loadSheets]);

  useEffect(() => {
    if (!sheets) {
      const unsubscribe = ds.subscribe(bumpLocal);
      const interval = setInterval(bumpLocal, POLL_INTERVAL_MS);
      return () => {
        unsubscribe();
        clearInterval(interval);
      };
    }
    void loadSheets();
    const interval = setInterval(() => void loadSheets(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [sheets, bumpLocal, loadSheets]);

  const adminAuth = useMemo(() => {
    if (session?.role === "admin") {
      return adminAuthFromSession(session.email, session.adminPassword);
    }
    return adminAuthFromSession("", ADMIN_PASSWORD);
  }, [session]);

  const localParticipants = useMemo(() => (sheets ? [] : ds.listParticipants()), [sheets, tick]);
  const localTeams = useMemo(() => (sheets ? [] : ds.listTeams()), [sheets, tick]);
  const localActivity = useMemo(() => (sheets ? [] : ds.listActivity()), [sheets, tick]);
  const localMatches = useMemo(() => (sheets ? [] : ds.listMatches()), [sheets, tick]);
  const localDevices = useMemo(() => (sheets ? [] : ds.listDevices()), [sheets, tick]);
  const localFormSignups = useMemo(() => (sheets ? [] : ds.listFormSignups()), [sheets, tick]);
  const localUnassigned = useMemo(() => (sheets ? [] : ds.listUnassignedSignups()), [sheets, tick]);
  const localComplaints = useMemo(() => (sheets ? [] : ds.listComplaints()), [sheets, tick]);
  const pendingSlackReminders = useMemo(
    () => (sheets ? [] : ds.listPendingSlackReminders()),
    [sheets, tick],
  );

  const participants = sheets ? remote.participants : localParticipants;
  const teams = sheets ? remote.teams : localTeams;
  const activity = sheets ? remote.activity : localActivity;
  const matches = sheets ? remote.matches : localMatches;
  const devices = sheets ? remote.devices : localDevices;
  const formSignups = sheets ? remote.formSignups : localFormSignups;
  const unassignedSignups = sheets ? remote.unassignedSignups : localUnassigned;
  const complaints = sheets ? remote.complaints : localComplaints;
  const pendingNudges = sheets ? remote.pendingNudges : [];

  const value = useMemo<TournamentContextValue>(
    () => ({
      backend: sheets ? "sheets" : "local",
      loading,
      backendError,
      participants,
      teams,
      activity,
      matches,
      devices,
      formSignups,
      unassignedSignups,
      complaints,
      pendingSlackReminders,
      pendingNudges,
      lastUpdated,
      refresh,
      addParticipant: async (input) => {
        if (sheets) throw new Error("addParticipant is local-only; use Form + Admin assign");
        const p = ds.addParticipant(input);
        bumpLocal();
        return p;
      },
      assignTeam: async (email, teamId) => {
        if (sheets) {
          await sheetsAssignTeam(adminAuth, email, teamId);
          await loadSheets();
          return;
        }
        ds.assignTeam(email, teamId);
        bumpLocal();
      },
      updateSerial: async (email, serial) => {
        if (sheets) {
          await sheetsUpdateSerial(adminAuth, email, serial);
          await loadSheets();
          return;
        }
        ds.updateSerial(email, serial);
        bumpLocal();
      },
      checkoutDevice: async (email, serial) => {
        if (sheets) {
          await sheetsCheckoutDevice(email, serial);
          await loadSheets();
          return;
        }
        ds.checkoutDevice(email, serial);
        bumpLocal();
      },
      returnDevice: async (email) => {
        if (sheets) {
          await sheetsReturnDevice(email);
          await loadSheets();
          return;
        }
        ds.returnDevice(email);
        bumpLocal();
      },
      recordReturn: async (email) => {
        if (sheets) {
          await sheetsRecordReturn(adminAuth, email);
          await loadSheets();
          return;
        }
        ds.recordReturn(email);
        bumpLocal();
      },
      setStatus: async (email, status) => {
        if (sheets) {
          await sheetsSetStatus(adminAuth, email, status);
          await loadSheets();
          return;
        }
        ds.setStatus(email, status);
        bumpLocal();
      },
      updateTeamProfile: async (teamId, updates, requesterEmail) => {
        if (sheets) {
          await sheetsUpdateTeamProfile({ teamId, ...updates, requesterEmail });
          await loadSheets();
          return;
        }
        ds.updateTeamProfile(teamId, updates, requesterEmail);
        bumpLocal();
      },
      updateTeamProfileAsAdmin: async (teamId, updates) => {
        if (sheets) {
          await sheetsUpdateTeamProfile({ teamId, ...updates });
          await loadSheets();
          return;
        }
        ds.updateTeamProfileAsAdmin(teamId, updates);
        bumpLocal();
      },
      updateProfilePhoto: async (email, photoUrl) => {
        if (sheets) {
          await sheetsUpdateProfilePhoto(email, photoUrl);
          await loadSheets();
          return;
        }
        ds.updateProfilePhoto(email, photoUrl);
        bumpLocal();
      },
      upsertActivity: async (record) => {
        if (sheets) {
          await sheetsUpsertActivity(adminAuth, record);
          await loadSheets();
          return;
        }
        ds.upsertActivity(record);
        bumpLocal();
      },
      deleteActivity: async (email, date) => {
        if (sheets) {
          await sheetsDeleteActivity(adminAuth, email, date);
          await loadSheets();
          return;
        }
        ds.deleteActivity(email, date);
        bumpLocal();
      },
      upsertMatch: async (match) => {
        if (sheets) {
          await sheetsUpsertMatch(adminAuth, match);
          await loadSheets();
          return;
        }
        ds.upsertMatch(match);
        bumpLocal();
      },
      deleteMatch: async (matchId) => {
        if (sheets) {
          await sheetsDeleteMatch(adminAuth, matchId);
          await loadSheets();
          return;
        }
        ds.deleteMatch(matchId);
        bumpLocal();
      },
      createMatch: async (input) => {
        if (sheets) {
          const match: Match = {
            id: `m-${Date.now()}`,
            ...input,
            played: false,
            provisional: input.stage !== "group",
          };
          const created = await sheetsCreateMatch(adminAuth, match);
          await loadSheets();
          return created;
        }
        const m = ds.createMatch(input);
        bumpLocal();
        return m;
      },
      createComplaint: async (email, body) => {
        if (sheets) {
          const c = await sheetsCreateComplaint(email, body);
          await loadSheets();
          return c;
        }
        const c = ds.createComplaint(email, body);
        bumpLocal();
        return c;
      },
      resolveComplaint: async (id, adminNote) => {
        if (sheets) {
          await sheetsResolveComplaint(adminAuth, id, adminNote);
          await loadSheets();
          return;
        }
        ds.resolveComplaint(id, adminNote);
        bumpLocal();
      },
      clearPendingSlackReminders: () => {
        if (!sheets) {
          ds.clearPendingSlackReminders();
          bumpLocal();
        }
      },
      runNudgeJob: async (dryRun) => {
        if (!sheets) {
          throw new Error("Nudge job requires Sheets / Apps Script (set VITE_APPS_SCRIPT_URL).");
        }
        const result = await sheetsRunNudgeJob(adminAuth, dryRun);
        if (!dryRun) await loadSheets();
        return result;
      },
      forceNudge: async (email, kind, dryRun) => {
        if (!sheets) {
          throw new Error("Force nudge requires Sheets / Apps Script (set VITE_APPS_SCRIPT_URL).");
        }
        const result = await sheetsForceNudge(adminAuth, email, kind, dryRun);
        if (!dryRun) await loadSheets();
        return result;
      },
      markNudgeSent: async (id) => {
        if (!sheets) return;
        await sheetsMarkNudgeSent(adminAuth, id);
        await loadSheets();
      },
      markNudgeFailed: async (id, error) => {
        if (!sheets) return;
        await sheetsMarkNudgeFailed(adminAuth, id, error);
        await loadSheets();
      },
      resetDemoData: () => {
        if (sheets) {
          setBackendError("Reset demo data is local-only. Clear Sheet tabs manually if needed.");
          return;
        }
        ds.resetDemoData();
        bumpLocal();
      },
    }),
    [
      sheets,
      loading,
      backendError,
      participants,
      teams,
      activity,
      matches,
      devices,
      formSignups,
      unassignedSignups,
      complaints,
      pendingSlackReminders,
      pendingNudges,
      lastUpdated,
      refresh,
      adminAuth,
      bumpLocal,
      loadSheets,
    ],
  );

  return <TournamentContext.Provider value={value}>{children}</TournamentContext.Provider>;
}

export function useTournament(): TournamentContextValue {
  const ctx = useContext(TournamentContext);
  if (!ctx) throw new Error("useTournament must be used within TournamentProvider");
  return ctx;
}
