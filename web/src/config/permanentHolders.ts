/** Keep in sync with server/src/config/permanentHolders.ts */
export const PERMANENT_HOLDER_EMAILS = new Set(
  [
    "alice@northline.example",
    "bob@northline.example",
    "cara@northline.example",
    "devon@northline.example",
    "elena@northline.example",
    "frank@northline.example",
    "grace@northline.example",
    "hank@northline.example",
  ].map((e) => e.toLowerCase()),
);

export function isPermanentHolderEmail(email: string | null | undefined): boolean {
  return PERMANENT_HOLDER_EMAILS.has(String(email || "").trim().toLowerCase());
}

export type LeaderboardTrack = "permanent" | "checkout" | "overall";
