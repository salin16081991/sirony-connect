import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pool } from '../db.js';

/** Files live on a Docker volume, outside the served static root. */
export const MEDIA_ROOT = process.env['MEDIA_ROOT'] ?? '/data/media';

export const LIMITS = {
  photoBytes: 8 * 1024 * 1024,
  /**
   * Upload ceiling for the whole service. Video is not uploadable at all —
   * moving pictures go to the author's own YouTube channel and only the link
   * is stored — so this is just the photo limit with a little headroom.
   */
  uploadBytes: 8 * 1024 * 1024,
  storyHours: 24,
  reelDays: 30,
} as const;

// Photos only. `media_objects.kind` still permits 'video' so historical rows
// remain valid, but nothing new can be written as one.
const ALLOWED = new Map<string, 'photo'>([
  ['image/jpeg', 'photo'],
  ['image/png', 'photo'],
  ['image/webp', 'photo'],
]);

export function kindForMime(mime: string): 'photo' | null {
  return ALLOWED.get(mime) ?? null;
}

let signingKey: Buffer | null = null;

/**
 * The URL signing key is generated once and stored in the database, so links
 * issued before a restart keep working and every replica agrees.
 */
export async function loadSigningKey(): Promise<void> {
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM app_secrets WHERE name = 'media_signing_key'",
  );
  if (rows[0]) {
    signingKey = Buffer.from(rows[0].value, 'base64');
    return;
  }
  const fresh = randomBytes(32);
  await pool.query(
    `INSERT INTO app_secrets (name, value) VALUES ('media_signing_key', $1)
     ON CONFLICT (name) DO NOTHING`,
    [fresh.toString('base64')],
  );
  const { rows: after } = await pool.query<{ value: string }>(
    "SELECT value FROM app_secrets WHERE name = 'media_signing_key'",
  );
  signingKey = Buffer.from(after[0]!.value, 'base64');
}

/**
 * Short-lived, per-viewer signed token. There are no direct file URLs, so a
 * copied link stops working within minutes and cannot be shared onward
 * usefully (PRD §7).
 */
export function signMediaToken(mediaId: string, viewerId: string, ttlSeconds = 300): string {
  if (!signingKey) throw new Error('signing key not loaded');
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${mediaId}.${viewerId}.${expires}`;
  const mac = createHmac('sha256', signingKey).update(payload).digest('base64url');
  return `${expires}.${mac}`;
}

export function verifyMediaToken(
  mediaId: string,
  viewerId: string,
  token: string,
): boolean {
  if (!signingKey) return false;
  const [expiresRaw, mac] = token.split('.');
  const expires = Number(expiresRaw);
  if (!mac || !Number.isFinite(expires)) return false;
  if (expires < Math.floor(Date.now() / 1000)) return false;

  const expected = createHmac('sha256', signingKey)
    .update(`${mediaId}.${viewerId}.${expires}`)
    .digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function ensureMediaRoot(): Promise<void> {
  await mkdir(MEDIA_ROOT, { recursive: true });
}

export function storagePathFor(id: string): string {
  return join(MEDIA_ROOT, `${id}.bin`);
}

/**
 * Deletes expired and burned media, file and row together. Runs on an
 * interval rather than lazily so retention promises hold even for content
 * nobody opens again.
 */
export async function sweepExpiredMedia(log: (msg: string) => void): Promise<void> {
  const { rows } = await pool.query<{ id: string; storage_path: string }>(
    `DELETE FROM media_objects
      WHERE (expires_at IS NOT NULL AND expires_at < now())
         OR (one_time AND burned_at IS NOT NULL AND burned_at < now() - interval '1 hour')
      RETURNING id, storage_path`,
  );
  for (const row of rows) {
    try {
      await unlink(row.storage_path);
    } catch {
      // Already gone; the row is what matters.
    }
  }
  // Expired posts lose their row too, so feeds cannot resurrect them.
  const posts = await pool.query('DELETE FROM posts WHERE expires_at < now() RETURNING id');

  // Report evidence is a copy of messages users expected to disappear, so it
  // is kept only as long as it could plausibly be needed: 90 days past the
  // decision, which covers the appeal window with room to spare.
  const evidence = await pool.query(
    `DELETE FROM report_evidence e
      USING reports r
      WHERE r.id = e.report_id
        AND r.resolved_at IS NOT NULL
        AND r.resolved_at < now() - interval '90 days'
      RETURNING e.id`,
  );
  if (evidence.rowCount) {
    log(`purged ${evidence.rowCount} evidence rows from settled reports`);
  }
  if (rows.length || posts.rowCount) {
    log(`media sweep removed ${rows.length} files and ${posts.rowCount ?? 0} posts`);
  }
}
