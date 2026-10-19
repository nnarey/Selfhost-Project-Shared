// ABOUTME: Polls Jira on a timer and credits reporters when a self-host bug is triaged.
// ABOUTME: Stays idle unless JIRA_EMAIL and JIRA_API_TOKEN are set on this server.
import { ENV } from "../env.js";
import {
  buildJiraTriageSnapshot,
  syncJiraTriage,
  type JiraSearchPage,
  type JiraTriageSnapshot,
  type StatusChange,
} from "./triage.js";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

type History = {
  created?: string;
  items?: Array<{ field?: string; fromString?: string | null; toString?: string | null }>;
};

type ChangelogBody = {
  startAt?: number;
  total?: number;
  isLast?: boolean;
  values?: History[];
  histories?: History[];
};

export function jiraRestRoot(site: string, cloudId: string): string {
  const id = cloudId.trim();
  if (!id) return `https://${site}`;
  return `https://api.atlassian.com/ex/jira/${id}`;
}

function statusChanges(body: ChangelogBody): StatusChange[] {
  const out: StatusChange[] = [];
  for (const history of body.values ?? body.histories ?? []) {
    if (!history.created) continue;
    for (const item of history.items ?? []) {
      if (item.field !== "status" || !item.fromString || !item.toString) continue;
      out.push({ at: history.created, from: item.fromString, to: item.toString });
    }
  }
  return out;
}

export async function fetchJiraTriageSnapshot(): Promise<JiraTriageSnapshot> {
  if (!ENV.jiraEmail || !ENV.jiraApiToken) {
    throw new Error("JIRA_EMAIL and JIRA_API_TOKEN are required");
  }
  const auth = Buffer.from(`${ENV.jiraEmail}:${ENV.jiraApiToken}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };
  return buildJiraTriageSnapshot({
    site: ENV.jiraSite,
    epic: ENV.jiraEpic,
    search: (pageToken) => searchPage(headers, pageToken),
    changelog: (key) => loadChangelog(headers, key),
  });
}

export function startJiraTriagePoller(): void {
  if (!ENV.jiraEmail || !ENV.jiraApiToken) {
    console.log("Jira triage sync disabled (JIRA_EMAIL or JIRA_API_TOKEN unset)");
    return;
  }
  if (timer) return;

  const seconds = Math.max(60, ENV.jiraPollSeconds);
  console.log(`Jira triage sync enabled (every ${seconds}s, epic ${ENV.jiraEpic})`);
  const auth = Buffer.from(`${ENV.jiraEmail}:${ENV.jiraApiToken}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await syncJiraTriage({
        actor: "jira-poller",
        site: ENV.jiraSite,
        search: (pageToken) => searchPage(headers, pageToken),
        changelog: (key) => loadChangelog(headers, key),
      });
      console.log(
        `Jira triage sync: credited=${result.credited} moved=${result.moved} rejected=${result.rejected} unchanged=${result.unchanged}`,
      );
    } catch (err) {
      console.warn("Jira triage sync failed:", err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };

  setTimeout(() => void tick(), 1500);
  timer = setInterval(() => void tick(), seconds * 1000);
}

async function searchPage(
  headers: Record<string, string>,
  pageToken?: string,
): Promise<JiraSearchPage> {
  const jql = `parent = ${ENV.jiraEpic} AND status changed FROM "NEEDS TRIAGE" TO "Triaged"`;
  const root = jiraRestRoot(ENV.jiraSite, ENV.jiraCloudId);
  let url =
    `${root}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
    `&maxResults=100&fields=summary,reporter`;
  if (pageToken) url += `&nextPageToken=${encodeURIComponent(pageToken)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Jira search HTTP ${res.status}`);
  const body = (await res.json()) as {
    issues?: Array<{
      key: string;
      fields?: { summary?: string; reporter?: { emailAddress?: string } };
    }>;
    nextPageToken?: string;
    isLast?: boolean;
  };
  if ((body.issues?.length ?? 0) >= 100 && !body.nextPageToken && body.isLast !== true) {
    throw new Error("Jira search page was full and had no next page token");
  }
  return {
    issues: (body.issues ?? []).map((issue) => ({
      key: issue.key,
      summary: issue.fields?.summary || issue.key,
      reporterEmail: issue.fields?.reporter?.emailAddress || "",
    })),
    nextPageToken: body.nextPageToken,
  };
}

async function loadChangelog(headers: Record<string, string>, key: string): Promise<StatusChange[]> {
  const out: StatusChange[] = [];
  for (let startAt = 0, page = 0; page < 20; page++) {
    const url =
      `${jiraRestRoot(ENV.jiraSite, ENV.jiraCloudId)}/rest/api/3/issue/${encodeURIComponent(key)}/changelog` +
      `?startAt=${startAt}&maxResults=100`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Jira changelog HTTP ${res.status}`);
    const body = (await res.json()) as ChangelogBody;
    const histories = body.values ?? body.histories ?? [];
    out.push(...statusChanges(body));
    startAt += histories.length || 100;
    if (body.isLast || histories.length === 0 || (body.total != null && startAt >= body.total)) break;
  }
  return out;
}
