const SIZES = {
  sm: "h-7 w-7 text-[11px]",
  md: "h-9 w-9 text-xs",
  lg: "h-14 w-14 text-sm",
  /** Leaderboard / signage-friendly */
  xl: "h-16 w-16 overflow-hidden text-base",
} as const;

const EMOJI_TEXT = {
  sm: "text-sm",
  md: "text-lg",
  lg: "text-3xl",
  /** Nearly fills the xl circle */
  xl: "text-[3.35rem] scale-[1.15]",
} as const;

/** Deterministic silly defaults when someone has not uploaded a photo. */
const SILLY_EMOJIS = [
  "🥸",
  "🤡",
  "👻",
  "🤖",
  "👽",
  "🐸",
  "🦊",
  "🐼",
  "🦄",
  "🍕",
  "🌮",
  "🍩",
  "🍿",
  "🦞",
  "🐙",
  "🦥",
  "🦦",
  "🦜",
  "🦔",
  "🦖",
  "🌵",
  "🍄",
  "🪩",
  "🎩",
  "🧦",
  "🍌",
  "🥥",
  "🫐",
  "🫠",
  "🫢",
  "🫣",
  "🫡",
  "🧙",
  "🧛",
  "🧟",
  "🦸",
  "🦹",
  "🥷",
  "🐿️",
  "🦫",
] as const;

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function sillyEmojiFor(seed: string): string {
  const key = seed.trim().toLowerCase() || "?";
  return SILLY_EMOJIS[hashSeed(key) % SILLY_EMOJIS.length]!;
}

export function ParticipantAvatar({
  name,
  photoUrl,
  seed,
  size = "sm",
}: {
  name: string;
  photoUrl?: string;
  /** Stable id (email / emailHash). Falls back to name. */
  seed?: string;
  size?: keyof typeof SIZES;
}) {
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt=""
        className={`${SIZES[size]} shrink-0 rounded-full object-cover border border-[var(--color-border)]`}
      />
    );
  }
  const emoji = sillyEmojiFor(seed || name);
  return (
    <span
      className={`inline-flex ${SIZES[size]} shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border-soft)] ${EMOJI_TEXT[size]} leading-none`}
      role="img"
      aria-label={`${name || "Participant"} avatar`}
    >
      {emoji}
    </span>
  );
}

/** Name with profile photo (or silly emoji fallback) beside it. */
export default function ParticipantName({
  name,
  photoUrl,
  seed,
  size = "sm",
  className = "",
  nameClassName = "font-medium text-[var(--color-text)]",
}: {
  name: string;
  photoUrl?: string;
  seed?: string;
  size?: keyof typeof SIZES;
  className?: string;
  nameClassName?: string;
}) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
      <ParticipantAvatar name={name} photoUrl={photoUrl} seed={seed} size={size} />
      <span className={`truncate ${nameClassName}`}>{name}</span>
    </span>
  );
}
