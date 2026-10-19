import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as ds from "../data/dataSource";
import {
  isLocalApiConfigured,
  localAdminLogin,
  localFetchMe,
  localParticipantLogin,
} from "../data/localApi";
import { isSheetsConfigured, sheetsLoginAdmin, sheetsLoginParticipant } from "../data/sheetsApi";
import {
  clearSession,
  readSession,
  writeSession,
  type Session,
} from "../data/session";

interface AuthContextValue {
  session: Session | null;
  harborIdentity: { email: string; name: string } | null;
  harborNeedsSignup: boolean;
  loginParticipant: (email: string, password: string) => Promise<void>;
  loginAdmin: (email: string, password: string) => Promise<void>;
  patchSession: (updates: Partial<Session>) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => readSession());
  const [harborIdentity, setHarborIdentity] = useState<{ email: string; name: string } | null>(null);
  const [harborNeedsSignup, setHarborNeedsSignup] = useState(false);

  useEffect(() => {
    if (session) writeSession(session);
    else clearSession();
  }, [session]);

  useEffect(() => {
    if (!isLocalApiConfigured()) return;
    void (async () => {
      try {
        const me = await localFetchMe();
        setHarborIdentity(me.identity);
        setHarborNeedsSignup(Boolean(me.needsSignup));
        if (!me.identity) return;
        if (me.admin) {
          sessionStorage.setItem("fieldcam_local_admin_token", me.admin.token);
          sessionStorage.setItem("fieldcam_local_admin_email", me.admin.email);
          setSession({
            email: me.admin.email,
            name: me.participant?.name || me.identity.name || me.admin.email.split("@")[0] || me.admin.email,
            role: "admin",
            harborSso: true,
            isAdmin: true,
            isParticipant: Boolean(me.participant),
            photoUrl: me.participant?.photoUrl ?? null,
            emailHash: me.participant?.emailHash,
            signupStatus: me.participant?.signupStatus,
            accessStatus: me.participant?.accessStatus,
          });
          return;
        }
        if (me.participant) {
          setSession({
            email: me.participant.email,
            name: me.participant.name,
            role: "participant",
            harborSso: true,
            isAdmin: false,
            isParticipant: true,
            photoUrl: me.participant.photoUrl ?? null,
            emailHash: me.participant.emailHash,
            signupStatus: me.participant.signupStatus,
            accessStatus: me.participant.accessStatus,
          });
        }
      } catch {
        // Identity fetch failed; Admin/My Profile will show until retry.
      }
    })();
  }, []);

  const loginParticipant = useCallback(async (email: string, password: string) => {
    if (isSheetsConfigured()) {
      const result = await sheetsLoginParticipant(email, password);
      setSession(result);
      return;
    }
    if (isLocalApiConfigured()) {
      const result = await localParticipantLogin(email, password);
      if (result.admin) {
        sessionStorage.setItem("fieldcam_local_admin_token", result.admin.token);
        sessionStorage.setItem("fieldcam_local_admin_email", result.admin.email);
      }
      setSession({
        email: result.email,
        name: result.name,
        role: result.admin ? "admin" : "participant",
        password,
        isAdmin: Boolean(result.admin),
        isParticipant: true,
        photoUrl: result.photoUrl ?? null,
        emailHash: result.emailHash,
        signupStatus: result.signupStatus,
        accessStatus: result.accessStatus,
      });
      return;
    }
    setSession(ds.loginParticipant(email, password));
  }, []);

  const loginAdmin = useCallback(async (email: string, password: string) => {
    if (isSheetsConfigured()) {
      const result = await sheetsLoginAdmin(email, password);
      setSession({ ...result, adminPassword: password });
      return;
    }
    if (isLocalApiConfigured()) {
      const result = await localAdminLogin(email, password);
      sessionStorage.setItem("fieldcam_local_admin_token", result.token);
      sessionStorage.setItem("fieldcam_local_admin_email", result.email);
      setSession({
        email: result.email,
        name: result.participant?.name || result.email.split("@")[0] || result.email,
        role: "admin",
        adminPassword: password,
        isAdmin: true,
        isParticipant: Boolean(result.participant),
        photoUrl: result.participant?.photoUrl ?? null,
        emailHash: result.participant?.emailHash,
        signupStatus: result.participant?.signupStatus,
        accessStatus: result.participant?.accessStatus,
      });
      return;
    }
    const result = ds.loginAdmin(email, password);
    setSession({ ...result, adminPassword: password });
  }, []);

  const logout = useCallback(() => {
    if (sessionStorage.getItem("fieldcam_local_admin_token")) {
      sessionStorage.removeItem("fieldcam_local_admin_token");
      sessionStorage.removeItem("fieldcam_local_admin_email");
    }
    setSession(null);
  }, []);

  const patchSession = useCallback((updates: Partial<Session>) => {
    setSession((prev) => (prev ? { ...prev, ...updates } : prev));
  }, []);

  const value = useMemo(
    () => ({ session, harborIdentity, harborNeedsSignup, loginParticipant, loginAdmin, patchSession, logout }),
    [session, harborIdentity, harborNeedsSignup, loginParticipant, loginAdmin, patchSession, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
