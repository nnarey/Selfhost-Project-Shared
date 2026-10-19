import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ENV } from "./env.js";
import { audit, getDb, nowISO } from "./db.js";
import { loginParticipant } from "./auth.js";

const MAX_BYTES = 2 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function avatarsDir(): string {
  return path.join(path.dirname(ENV.databasePath), "avatars");
}

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUrl.trim());
  if (!m) throw new Error("photoDataUrl must be a base64 data URL (image/*)");
  const mime = m[1].toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error("Unsupported image type (use jpeg, png, webp, or gif)");
  const buffer = Buffer.from(m[2], "base64");
  if (!buffer.length) throw new Error("Empty image");
  if (buffer.length > MAX_BYTES) throw new Error("Image too large (max 2MB)");
  return { mime, buffer };
}

/** Save avatar file and set participants.photo_url to /api/avatars/<file>. */
export async function updateParticipantPhoto(
  email: string,
  password: string,
  photoDataUrl: string,
  alreadyAuthed?: { email: string },
): Promise<{ email: string; photoUrl: string }> {
  const session = alreadyAuthed ?? (await loginParticipant(email, password));
  const { mime, buffer } = parseDataUrl(photoDataUrl);
  const ext = MIME_EXT[mime]!;
  const hash = createHash("sha256").update(session.email).digest("hex").slice(0, 24);
  const filename = `${hash}.${ext}`;
  const dir = avatarsDir();
  fs.mkdirSync(dir, { recursive: true });

  // Remove prior extensions for this hash
  for (const prev of fs.readdirSync(dir)) {
    if (prev.startsWith(`${hash}.`)) {
      try {
        fs.unlinkSync(path.join(dir, prev));
      } catch {
        // ignore
      }
    }
  }
  fs.writeFileSync(path.join(dir, filename), buffer);

  const photoUrl = `/api/avatars/${filename}`;
  const now = nowISO();
  getDb()
    .prepare(`UPDATE participants SET photo_url = ?, updated_at = ? WHERE lower(email) = lower(?)`)
    .run(photoUrl, now, session.email);

  audit(session.email, "participant.photo_update", {
    entityType: "participant",
    entityId: session.email,
    newValue: { photoUrl, bytes: buffer.length },
  });

  return { email: session.email, photoUrl };
}

export function resolveAvatarFile(name: string): string | null {
  if (!/^[a-f0-9]{16,64}\.(jpg|jpeg|png|webp|gif)$/i.test(name)) return null;
  const full = path.join(avatarsDir(), name);
  if (!fs.existsSync(full)) return null;
  return full;
}
