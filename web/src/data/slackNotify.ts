import { ADMIN_SLACK_MAP } from "../config/admin";
import type { Complaint } from "./types";

/**
 * Builds Slack DM payloads for admins when a scoring complaint is filed.
 * In Cursor, send each with Slack MCP `send_slack_message` where `channel` = email.
 * The live Static app only persists complaints; agent/automation performs the DMs.
 *
 * For participant inactivity nudges (24h no recording), see `nudgeNotify.ts` and the
 * PendingNudges sheet — prefer `send_slack_bot_message` (Static app).
 */
export function buildComplaintSlackReminders(complaint: Complaint): {
  channel: string;
  text: string;
}[] {
  const text = [
    `*FieldCam scoring complaint* from *${complaint.name}* (\`${complaint.email}\`)`,
    "",
    complaint.body,
    "",
    `_id: ${complaint.id}_ · ${new Date(complaint.createdAt).toLocaleString()}`,
  ].join("\n");

  return ADMIN_SLACK_MAP.map(({ email }) => ({ channel: email, text }));
}
