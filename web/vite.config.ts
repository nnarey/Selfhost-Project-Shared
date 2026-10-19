import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, loadEnv, type Plugin } from "vite";
import type { ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Read a key from .env.local without dotenv `$` interpolation. */
function readEnvLocalKey(envDir: string, key: string): string {
  try {
    const text = fs.readFileSync(path.join(envDir, ".env.local"), "utf8");
    const prefix = `${key}=`;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith(prefix)) continue;
      let value = line.slice(prefix.length);
      if (
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))
      ) {
        value = value.slice(1, -1);
      }
      return value.trim();
    }
  } catch {
    // missing .env.local is fine
  }
  return "";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Dev-only endpoint: POST /splunk/search
 * Diagnostic proxy. Production Splunk ETL is GitHub Actions (data/splunk-activity.csv).
 * Uses SPLUNK_TOKEN from web/.env.local. Never expose to the browser or Harbor.
 */
function splunkSearchPlugin(envDir: string): Plugin {
  return {
    name: "splunk-search-proxy",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/splunk/search")) {
          next();
          return;
        }

        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }

        if (req.method !== "POST" && req.method !== "GET") {
          sendJson(res, 405, { error: "Use GET or POST /splunk/search" });
          return;
        }

        const baseUrl = (
          process.env.SPLUNK_BASE_URL ||
          readEnvLocalKey(envDir, "SPLUNK_BASE_URL") ||
          ""
        ).replace(/\/$/, "");
        const token =
          process.env.SPLUNK_TOKEN || readEnvLocalKey(envDir, "SPLUNK_TOKEN") || "";

        // Prefer multi-line SPL file (dashboard searches are usually many lines).
        const searchFileRel =
          process.env.SPLUNK_SEARCH_FILE ||
          readEnvLocalKey(envDir, "SPLUNK_SEARCH_FILE") ||
          "splunk-search.spl";
        const searchFilePath = path.isAbsolute(searchFileRel)
          ? searchFileRel
          : path.join(envDir, searchFileRel);
        let search = "";
        try {
          if (fs.existsSync(searchFilePath)) {
            // Drop blank lines and # comment lines (template notes), keep real SPL.
            search = fs
              .readFileSync(searchFilePath, "utf8")
              .split(/\r?\n/)
              .filter((line) => {
                const t = line.trim();
                return t.length > 0 && !t.startsWith("#");
              })
              .join("\n")
              .trim();
          }
        } catch {
          // fall through to env one-liner
        }
        if (!search) {
          search =
            process.env.SPLUNK_SEARCH || readEnvLocalKey(envDir, "SPLUNK_SEARCH") || "";
        }

        // Allow override in POST body: { "search": "..." }
        if (req.method === "POST") {
          try {
            const raw = await readBody(req);
            if (raw) {
              const parsed = JSON.parse(raw) as { search?: string };
              if (parsed.search?.trim()) search = parsed.search.trim();
            }
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
        }

        if (!baseUrl) {
          sendJson(res, 500, {
            error: "Missing SPLUNK_BASE_URL in .env.local (restart Vite after setting).",
          });
          return;
        }
        if (!token) {
          sendJson(res, 500, {
            error: "Missing SPLUNK_TOKEN in .env.local (restart Vite after setting).",
          });
          return;
        }
        if (!search) {
          sendJson(res, 500, {
            error:
              "Missing Splunk search. Paste the dashboard SPL into web/splunk-search.spl (multi-line OK), then restart Vite.",
          });
          return;
        }

        // Splunk requires a leading "search" for non-generating commands.
        const searchQuery = /^\s*\|/.test(search) || /^\s*search\s/i.test(search)
          ? search
          : `search ${search}`;

        const authStylePref = (
          process.env.SPLUNK_AUTH_STYLE ||
          readEnvLocalKey(envDir, "SPLUNK_AUTH_STYLE") ||
          "auto"
        ).trim();
        const exportPathPref = (
          process.env.SPLUNK_EXPORT_PATH ||
          readEnvLocalKey(envDir, "SPLUNK_EXPORT_PATH") ||
          ""
        ).trim();

        // UI hosts often need the splunkd __raw path; management API uses /services/...
        const exportPaths = exportPathPref
          ? [exportPathPref]
          : [
              "/en-US/splunkd/__raw/services/search/jobs/export",
              "/services/search/jobs/export",
            ];
        const authStyles =
          authStylePref.toLowerCase() === "auto"
            ? ["Bearer", "Splunk"]
            : [authStylePref];

        const form = new URLSearchParams({
          search: searchQuery,
          output_mode: "json",
          exec_mode: "oneshot",
        });

        try {
          let text = "";
          let upstreamOk = false;
          let lastStatus = 0;
          let lastDetail = "";
          let used = "";

          outer: for (const exportPath of exportPaths) {
            const exportUrl = `${baseUrl}${exportPath.startsWith("/") ? "" : "/"}${exportPath}`;
            for (const style of authStyles) {
              const authHeader =
                style.toLowerCase() === "splunk" ? `Splunk ${token}` : `Bearer ${token}`;
              const upstream = await fetch(exportUrl, {
                method: "POST",
                headers: {
                  Authorization: authHeader,
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: form.toString(),
                redirect: "manual",
              });
              lastStatus = upstream.status;
              const bodyText = await upstream.text();
              lastDetail = bodyText.slice(0, 2000);
              used = `${style} ${exportPath}`;

              // 3xx usually means SSO bounce — wrong host for token REST
              if (upstream.status >= 300 && upstream.status < 400) {
                const loc = upstream.headers.get("location") || "";
                lastDetail = `Redirect ${upstream.status} to ${loc || "(no location)"}. This UI host may require SSO; token REST often needs the search-head / management URL.`;
                continue;
              }
              if (!upstream.ok) continue;

              // SSO bounce pages often return 200 HTML — not search results.
              const looksHtml =
                /^\s*</.test(bodyText) ||
                bodyText.includes("<html") ||
                bodyText.includes("submitForm()");
              if (looksHtml) {
                lastDetail =
                  "Got HTML instead of JSON (SSO/session page). Token REST needs the search-head management URL, not the dashboard UI host.";
                lastStatus = 502;
                continue;
              }

              text = bodyText;
              upstreamOk = true;
              break outer;
            }
          }

          if (!upstreamOk) {
            sendJson(res, lastStatus || 502, {
              error: `Splunk request failed (${lastStatus || "no response"}) via ${used || "no path"}`,
              detail: lastDetail,
            });
            return;
          }

          // export returns NDJSON (one JSON object per line) or a JSON array depending on version
          const rows: Record<string, unknown>[] = [];
          const trimmed = text.trim();
          if (trimmed.startsWith("[")) {
            try {
              const arr = JSON.parse(trimmed) as unknown;
              if (Array.isArray(arr)) {
                for (const item of arr) {
                  if (item && typeof item === "object") {
                    const o = item as Record<string, unknown>;
                    const result = (o.result ?? o) as Record<string, unknown>;
                    rows.push(result);
                  }
                }
              }
            } catch {
              sendJson(res, 502, { error: "Failed to parse Splunk JSON array", detail: trimmed.slice(0, 500) });
              return;
            }
          } else {
            for (const line of trimmed.split(/\r?\n/)) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line) as Record<string, unknown>;
                // Skip preview/metadata lines without results
                if (obj.result && typeof obj.result === "object") {
                  rows.push(obj.result as Record<string, unknown>);
                } else if (obj.host != null || obj.recording_count != null) {
                  rows.push(obj);
                }
              } catch {
                // ignore malformed lines
              }
            }
          }

          sendJson(res, 200, { rows });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 502, { error: "Failed to reach Splunk", detail: message });
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const envDir = process.cwd();
  const env = loadEnv(mode, envDir, "");
  const scriptUrl = (env.VITE_APPS_SCRIPT_URL || "").trim();
  const scriptCookie = readEnvLocalKey(envDir, "APPS_SCRIPT_COOKIE");

  const proxy: Record<string, ProxyOptions> = {};

  // Local Node/SQLite API (see server/). Prefer VITE_LOCAL_API_URL; default localhost:8787.
  const localApi =
    (env.VITE_LOCAL_API_URL || "http://localhost:8787").trim() || "http://localhost:8787";
  try {
    const localTarget = new URL(localApi);
    proxy["/local-api"] = {
      target: localTarget.origin,
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/local-api/, ""),
    };
  } catch {
    // ignore invalid local URL
  }

  if (scriptUrl) {
    try {
      const target = new URL(scriptUrl);
      proxy["/apps-script"] = {
        target: target.origin,
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/apps-script/, target.pathname),
        configure: (proxyServer) => {
          proxyServer.on("proxyReq", (proxyReq) => {
            if (scriptCookie) {
              proxyReq.setHeader("Cookie", scriptCookie);
            }
          });
        },
      };
    } catch {
      // Invalid URL — leave apps-script proxy unset.
    }
  }

  const staticLeaderboard =
    env.VITE_STATIC_LEADERBOARD === "true" || process.env.VITE_STATIC_LEADERBOARD === "true";

  return {
    plugins: [react(), tailwindcss(), splunkSearchPlugin(envDir)],
    // Absolute /assets/* so Harbor can bypass the Lambda 1MB proxy limit.
    // The static site zip uses a relative base so it works on a page slug.
    base: staticLeaderboard ? "./" : "/",
    server: { proxy: Object.keys(proxy).length ? proxy : undefined },
  };
});
