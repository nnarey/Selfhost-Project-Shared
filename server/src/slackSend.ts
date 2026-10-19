import { ENV } from "./env.js";

type SlackApiResponse = {
  ok?: boolean;
  error?: string;
  user?: { id?: string };
  channel?: { id?: string };
};

async function slackApi(
  method: string,
  body: Record<string, unknown> | URLSearchParams,
): Promise<SlackApiResponse> {
  const token = ENV.slackBotToken;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  const isForm = body instanceof URLSearchParams;
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(isForm
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : { "Content-Type": "application/json; charset=utf-8" }),
    },
    body: isForm ? body : JSON.stringify(body),
  });
  return (await res.json()) as SlackApiResponse;
}

/** DM an Northline email via Slack Web API. No-op when SLACK_BOT_TOKEN is unset. */
export async function sendSlackDm(
  email: string,
  text: string,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (!ENV.slackBotToken) {
    return { ok: false, skipped: true, error: "SLACK_BOT_TOKEN is not set" };
  }
  try {
    const lookup = await slackApi(
      "users.lookupByEmail",
      new URLSearchParams({ email }),
    );
    if (!lookup.ok || !lookup.user?.id) {
      return { ok: false, error: lookup.error || "slack user not found" };
    }
    const opened = await slackApi("conversations.open", { users: lookup.user.id });
    const channelId = opened.channel?.id;
    if (!opened.ok || !channelId) {
      return { ok: false, error: opened.error || "could not open DM" };
    }
    const posted = await slackApi("chat.postMessage", { channel: channelId, text });
    if (!posted.ok) {
      return { ok: false, error: posted.error || "chat.postMessage failed" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
