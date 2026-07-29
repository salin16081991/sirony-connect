import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth-guard.js';

/**
 * A match the caller participates in, with everything needed to decide who may
 * speak. Expiry is evaluated in SQL at read time rather than by a background
 * job, so there is no window where the database disagrees with the UI.
 */
const MATCH_CONTEXT = `
  SELECT m.id,
         m.first_move_profile_id AS "firstMoveProfileId",
         m.expires_at  AS "expiresAt",
         m.opened_at   AS "openedAt",
         m.extended_at AS "extendedAt",
         m.closed_at   AS "closedAt",
         m.message_ttl_seconds AS "messageTtlSeconds",
         mine.id  AS "myProfileId",
         other.id AS "otherProfileId",
         other.display_name AS "otherName",
         (m.opened_at IS NULL AND m.expires_at < now()) AS expired
    FROM matches m
    JOIN profiles mine  ON mine.id IN (m.profile_a_id, m.profile_b_id) AND mine.user_id = $2
    JOIN profiles other ON other.id IN (m.profile_a_id, m.profile_b_id) AND other.id <> mine.id
    JOIN users ou ON ou.id = other.user_id AND ou.status = 'active'
   WHERE m.id = $1
     AND NOT EXISTS (
       SELECT 1 FROM blocks b
        WHERE (b.blocker_id = $2 AND b.blocked_id = other.user_id)
           OR (b.blocker_id = other.user_id AND b.blocked_id = $2)
     )`;

interface MatchContext {
  id: string;
  firstMoveProfileId: string | null;
  expiresAt: string | null;
  openedAt: string | null;
  extendedAt: string | null;
  closedAt: string | null;
  messageTtlSeconds: number | null;
  myProfileId: string;
  otherProfileId: string;
  otherName: string;
  expired: boolean;
}

async function loadMatch(matchId: string, userId: string): Promise<MatchContext | null> {
  const { rows } = await pool.query<MatchContext>(MATCH_CONTEXT, [matchId, userId]);
  return rows[0] ?? null;
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/matches/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;

    const match = await loadMatch(id, userId);
    if (!match || match.closedAt) return reply.code(404).send({ error: 'not_found' });

    // Drop anything past its retention deadline before returning the thread.
    await pool.query(
      'DELETE FROM messages WHERE match_id = $1 AND expires_at IS NOT NULL AND expires_at < now()',
      [id],
    );

    const { rows } = await pool.query(
      `SELECT id, sender_profile_id AS "senderProfileId", body,
              created_at AS "createdAt", expires_at AS "expiresAt"
         FROM messages WHERE match_id = $1 ORDER BY created_at`,
      [id],
    );

    await pool.query(
      `UPDATE messages SET read_at = now()
        WHERE match_id = $1 AND sender_profile_id <> $2 AND read_at IS NULL`,
      [id, match.myProfileId],
    );

    return {
      match: {
        id: match.id,
        otherName: match.otherName,
        expiresAt: match.expiresAt,
        openedAt: match.openedAt,
        expired: match.expired,
        canExtend: !match.openedAt && !match.extendedAt,
        messageTtlSeconds: match.messageTtlSeconds,
        // Only the opening move is restricted; after that either may reply.
        canSend:
          !match.expired &&
          (match.openedAt !== null || match.firstMoveProfileId === match.myProfileId),
        awaitingOther:
          !match.openedAt && match.firstMoveProfileId !== match.myProfileId,
      },
      myProfileId: match.myProfileId,
      messages: rows,
    };
  });

  app.post(
    '/api/matches/:id/messages',
    {
      schema: {
        body: {
          type: 'object',
          required: ['body'],
          properties: { body: { type: 'string', minLength: 1, maxLength: 4000 } },
        },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { body } = request.body as { body: string };
      const userId = request.user!.id;

      const match = await loadMatch(id, userId);
      if (!match || match.closedAt) return reply.code(404).send({ error: 'not_found' });
      if (match.expired) return reply.code(409).send({ error: 'match_expired' });

      // Opening move belongs to one side only. Once opened, both may reply.
      if (!match.openedAt && match.firstMoveProfileId !== match.myProfileId) {
        return reply.code(403).send({ error: 'not_your_opening_move' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO messages (match_id, sender_profile_id, body, expires_at)
           VALUES ($1, $2, $3,
                   CASE WHEN $4::int IS NULL THEN NULL
                        ELSE now() + make_interval(secs => $4::int) END)
           RETURNING id, created_at AS "createdAt", expires_at AS "expiresAt"`,
          [id, match.myProfileId, body, match.messageTtlSeconds],
        );
        // The first message stops the clock permanently.
        await client.query(
          'UPDATE matches SET opened_at = now() WHERE id = $1 AND opened_at IS NULL',
          [id],
        );
        await client.query('COMMIT');
        return reply.code(201).send(rows[0]);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  );

  /** One 24-hour extension, for the side that cannot open yet. */
  app.post('/api/matches/:id/extend', async (request, reply) => {
    const { id } = request.params as { id: string };
    const match = await loadMatch(id, request.user!.id);
    if (!match || match.closedAt) return reply.code(404).send({ error: 'not_found' });
    if (match.openedAt) return reply.code(409).send({ error: 'already_open' });
    if (match.extendedAt) return reply.code(409).send({ error: 'already_extended' });

    const { rows } = await pool.query(
      `UPDATE matches
          SET expires_at = greatest(expires_at, now()) + interval '24 hours',
              extended_at = now()
        WHERE id = $1 RETURNING expires_at AS "expiresAt"`,
      [id],
    );
    await audit(request.user!.id, 'match.extended', id);
    return rows[0];
  });

  /** Per-conversation disappearing messages, agreed openly by both sides. */
  app.put(
    '/api/matches/:id/retention',
    {
      schema: {
        body: {
          type: 'object',
          required: ['ttlSeconds'],
          properties: {
            ttlSeconds: { type: ['integer', 'null'], minimum: 60, maximum: 604800 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { ttlSeconds } = request.body as { ttlSeconds: number | null };
      const match = await loadMatch(id, request.user!.id);
      if (!match || match.closedAt) return reply.code(404).send({ error: 'not_found' });

      await pool.query('UPDATE matches SET message_ttl_seconds = $1 WHERE id = $2', [
        ttlSeconds,
        id,
      ]);
      await audit(request.user!.id, 'match.retention_changed', id, { ttlSeconds });
      return { ttlSeconds };
    },
  );
}
