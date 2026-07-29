import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db.js';

export const SESSION_COOKIE = 'aura_session';
const SESSION_TTL_DAYS = 30;

/**
 * Only a hash of the token is persisted, so a database leak cannot be replayed
 * as a live session. The plaintext exists solely in the user's cookie.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await pool.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashToken(token), expiresAt],
  );
  return { token, expiresAt };
}

export interface SessionUser {
  id: string;
  email: string;
  status: string;
}

export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const { rows } = await pool.query<SessionUser>(
    `SELECT u.id, u.email, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await pool.query(
    'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)],
  );
}

/** Used on password change and account pause — drops every device at once. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await pool.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
}
