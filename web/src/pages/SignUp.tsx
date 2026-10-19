import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import {
  DAILY_FEATURE_OPTIONS,
  EXPECTED_HOURS_OPTIONS,
} from "../config/registrationForm";
import { useAuth } from "../context/AuthContext";
import { isLocalApiConfigured, localParticipantSignup } from "../data/localApi";

export default function SignUp() {
  const { harborIdentity } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [roleDepartment, setRoleDepartment] = useState("");
  const [location, setLocation] = useState("");
  const [expectedHours, setExpectedHours] = useState("");
  const [dailyFeatures, setDailyFeatures] = useState<string[]>([]);
  const [agreeReturn, setAgreeReturn] = useState(false);
  const [agreeProgressive, setAgreeProgressive] = useState(false);
  const [agreeReport, setAgreeReport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const usesLocalApi = isLocalApiConfigured();
  const ssoSignup = Boolean(harborIdentity);

  useEffect(() => {
    if (!harborIdentity) return;
    setEmail(harborIdentity.email);
    if (harborIdentity.name) setName(harborIdentity.name);
  }, [harborIdentity]);

  function toggleFeature(feature: string) {
    setDailyFeatures((prev) =>
      prev.includes(feature) ? prev.filter((f) => f !== feature) : [...prev, feature],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!ssoSignup && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (!usesLocalApi) {
      setError("Sign up requires the local API. Set VITE_LOCAL_API_URL and restart Vite.");
      return;
    }
    if (!agreeReturn || !agreeProgressive || !agreeReport) {
      setError("Please accept all required commitments.");
      return;
    }
    if (!expectedHours || dailyFeatures.length === 0) {
      setError("Select expected hours and at least one daily feature.");
      return;
    }
    setSubmitting(true);
    try {
      await localParticipantSignup({
        email,
        name,
        password,
        registration: {
          roleDepartment,
          location,
          expectedHoursPerWeek: expectedHours,
          agreeReturnHardware: true,
          dailyFeatures,
          agreeProgressiveFeatures: true,
          agreeReportIssues: true,
        },
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader
          eyebrow="FieldCam Self-Host"
          title="You're registered"
          description={
            ssoSignup
              ? "You're registered with your SSO account. Refresh or open My Profile — no second password."
              : "You're registered. Open My Profile — there is no app password. An admin still needs to add you to the Fleet agency so the camera will work."
          }
        />
        <Card className="flex flex-col gap-4 p-6 text-sm text-[var(--color-text-muted)]">
          <p>
            Submitted as <span className="font-medium text-[var(--color-text)]">{email}</span>.
          </p>
          <Link
            to="/my-profile"
            className="rounded-lg bg-[var(--color-accent)] px-4 py-3 text-center text-sm font-bold text-[#e8edf4] hover:opacity-90"
          >
            Go to My Profile
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        eyebrow="FieldCam Self-Host Registration"
        title="Sign up"
        description="Registration for the FieldCam hardware prototype testing cohort, including tournament tracking and feedback commitments."
      />

      <Card className="p-6">
        <form className="flex flex-col gap-5" onSubmit={(e) => void handleSubmit(e)}>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-[var(--color-text)]">Full Name *</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-[var(--color-text)]">Northline Email Address *</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@northline.example"
              required
              readOnly={ssoSignup}
            />
          </label>

          {!ssoSignup && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-[var(--color-text)]">
              Password for this game *{" "}
              <span className="font-normal text-[var(--color-text-muted)]">
                (Don’t make it the same as your real password)
              </span>
            </span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>
          )}

          {!ssoSignup && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-[var(--color-text)]">Confirm password *</span>
            <input
              className="input"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-[var(--color-text)]">Role / Department</span>
            <input
              className="input"
              value={roleDepartment}
              onChange={(e) => setRoleDepartment(e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-[var(--color-text)]">Location</span>
            <input
              className="input"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Phoenix"
            />
          </label>

          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="font-medium text-[var(--color-text)]">
              Average Expected Field/Active Use Hours per Week *
            </legend>
            {EXPECTED_HOURS_OPTIONS.map((opt) => (
              <label key={opt} className="flex items-start gap-2 text-[var(--color-text-muted)]">
                <input
                  type="radio"
                  name="expectedHours"
                  className="mt-1"
                  checked={expectedHours === opt}
                  onChange={() => setExpectedHours(opt)}
                  required
                />
                <span>{opt}</span>
              </label>
            ))}
          </fieldset>

          <label className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              className="mt-1"
              checked={agreeReturn}
              onChange={(e) => setAgreeReturn(e.target.checked)}
              required
            />
            <span>
              I understand that this device is an early prototype and that I must return it at the
              end of the cohort so Mechanical Engineering can take it apart to inspect it for
              physical wear and tear. *{" "}
              <span className="text-[var(--color-text)]">
                I agree to return the hardware for ME teardown analysis.
              </span>
            </span>
          </label>

          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="font-medium text-[var(--color-text)]">
              To score points in the tournament, you will need to actively trigger specific camera
              actions that match our baseline tracking needs. Check the features you are ready to
              hammer daily: *
            </legend>
            {DAILY_FEATURE_OPTIONS.map((opt) => (
              <label key={opt} className="flex items-start gap-2 text-[var(--color-text-muted)]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={dailyFeatures.includes(opt)}
                  onChange={() => toggleFeature(opt)}
                />
                <span>{opt}</span>
              </label>
            ))}
          </fieldset>

          <label className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              className="mt-1"
              checked={agreeProgressive}
              onChange={(e) => setAgreeProgressive(e.target.checked)}
              required
            />
            <span>
              Because we are testing features released sequentially up through the August software
              roadmap, not all final production features will be active on day one. Do you agree to
              test only designated active features? *{" "}
              <span className="text-[var(--color-text)]">
                Yes, I understand that features are dropping progressively.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              className="mt-1"
              checked={agreeReport}
              onChange={(e) => setAgreeReport(e.target.checked)}
              required
            />
            <span>
              Self-host lives and breathes on edge-case discovery. If you encounter an unexpected
              camera behavior, do you commit to logging a quick text via the prototype site or Slack
              right away so we can flag it for Engineering? *{" "}
              <span className="text-[var(--color-text)]">
                Yes, I will report weird/unexpected behaviors immediately.
              </span>
            </span>
          </label>

          {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-3 text-sm font-bold text-[#e8edf4] hover:opacity-90 disabled:opacity-60"
          >
            {submitting ? "Submitting…" : "Submit registration"}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-[var(--color-text-faint)]">
          Already registered?{" "}
          <Link to="/my-profile" className="font-semibold text-[var(--color-accent)] underline">
            Open My Profile
          </Link>
        </p>
      </Card>
    </div>
  );
}
