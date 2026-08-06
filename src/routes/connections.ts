import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth-guard.js';

const REPORT_CATEGORIES = [
  'harassment',
  'threats',
  'scam',
  'impersonation',
  'non_consensual_imagery',
  'underage',
  'other',
] as const;

/** Categories that jump the moderation queue (PRD §8). */
const URGENT = new Set(['threats', 'non_consensual_imagery', 'underage']);

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /**
   * Express interest. A match is created only when interest is mutual —
   * there is no way to open a conversation without it (PRD §4).
   */
  app.post(
    '/api/likes',
    {
      schema: {
        body: {
          type: 'object',
          required: ['fromProfileId', 'toProfileId'],
          properties: {
            fromProfileId: { type: 'string', format: 'uuid' },
            toProfileId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const { fromProfileId, toProfileId } = request.body as {
        fromProfileId: string;
        toProfileId: string;
      };
      const userId = request.user!.id;

      if (fromProfileId === toProfileId) {
        return reply.code(400).send({ error: 'cannot_like_self' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const owned = await client.query(
          'SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2',
          [fromProfileId, userId],
        );
        if (!owned.rowCount) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'not_found' });
        }

        // A block in either direction makes the target invisible, and the
        // response is identical to "not found" so blocks are not detectable.
        const target = await client.query<{ user_id: string }>(
          `SELECT p.user_id FROM profiles p
             JOIN users u ON u.id = p.user_id
            WHERE p.id = $1
              AND u.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM blocks b
                 WHERE (b.blocker_id = $2 AND b.blocked_id = p.user_id)
                    OR (b.blocker_id = p.user_id AND b.blocked_id = $2)
              )`,
          [toProfileId, userId],
        );
        if (!target.rowCount) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'not_found' });
        }

        await client.query(
          `INSERT INTO likes (from_profile_id, to_profile_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [fromProfileId, toProfileId],
        );
        await client.query(
          `UPDATE introductions SET acted_at = now()
            WHERE profile_id = $1 AND candidate_id = $2 AND acted_at IS NULL`,
          [fromProfileId, toProfileId],
        );

        const reciprocal = await client.query(
          'SELECT 1 FROM likes WHERE from_profile_id = $1 AND to_profile_id = $2',
          [toProfileId, fromProfileId],
        );

        let matched = false;
        if (reciprocal.rowCount) {
          // The CHECK constraint keeps one row per pair, so order the ids.
          const [a, b] = [fromProfileId, toProfileId].sort();
          // The reciprocal like already existed, so the *current* actor is the
          // one who was pursued first. They hold the opening move.
          await client.query(
            `INSERT INTO matches
               (profile_a_id, profile_b_id, first_move_profile_id, expires_at)
             VALUES ($1, $2, $3, now() + interval '24 hours')
             ON CONFLICT DO NOTHING`,
            [a, b, fromProfileId],
          );
          matched = true;
        }

        await client.query('COMMIT');
        if (matched) await audit(userId, 'match.created', toProfileId);
        return { matched };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  );

  /** Decline an introduction — recorded so it is not offered again. */
  app.post('/api/introductions/:candidateId/pass', async (request, reply) => {
    const { candidateId } = request.params as { candidateId: string };
    const { rowCount } = await pool.query(
      `UPDATE introductions i SET acted_at = now()
         FROM profiles p
        WHERE i.profile_id = p.id
          AND p.user_id = $1
          AND i.candidate_id = $2
          AND i.acted_at IS NULL`,
      [request.user!.id, candidateId],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  /**
   * Undo the most recent pass, Bumble's Backtrack. Bounded to five minutes so
   * it stays a correction for a mis-tap rather than a way to re-browse people
   * who were already declined.
   */
  app.post('/api/introductions/backtrack', async (request, reply) => {
    const { rows } = await pool.query<{ candidate_id: string; display_name: string }>(
      `UPDATE introductions i
          SET acted_at = NULL
         FROM profiles p, profiles c
        WHERE i.profile_id = p.id
          AND p.user_id = $1
          AND c.id = i.candidate_id
          AND i.acted_at = (
            SELECT max(i2.acted_at) FROM introductions i2
              JOIN profiles p2 ON p2.id = i2.profile_id
             WHERE p2.user_id = $1
               AND i2.acted_at > now() - interval '5 minutes'
               -- A pass can be undone; a like cannot, since the other person
               -- may already have been shown the interest.
               AND NOT EXISTS (
                 SELECT 1 FROM likes l
                  WHERE l.from_profile_id = i2.profile_id
                    AND l.to_profile_id = i2.candidate_id
               )
          )
        RETURNING i.candidate_id, c.display_name`,
      [request.user!.id],
    );
    if (!rows.length) return reply.code(404).send({ error: 'nothing_to_undo' });
    return { restored: rows[0]!.display_name };
  });

  app.get('/api/matches', async (request) => {
    const { rows } = await pool.query(
      `SELECT m.id,
              m.created_at AS "createdAt",
              m.expires_at AS "expiresAt",
              m.opened_at  AS "openedAt",
              (m.opened_at IS NULL AND m.expires_at < now()) AS expired,
              (m.first_move_profile_id = mine.id) AS "myOpeningMove",
              (m.opened_at IS NULL AND m.extended_at IS NULL) AS "canExtend",
              (SELECT count(*) FROM messages msg WHERE msg.match_id = m.id)::int AS "messageCount",
              other.id AS "profileId",
              other.display_name AS "displayName",
              other.headline,
              other.locality,
              mine.kind
         FROM matches m
         JOIN profiles mine
           ON mine.id IN (m.profile_a_id, m.profile_b_id) AND mine.user_id = $1
         JOIN profiles other
           ON other.id IN (m.profile_a_id, m.profile_b_id) AND other.id <> mine.id
         JOIN users ou ON ou.id = other.user_id AND ou.status = 'active'
        WHERE m.closed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $1 AND b.blocked_id = other.user_id)
                OR (b.blocker_id = other.user_id AND b.blocked_id = $1)
          )
        ORDER BY m.created_at DESC`,
      [request.user!.id],
    );
    return { matches: rows };
  });

  /**
   * Blocking is per-user and immediate: it closes any match, removes the
   * likes in both directions, and hides every profile that user has.
   */
  app.post(
    '/api/blocks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['profileId'],
          properties: { profileId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const { profileId } = request.body as { profileId: string };
      const userId = request.user!.id;

      const { rows } = await pool.query<{ user_id: string }>(
        'SELECT user_id FROM profiles WHERE id = $1',
        [profileId],
      );
      const targetUserId = rows[0]?.user_id;
      if (!targetUserId) return reply.code(404).send({ error: 'not_found' });
      if (targetUserId === userId) return reply.code(400).send({ error: 'cannot_block_self' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [userId, targetUserId],
        );
        await client.query(
          `UPDATE matches SET closed_at = now()
            WHERE closed_at IS NULL
              AND profile_a_id IN (SELECT id FROM profiles WHERE user_id IN ($1, $2))
              AND profile_b_id IN (SELECT id FROM profiles WHERE user_id IN ($1, $2))`,
          [userId, targetUserId],
        );
        await client.query(
          `DELETE FROM likes
            WHERE (from_profile_id IN (SELECT id FROM profiles WHERE user_id = $1)
                   AND to_profile_id IN (SELECT id FROM profiles WHERE user_id = $2))
               OR (from_profile_id IN (SELECT id FROM profiles WHERE user_id = $2)
                   AND to_profile_id IN (SELECT id FROM profiles WHERE user_id = $1))`,
          [userId, targetUserId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      await audit(userId, 'user.blocked', targetUserId);
      return { ok: true };
    },
  );

  app.delete('/api/blocks/:userId', async (request) => {
    const { userId: blockedId } = request.params as { userId: string };
    await pool.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [
      request.user!.id,
      blockedId,
    ]);
    await audit(request.user!.id, 'user.unblocked', blockedId);
    return { ok: true };
  });

  app.post(
    '/api/reports',
    {
      schema: {
        body: {
          type: 'object',
          required: ['profileId', 'category'],
          properties: {
            profileId: { type: 'string', format: 'uuid' },
            category: { type: 'string', enum: [...REPORT_CATEGORIES] },
            details: { type: 'string', maxLength: 4000 },
            alsoBlock: { type: 'boolean' },
            // Reporting from a conversation preserves it as evidence.
            matchId: { type: 'string', format: 'uuid' },
          },
        },
      },
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const { profileId, category, details, matchId } = request.body as {
        profileId: string;
        category: string;
        details?: string;
        matchId?: string;
      };
      const userId = request.user!.id;

      const { rows } = await pool.query<{ user_id: string }>(
        'SELECT user_id FROM profiles WHERE id = $1',
        [profileId],
      );
      const subjectId = rows[0]?.user_id;
      if (!subjectId) return reply.code(404).send({ error: 'not_found' });

      const priority = URGENT.has(category) ? 'urgent' : 'standard';
      const client = await pool.connect();
      let evidenceCount = 0;

      try {
        await client.query('BEGIN');

        // Only accept a match the reporter is actually in — otherwise a report
        // would be a way to snapshot other people's conversations.
        let linkedMatch: string | null = null;
        if (matchId) {
          const owned = await client.query(
            `SELECT 1 FROM matches m
               JOIN profiles p ON p.id IN (m.profile_a_id, m.profile_b_id)
              WHERE m.id = $1 AND p.user_id = $2`,
            [matchId, userId],
          );
          if (owned.rowCount) linkedMatch = matchId;
        }

        const report = await client.query<{ id: string }>(
          `INSERT INTO reports (reporter_id, subject_id, category, details, priority, match_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [userId, subjectId, category, details ?? null, priority, linkedMatch],
        );

        if (linkedMatch) {
          // Snapshot now: these messages may be deleted by their retention
          // setting long before a moderator opens the report.
          const captured = await client.query(
            `INSERT INTO report_evidence
               (report_id, sender_name, sender_is_subject, body, sent_at)
             SELECT $1, p.display_name, (p.user_id = $3), g.body, g.created_at
               FROM messages g
               JOIN profiles p ON p.id = g.sender_profile_id
              WHERE g.match_id = $2
              ORDER BY g.created_at
              LIMIT 200`,
            [report.rows[0]!.id, linkedMatch, subjectId],
          );
          evidenceCount = captured.rowCount ?? 0;
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      // The audit trail records that a report happened, never its contents.
      await audit(userId, 'report.filed', subjectId, { category, evidenceCount });
      return reply.code(201).send({ ok: true, priority, evidenceCaptured: evidenceCount });
    },
  );
}
