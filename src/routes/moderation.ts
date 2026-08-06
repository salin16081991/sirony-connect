import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth-guard.js';
import { revokeAllSessions } from '../lib/session.js';

const ACTIONS = [
  'no_action',
  'warning',
  'content_removed',
  'suspended',
  'banned',
  'reinstated',
] as const;

/** Moderator gate. Deliberately returns 404, not 403 — the console's
 *  existence is not something an ordinary account needs to learn about. */
async function requireModerator(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { rows } = await pool.query<{ is_moderator: boolean }>(
    'SELECT is_moderator FROM users WHERE id = $1',
    [request.user!.id],
  );
  if (!rows[0]?.is_moderator) {
    await reply.code(404).send({ error: 'not_found' });
  }
}

export async function moderationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireModerator);

  /**
   * Triage queue. Urgent first, then oldest — so credible threats, suspected
   * minors and non-consensual imagery cannot be buried by volume (PRD §8).
   */
  app.get('/api/moderation/queue', async (request) => {
    const { rows } = await pool.query(
      `SELECT r.id, r.category, r.details, r.priority, r.status,
              r.created_at AS "createdAt",
              r.match_id AS "matchId",
              (SELECT count(*) FROM report_evidence e
                WHERE e.report_id = r.id)::int AS "evidenceCount",
              r.claimed_by AS "claimedBy",
              r.subject_id AS "subjectId",
              su.status AS "subjectStatus",
              su.suspended_until AS "subjectSuspendedUntil",
              (SELECT count(*) FROM reports r2
                WHERE r2.subject_id = r.subject_id)::int AS "reportsAgainstSubject",
              (SELECT array_agg(p.display_name) FROM profiles p
                WHERE p.user_id = r.subject_id) AS "subjectNames"
         FROM reports r
         JOIN users su ON su.id = r.subject_id
        WHERE r.status IN ('open', 'reviewing')
        ORDER BY (r.priority = 'urgent') DESC, r.created_at ASC
        LIMIT 100`,
    );
    const counts = await pool.query<{ priority: string; n: number }>(
      `SELECT priority, count(*)::int AS n FROM reports
        WHERE status IN ('open','reviewing') GROUP BY priority`,
    );
    return {
      queue: rows,
      urgent: counts.rows.find((r) => r.priority === 'urgent')?.n ?? 0,
      standard: counts.rows.find((r) => r.priority === 'standard')?.n ?? 0,
    };
  });

  /** Claiming prevents two moderators acting on the same report. */
  app.post('/api/moderation/reports/:id/claim', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { rowCount } = await pool.query(
      `UPDATE reports SET claimed_by = $1, claimed_at = now(), status = 'reviewing'
        WHERE id = $2 AND (claimed_by IS NULL OR claimed_by = $1) AND status = 'open'`,
      [request.user!.id, id],
    );
    if (!rowCount) return reply.code(409).send({ error: 'already_claimed' });
    await audit(request.user!.id, 'moderation.claimed', id);
    return { ok: true };
  });

  /**
   * Record a decision. Every outcome — including no_action — is written with
   * a rationale, so enforcement is explainable and appealable.
   */
  app.post(
    '/api/moderation/reports/:id/decide',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action', 'rationale'],
          properties: {
            action: { type: 'string', enum: [...ACTIONS] },
            rationale: { type: 'string', minLength: 10, maxLength: 2000 },
            suspendDays: { type: 'integer', minimum: 1, maximum: 365 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { action, rationale, suspendDays } = request.body as {
        action: string;
        rationale: string;
        suspendDays?: number;
      };
      const moderatorId = request.user!.id;

      const { rows } = await pool.query<{ subject_id: string }>(
        'SELECT subject_id FROM reports WHERE id = $1',
        [id],
      );
      const subjectId = rows[0]?.subject_id;
      if (!subjectId) return reply.code(404).send({ error: 'not_found' });
      if (subjectId === moderatorId) {
        return reply.code(403).send({ error: 'cannot_action_self' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const action_ = await client.query<{ id: string }>(
          `INSERT INTO moderation_actions
             (report_id, moderator_id, subject_id, action, rationale)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [id, moderatorId, subjectId, action, rationale],
        );

        if (action === 'banned') {
          await client.query("UPDATE users SET status = 'deleted' WHERE id = $1", [subjectId]);
          await client.query('DELETE FROM profiles WHERE user_id = $1', [subjectId]);
        } else if (action === 'suspended') {
          await client.query(
            `UPDATE users SET status = 'paused',
                    suspended_until = now() + make_interval(days => $2)
              WHERE id = $1`,
            [subjectId, suspendDays ?? 7],
          );
        } else if (action === 'reinstated') {
          await client.query(
            "UPDATE users SET status = 'active', suspended_until = NULL WHERE id = $1",
            [subjectId],
          );
        }

        await client.query(
          `UPDATE reports SET status = $2, resolved_at = now() WHERE id = $1`,
          [id, action === 'no_action' ? 'dismissed' : 'actioned'],
        );

        await client.query('COMMIT');

        // Enforcement must end the subject's sessions immediately.
        if (action === 'banned' || action === 'suspended') {
          await revokeAllSessions(subjectId);
        }

        await audit(moderatorId, `moderation.${action}`, subjectId, { reportId: id });
        return reply.code(201).send({ actionId: action_.rows[0]!.id, action });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  );

  /**
   * The conversation as it stood when the report was filed.
   *
   * This is the evidence a suspension rests on, so reading it is reason-gated
   * and written to sensitive_access_log — the same treatment as reading a
   * live conversation, because it is the same data.
   */
  app.get('/api/moderation/reports/:id/evidence', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = request.query as { reason?: string };

    if (!reason || reason.trim().length < 10) {
      return reply.code(400).send({ error: 'reason_required' });
    }

    const report = await pool.query<{ subject_id: string; reporter_id: string | null }>(
      'SELECT subject_id, reporter_id FROM reports WHERE id = $1',
      [id],
    );
    if (!report.rowCount) return reply.code(404).send({ error: 'not_found' });

    for (const subject of [report.rows[0]!.subject_id, report.rows[0]!.reporter_id]) {
      if (!subject) continue;
      await pool.query(
        `INSERT INTO sensitive_access_log (admin_id, subject_id, resource, resource_id, reason)
         VALUES ($1, $2, 'report_evidence', $3, $4)`,
        [request.user!.id, subject, id, reason.trim()],
      );
    }

    const { rows } = await pool.query(
      `SELECT sender_name AS "senderName", sender_is_subject AS "senderIsSubject",
              body, sent_at AS "sentAt", captured_at AS "capturedAt"
         FROM report_evidence WHERE report_id = $1 ORDER BY sent_at`,
      [id],
    );

    return {
      messages: rows,
      capturedAt: rows[0]?.capturedAt ?? null,
      note: rows.length
        ? 'Captured when the report was filed. The originals may since have been deleted by the conversation\'s retention setting.'
        : 'No conversation was attached to this report.',
    };
  });

  app.get('/api/moderation/subjects/:id/history', async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.rationale, a.created_at AS "createdAt",
              ap.status AS "appealStatus", ap.statement AS "appealStatement"
         FROM moderation_actions a
         LEFT JOIN appeals ap ON ap.action_id = a.id
        WHERE a.subject_id = $1 ORDER BY a.created_at DESC`,
      [id],
    );
    return { history: rows };
  });

  app.get('/api/moderation/appeals', async () => {
    const { rows } = await pool.query(
      `SELECT ap.id, ap.statement, ap.created_at AS "createdAt",
              a.action, a.rationale, a.subject_id AS "subjectId"
         FROM appeals ap
         JOIN moderation_actions a ON a.id = ap.action_id
        WHERE ap.status = 'open' ORDER BY ap.created_at ASC`,
    );
    return { appeals: rows };
  });

  app.post(
    '/api/moderation/appeals/:id/resolve',
    {
      schema: {
        body: {
          type: 'object',
          required: ['outcome'],
          properties: { outcome: { type: 'string', enum: ['upheld', 'overturned'] } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { outcome } = request.body as { outcome: string };

      const { rows } = await pool.query<{ user_id: string }>(
        `UPDATE appeals SET status = $2, reviewed_by = $3
          WHERE id = $1 AND status = 'open' RETURNING user_id`,
        [id, outcome, request.user!.id],
      );
      if (!rows.length) return reply.code(404).send({ error: 'not_found' });

      if (outcome === 'overturned') {
        await pool.query(
          "UPDATE users SET status = 'active', suspended_until = NULL WHERE id = $1",
          [rows[0]!.user_id],
        );
      }
      await audit(request.user!.id, `appeal.${outcome}`, rows[0]!.user_id);
      return { outcome };
    },
  );
}

/** Appeal submission belongs to ordinary users, so it lives outside the gate. */
export async function appealRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/enforcement', async (request) => {
    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.rationale, a.created_at AS "createdAt",
              ap.status AS "appealStatus"
         FROM moderation_actions a
         LEFT JOIN appeals ap ON ap.action_id = a.id
        WHERE a.subject_id = $1 AND a.action <> 'no_action'
        ORDER BY a.created_at DESC`,
      [request.user!.id],
    );
    return { actions: rows };
  });

  app.post(
    '/api/enforcement/:actionId/appeal',
    {
      schema: {
        body: {
          type: 'object',
          required: ['statement'],
          properties: { statement: { type: 'string', minLength: 10, maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      const { actionId } = request.params as { actionId: string };
      const { statement } = request.body as { statement: string };

      const owned = await pool.query(
        'SELECT 1 FROM moderation_actions WHERE id = $1 AND subject_id = $2',
        [actionId, request.user!.id],
      );
      if (!owned.rowCount) return reply.code(404).send({ error: 'not_found' });

      try {
        await pool.query(
          'INSERT INTO appeals (action_id, user_id, statement) VALUES ($1, $2, $3)',
          [actionId, request.user!.id, statement],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          return reply.code(409).send({ error: 'already_appealed' });
        }
        throw error;
      }
      await audit(request.user!.id, 'appeal.filed', actionId);
      return reply.code(201).send({ ok: true });
    },
  );
}
