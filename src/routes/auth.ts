import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { isProduction } from '../config.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
  SESSION_COOKIE,
  createSession,
  revokeAllSessions,
  revokeSession,
} from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { loadUser, requireAuth } from '../lib/auth-guard.js';

/** Whole years old on the given date. */
export function ageOn(dob: Date, on = new Date()): number {
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = on.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && on.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

const credentials = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', format: 'email', maxLength: 254 },
    password: { type: 'string', minLength: 12, maxLength: 200 },
  },
} as const;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
  };

  app.post(
    '/api/auth/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password', 'dateOfBirth'],
          properties: {
            ...credentials.properties,
            dateOfBirth: { type: 'string', format: 'date' },
          },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const { email, password, dateOfBirth } = request.body as {
        email: string;
        password: string;
        dateOfBirth: string;
      };

      const dob = new Date(`${dateOfBirth}T00:00:00Z`);
      if (Number.isNaN(dob.getTime())) {
        return reply.code(400).send({ error: 'invalid_date_of_birth' });
      }

      // Adult-only enforcement (PRD §3, §8). Refused before any account exists.
      const age = ageOn(dob);
      if (age < 18) {
        await audit(null, 'registration.rejected_underage');
        return reply.code(403).send({ error: 'adults_only' });
      }
      if (age > 120) {
        return reply.code(400).send({ error: 'invalid_date_of_birth' });
      }

      const normalisedEmail = email.trim().toLowerCase();
      const passwordHash = await hashPassword(password);

      try {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, date_of_birth)
           VALUES ($1, $2, $3) RETURNING id`,
          [normalisedEmail, passwordHash, dateOfBirth],
        );
        const userId = rows[0]!.id;

        // Sensitive analysis defaults to off (PRD §6). Rows are created up
        // front so the settings screen always shows an explicit state.
        await pool.query(
          `INSERT INTO consents (user_id, kind, granted)
           SELECT $1, k, false FROM unnest($2::text[]) AS k`,
          [
            userId,
            [
              'ai_profile_assist',
              'ai_chat_analysis',
              'ai_voice_analysis',
              'approximate_location',
              'push_notifications',
              'trusted_contacts',
            ],
          ],
        );

        await audit(userId, 'account.created');
        const { token, expiresAt } = await createSession(userId);
        return reply
          .setCookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt })
          .code(201)
          .send({ id: userId, email: normalisedEmail });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          // Do not confirm which emails exist.
          return reply.code(409).send({ error: 'registration_failed' });
        }
        throw error;
      }
    },
  );

  app.post(
    '/api/auth/login',
    { schema: { body: credentials }, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { email, password } = request.body as { email: string; password: string };
      const { rows } = await pool.query<{ id: string; password_hash: string }>(
        `SELECT id, password_hash FROM users
          WHERE email = $1 AND status = 'active'`,
        [email.trim().toLowerCase()],
      );

      const user = rows[0];
      // Always run a verification so response timing does not reveal whether
      // the account exists.
      const ok = await verifyPassword(
        password,
        user?.password_hash ??
          'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==',
      );

      if (!user || !ok) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }

      const { token, expiresAt } = await createSession(user.id);
      await audit(user.id, 'session.created');
      return reply
        .setCookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt })
        .send({ id: user.id });
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    await revokeSession(request.cookies[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, cookieOptions).send({ ok: true });
  });

  app.get('/api/auth/me', async (request, reply) => {
    await loadUser(request);
    if (!request.user) return reply.code(401).send({ error: 'authentication_required' });
    return { id: request.user.id, email: request.user.email };
  });

  // Account pause (PRD §7) — reversible, and drops every session immediately.
  app.post(
    '/api/auth/pause',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.user!.id;
      await pool.query("UPDATE users SET status = 'paused', updated_at = now() WHERE id = $1", [
        userId,
      ]);
      await revokeAllSessions(userId);
      await audit(userId, 'account.paused');
      return reply.clearCookie(SESSION_COOKIE, cookieOptions).send({ ok: true });
    },
  );

  /**
   * Deletion (PRD §7). Profiles, likes, matches, sessions and consents cascade
   * away. The user row is retained as a tombstone with credentials destroyed,
   * so audit and moderation history stay referentially intact.
   */
  app.delete('/api/auth/account', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    await pool.query(
      `UPDATE users
          SET status = 'deleted',
              email = 'deleted+' || id || '@invalid',
              password_hash = '',
              date_of_birth = '1900-01-01',
              updated_at = now()
        WHERE id = $1`,
      [userId],
    );
    await pool.query('DELETE FROM profiles WHERE user_id = $1', [userId]);
    await revokeAllSessions(userId);
    await audit(userId, 'account.deleted');
    return reply.clearCookie(SESSION_COOKIE, cookieOptions).send({ ok: true });
  });
}
