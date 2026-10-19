import { Link } from "react-router-dom";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import { useAuth } from "../context/AuthContext";

export default function Login() {
  const { session, harborIdentity, harborNeedsSignup } = useAuth();

  if (session) {
    return (
      <div className="mx-auto max-w-md">
        <PageHeader
          title="You're signed in"
          description={`Signed in as ${session.email}${
            session.isAdmin && session.isParticipant
              ? " (admin and participant)"
              : ` (${session.role})`
          }.`}
        />
        <Card className="flex flex-col gap-3 p-5">
          {(session.role === "admin" || session.isAdmin) && (
            <Link
              to="/admin"
              className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-center text-sm font-bold text-[#e8edf4]"
            >
              Continue to Admin
            </Link>
          )}
          {(session.role === "participant" || session.isParticipant) && (
            <Link
              to="/my-profile"
              className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-center text-sm font-semibold text-[var(--color-text)]"
            >
              Continue to My Profile
            </Link>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <PageHeader
        eyebrow="Account"
        title="Account"
        description={
          harborIdentity
            ? `You're signed in as ${harborIdentity.email}. There is no app password.`
            : "Identity comes from SSO (Harbor) or the local laptop account. There is no app password."
        }
      />

      {harborIdentity && harborNeedsSignup && (
        <Card className="mb-4 p-5 text-sm text-[var(--color-text-muted)]">
          <p>
            No self-host row yet for{" "}
            <span className="font-medium text-[var(--color-text)]">{harborIdentity.email}</span>.
          </p>
          <Link
            to="/sign-up"
            className="mt-3 inline-block rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-[#e8edf4]"
          >
            Finish sign up
          </Link>
        </Card>
      )}

      {!harborNeedsSignup && (
        <Card className="p-5 text-sm text-[var(--color-text-muted)]">
          <p>
            Open{" "}
            <Link to="/my-profile" className="font-semibold text-[var(--color-accent)] underline">
              My Profile
            </Link>{" "}
            or{" "}
            <Link to="/sign-up" className="font-semibold text-[var(--color-accent)] underline">
              Sign up
            </Link>{" "}
            if you are new.
          </p>
        </Card>
      )}
    </div>
  );
}
