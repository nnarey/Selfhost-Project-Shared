/** Local demo only — omitted from production/Harbor bundles. */
export const ADMIN_PASSWORD = import.meta.env.DEV
  ? (import.meta.env.VITE_ADMIN_PASSWORD as string | undefined) || "Password"
  : "";

/** Admins must use one of these emails + ADMIN_PASSWORD. */
export const ADMIN_EMAILS = [
  "alice@northline.example",
  "bob@northline.example",
  "cara@northline.example",
] as const;

/** Slack MCP DM targets — channel = email for send_slack_message. */
export const ADMIN_SLACK_MAP: { email: string; label: string }[] = [
  { email: "alice@northline.example", label: "Alice" },
  { email: "bob@northline.example", label: "Bob" },
  { email: "cara@northline.example", label: "Cara" },
];

export function isAdminEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return ADMIN_EMAILS.some((e) => e === normalized);
}
