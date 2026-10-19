/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADMIN_PASSWORD?: string;
  readonly VITE_APPS_SCRIPT_URL?: string;
  /** Local Node/SQLite API base URL, e.g. http://localhost:8787 */
  readonly VITE_LOCAL_API_URL?: string;
  /** When true, Harbor hides checkout devices and the checkout leaderboard. */
  readonly VITE_HARBOR_PERMANENT_ONLY?: string;
  /** Static Static page: baked leaderboard, no API. */
  readonly VITE_STATIC_LEADERBOARD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
