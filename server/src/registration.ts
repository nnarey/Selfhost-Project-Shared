export const EXPECTED_HOURS_OPTIONS = [
  "Less than 5 hours",
  "5–15 hours",
  "15–30 hours",
  "30+ hours (Power User)",
] as const;

export const DAILY_FEATURE_OPTIONS = [
  "Standard Recordings (Testing continuous active use days)",
  "Tactile Button Presses (Testing physical button switches)",
  "Active Livestreaming Sessions",
  "Priority Upload Triggers",
  "Photo Captures",
] as const;

export type ExpectedHours = (typeof EXPECTED_HOURS_OPTIONS)[number];
export type DailyFeature = (typeof DAILY_FEATURE_OPTIONS)[number];

export interface RegistrationAnswers {
  roleDepartment: string;
  location: string;
  expectedHoursPerWeek: ExpectedHours;
  agreeReturnHardware: true;
  dailyFeatures: DailyFeature[];
  agreeProgressiveFeatures: true;
  agreeReportIssues: true;
}

export function parseRegistrationAnswers(raw: unknown): RegistrationAnswers {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const roleDepartment = String(body.roleDepartment || "").trim();
  const location = String(body.location || "").trim();

  const expectedHoursPerWeek = String(body.expectedHoursPerWeek || "").trim();
  if (!(EXPECTED_HOURS_OPTIONS as readonly string[]).includes(expectedHoursPerWeek)) {
    throw new Error("Select average expected field/active use hours per week");
  }

  if (body.agreeReturnHardware !== true) {
    throw new Error("You must agree to return the hardware for ME teardown analysis");
  }
  if (body.agreeProgressiveFeatures !== true) {
    throw new Error("You must agree to test only designated active features");
  }
  if (body.agreeReportIssues !== true) {
    throw new Error("You must commit to reporting unexpected camera behavior");
  }

  const featuresRaw = Array.isArray(body.dailyFeatures) ? body.dailyFeatures : [];
  const dailyFeatures = featuresRaw
    .map((f) => String(f))
    .filter((f) => (DAILY_FEATURE_OPTIONS as readonly string[]).includes(f)) as DailyFeature[];
  if (dailyFeatures.length === 0) {
    throw new Error("Select at least one feature you are ready to hammer daily");
  }

  return {
    roleDepartment,
    location,
    expectedHoursPerWeek: expectedHoursPerWeek as ExpectedHours,
    agreeReturnHardware: true,
    dailyFeatures,
    agreeProgressiveFeatures: true,
    agreeReportIssues: true,
  };
}
