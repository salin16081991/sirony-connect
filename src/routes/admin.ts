import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth-guard.js';
import { revokeAllSessions } from '../lib/session.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Postgres rejects a malformed uuid with an error, which would surface as a
 * 500. A bad id in the URL is a client mistake, so treat it as not-found.
 */
function badId(value: string | undefined): boolean {
  return !value || !UUID.test(value);
}

/** 404 rather than 403 — the panel's existence is not advertised. */
async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { rows } = await pool.query<{ is_admin: boolean }>(
    'SELECT is_admin FROM users WHERE id = $1',
    [request.user!.id],
  );
  if (!rows[0]?.is_admin) {
    await reply.code(404).send({ error: 'not_found' });
  }
}

/** Records an invasive read before it happens, with the operator's reason. */
async function logSensitive(
  adminId: string,
  subjectId: string | null,
  resource: string,
  resourceId: string | null,
  reason: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO sensitive_access_log (admin_id, subject_id, resource, resource_id, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [adminId, subjectId, resource, resourceId, reason],
  );
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireAdmin);

  /* ---------------------------------------------------------- overview -- */

  app.get('/api/admin/overview', async () => {
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*) FROM users WHERE status = 'active')::int   AS "activeUsers",
        (SELECT count(*) FROM users WHERE status = 'paused')::int   AS "pausedUsers",
        (SELECT count(*) FROM users WHERE status = 'deleted')::int  AS "deletedUsers",
        (SELECT count(*) FROM users
          WHERE created_at > now() - interval '7 days')::int        AS "signups7d",
        (SELECT count(*) FROM users
          WHERE created_at > now() - interval '24 hours')::int      AS "signups24h",
        (SELECT count(*) FROM profiles)::int                        AS profiles,
        (SELECT count(*) FROM profiles
          WHERE visibility = 'discoverable')::int                   AS "discoverableProfiles",
        (SELECT count(*) FROM matches WHERE closed_at IS NULL)::int AS "openMatches",
        (SELECT count(*) FROM matches
          WHERE opened_at IS NOT NULL)::int                         AS "openedMatches",
        (SELECT count(*) FROM messages)::int                        AS messages,
        (SELECT count(*) FROM posts WHERE expires_at > now())::int  AS "livePosts",
        (SELECT count(*) FROM media_objects)::int                   AS "mediaObjects",
        (SELECT coalesce(sum(bytes), 0) FROM media_objects)::bigint AS "mediaBytes",
        (SELECT count(*) FROM reports
          WHERE status IN ('open','reviewing'))::int                AS "openReports",
        (SELECT count(*) FROM reports
          WHERE status IN ('open','reviewing') AND priority='urgent')::int AS "urgentReports",
        (SELECT count(*) FROM appeals WHERE status = 'open')::int   AS "openAppeals",
        (SELECT count(*) FROM clubs WHERE archived_at IS NULL)::int AS clubs,
        (SELECT count(*) FROM events
          WHERE cancelled_at IS NULL AND starts_at > now())::int    AS "upcomingEvents",
        (SELECT count(*) FROM sessions
          WHERE revoked_at IS NULL AND expires_at > now())::int     AS "liveSessions"
    `);
    return rows[0];
  });

  /** Daily counts for the last 30 days, zero-filled so charts have no gaps. */
  app.get('/api/admin/metrics', async () => {
    const { rows } = await pool.query(`
      WITH days AS (
        SELECT generate_series(current_date - 29, current_date, '1 day')::date AS day
      )
      SELECT d.day,
             (SELECT count(*) FROM users u
               WHERE u.created_at::date = d.day)::int    AS signups,
             (SELECT count(*) FROM matches m
               WHERE m.created_at::date = d.day)::int    AS matches,
             (SELECT count(*) FROM messages g
               WHERE g.created_at::date = d.day)::int    AS messages,
             (SELECT count(*) FROM reports r
               WHERE r.created_at::date = d.day)::int    AS reports
        FROM days d ORDER BY d.day
    `);
    return { days: rows };
  });

  /* ------------------------------------------------------------- users -- */

  app.get('/api/admin/users', async (request) => {
    const { q, status, limit } = request.query as {
      q?: string;
      status?: string;
      limit?: string;
    };
    const take = Math.min(Number(limit) || 50, 200);

    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.status, u.is_admin AS "isAdmin",
              u.is_moderator AS "isModerator",
              u.suspended_until AS "suspendedUntil",
              u.created_at AS "createdAt",
              extract(year from age(u.date_of_birth))::int AS age,
              (SELECT count(*) FROM profiles p WHERE p.user_id = u.id)::int AS profiles,
              (SELECT count(*) FROM reports r WHERE r.subject_id = u.id)::int AS "reportsAgainst",
              (SELECT string_agg(p.display_name, ', ')
                 FROM profiles p WHERE p.user_id = u.id) AS names
         FROM users u
        WHERE ($1::text IS NULL
               OR u.email ILIKE '%' || $1 || '%'
               OR EXISTS (SELECT 1 FROM profiles p
                           WHERE p.user_id = u.id AND p.display_name ILIKE '%' || $1 || '%'))
          AND ($2::text IS NULL OR u.status = $2)
        ORDER BY u.created_at DESC
        LIMIT $3`,
      [q || null, status || null, take],
    );
    return { users: rows };
  });

  /**
   * Everything about one account except message content, which needs its own
   * reasoned request below.
   */
  app.get('/api/admin/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (badId(id)) return reply.code(404).send({ error: 'not_found' });

    const account = await pool.query(
      `SELECT id, email, status, is_admin AS "isAdmin", is_moderator AS "isModerator",
              suspended_until AS "suspendedUntil", identity_verified_at AS "identityVerifiedAt",
              date_of_birth AS "dateOfBirth", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM users WHERE id = $1`,
      [id],
    );
    if (!account.rowCount) return reply.code(404).send({ error: 'not_found' });

    const [profiles, consents, reportsAgainst, reportsBy, enforcement, matches, sessions, notes, posts] =
      await Promise.all([
        pool.query(
          `SELECT p.id, p.kind, p.display_name AS "displayName", p.headline, p.bio,
                  p.locality, p.interests, p.visibility, p.age_min AS "ageMin",
                  p.age_max AS "ageMax", p.photo_media_id AS "photoMediaId",
                  p.created_at AS "createdAt",
                  COALESCE((SELECT array_agg(m.mode) FROM profile_modes m
                             WHERE m.profile_id = p.id), '{}') AS modes
             FROM profiles p WHERE p.user_id = $1 ORDER BY p.kind`,
          [id],
        ),
        pool.query('SELECT kind, granted, updated_at AS "updatedAt" FROM consents WHERE user_id = $1', [id]),
        pool.query(
          `SELECT id, category, priority, status, created_at AS "createdAt"
             FROM reports WHERE subject_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [id],
        ),
        pool.query(
          `SELECT id, category, status, created_at AS "createdAt"
             FROM reports WHERE reporter_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [id],
        ),
        pool.query(
          `SELECT a.id, a.action, a.rationale, a.created_at AS "createdAt",
                  ap.status AS "appealStatus"
             FROM moderation_actions a
             LEFT JOIN appeals ap ON ap.action_id = a.id
            WHERE a.subject_id = $1 ORDER BY a.created_at DESC`,
          [id],
        ),
        pool.query(
          `SELECT m.id, m.created_at AS "createdAt", m.opened_at AS "openedAt",
                  m.closed_at AS "closedAt", m.secret_mode AS "secretMode",
                  other.display_name AS "withName",
                  (SELECT count(*) FROM messages g WHERE g.match_id = m.id)::int AS messages
             FROM matches m
             JOIN profiles mine ON mine.id IN (m.profile_a_id, m.profile_b_id) AND mine.user_id = $1
             JOIN profiles other ON other.id IN (m.profile_a_id, m.profile_b_id) AND other.id <> mine.id
            ORDER BY m.created_at DESC LIMIT 100`,
          [id],
        ),
        pool.query(
          `SELECT id, created_at AS "createdAt", expires_at AS "expiresAt",
                  revoked_at AS "revokedAt"
             FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [id],
        ),
        pool.query(
          `SELECT n.id, n.body, n.created_at AS "createdAt",
                  (SELECT email FROM users a WHERE a.id = n.author_id) AS author
             FROM admin_notes n WHERE n.user_id = $1 ORDER BY n.created_at DESC`,
          [id],
        ),
        pool.query(
          `SELECT p.id, p.kind, p.caption, p.video_url AS "videoUrl",
                  p.media_id AS "mediaId", p.expires_at AS "expiresAt",
                  p.removed_at AS "removedAt", p.created_at AS "createdAt"
             FROM posts p JOIN profiles pr ON pr.id = p.profile_id
            WHERE pr.user_id = $1 ORDER BY p.created_at DESC LIMIT 50`,
          [id],
        ),
      ]);

    await audit(request.user!.id, 'admin.user_viewed', id);

    return {
      account: account.rows[0],
      profiles: profiles.rows,
      consents: consents.rows,
      reportsAgainst: reportsAgainst.rows,
      reportsBy: reportsBy.rows,
      enforcement: enforcement.rows,
      matches: matches.rows,
      sessions: sessions.rows,
      notes: notes.rows,
      posts: posts.rows,
    };
  });

  app.post(
    '/api/admin/users/:id/action',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action', 'reason'],
          properties: {
            action: {
              type: 'string',
              enum: ['suspend', 'ban', 'reinstate', 'signout', 'grant_moderator',
                     'revoke_moderator', 'grant_admin', 'revoke_admin'],
            },
            reason: { type: 'string', minLength: 5, maxLength: 2000 },
            days: { type: 'integer', minimum: 1, maximum: 365 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { action, reason, days } = request.body as {
        action: string;
        reason: string;
        days?: number;
      };
      const adminId = request.user!.id;
      if (badId(id)) return reply.code(404).send({ error: 'not_found' });

      // An admin cannot quietly act on themselves — the usual way a hostile
      // or mistaken change becomes unrecoverable.
      if (id === adminId && action !== 'signout') {
        return reply.code(403).send({ error: 'cannot_action_self' });
      }

      const exists = await pool.query('SELECT 1 FROM users WHERE id = $1', [id]);
      if (!exists.rowCount) return reply.code(404).send({ error: 'not_found' });

      switch (action) {
        case 'suspend':
          await pool.query(
            `UPDATE users SET status='paused', suspended_until = now() + make_interval(days => $2)
              WHERE id=$1`, [id, days ?? 7]);
          await revokeAllSessions(id);
          break;
        case 'ban':
          await pool.query("UPDATE users SET status='deleted' WHERE id=$1", [id]);
          await pool.query('DELETE FROM profiles WHERE user_id=$1', [id]);
          await revokeAllSessions(id);
          break;
        case 'reinstate':
          await pool.query("UPDATE users SET status='active', suspended_until=NULL WHERE id=$1", [id]);
          break;
        case 'signout':
          await revokeAllSessions(id);
          break;
        case 'grant_moderator':
          await pool.query('UPDATE users SET is_moderator=true WHERE id=$1', [id]); break;
        case 'revoke_moderator':
          await pool.query('UPDATE users SET is_moderator=false WHERE id=$1', [id]); break;
        case 'grant_admin':
          await pool.query('UPDATE users SET is_admin=true WHERE id=$1', [id]); break;
        case 'revoke_admin':
          await pool.query('UPDATE users SET is_admin=false WHERE id=$1', [id]); break;
        default:
          return reply.code(400).send({ error: 'unknown_action' });
      }

      // Privilege changes and enforcement both belong in the permanent record.
      await pool.query(
        `INSERT INTO moderation_actions (moderator_id, subject_id, action, rationale)
         VALUES ($1, $2, $3, $4)`,
        [adminId, id,
         action === 'ban' ? 'banned'
           : action === 'suspend' ? 'suspended'
           : action === 'reinstate' ? 'reinstated'
           : 'no_action',
         `[admin:${action}] ${reason}`],
      );
      await audit(adminId, `admin.${action}`, id, { reason });
      return { ok: true, action };
    },
  );

  app.post(
    '/api/admin/users/:id/notes',
    {
      schema: {
        body: {
          type: 'object',
          required: ['body'],
          properties: { body: { type: 'string', minLength: 1, maxLength: 4000 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { body } = request.body as { body: string };
      if (badId(id)) return reply.code(404).send({ error: 'not_found' });
      const { rows } = await pool.query(
        'INSERT INTO admin_notes (user_id, author_id, body) VALUES ($1, $2, $3) RETURNING id',
        [id, request.user!.id, body],
      );
      return reply.code(201).send({ id: rows[0]!.id });
    },
  );

  /* ---------------------------------------------------- conversations -- */

  /**
   * Private message content. Requires a written reason, which is stored
   * against the operator and the subject before anything is returned.
   *
   * Secret-chat conversations are NOT readable here and never will be: the
   * server stores ciphertext and public keys only, so there is nothing to
   * decrypt with. The response says so explicitly rather than appearing empty.
   */
  app.get('/api/admin/matches/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = request.query as { reason?: string };

    if (badId(id)) return reply.code(404).send({ error: 'not_found' });
    if (!reason || reason.trim().length < 10) {
      return reply.code(400).send({ error: 'reason_required' });
    }

    const context = await pool.query<{ a: string; b: string; secret: boolean }>(
      `SELECT pa.user_id AS a, pb.user_id AS b, m.secret_mode AS secret
         FROM matches m
         JOIN profiles pa ON pa.id = m.profile_a_id
         JOIN profiles pb ON pb.id = m.profile_b_id
        WHERE m.id = $1`,
      [id],
    );
    if (!context.rowCount) return reply.code(404).send({ error: 'not_found' });

    await logSensitive(request.user!.id, context.rows[0]!.a, 'match_messages', id, reason.trim());
    await logSensitive(request.user!.id, context.rows[0]!.b, 'match_messages', id, reason.trim());

    const { rows } = await pool.query(
      `SELECT g.id, g.body, g.created_at AS "createdAt", g.read_at AS "readAt",
              p.display_name AS "senderName"
         FROM messages g JOIN profiles p ON p.id = g.sender_profile_id
        WHERE g.match_id = $1 ORDER BY g.created_at`,
      [id],
    );

    const secretCount = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM secret_messages WHERE match_id = $1',
      [id],
    );

    return {
      messages: rows,
      secretMessagesPresent: secretCount.rows[0]!.n,
      note:
        secretCount.rows[0]!.n > 0
          ? 'This conversation also contains end-to-end encrypted messages. The server holds only ciphertext and public keys, so their contents cannot be shown here or anywhere else.'
          : null,
    };
  });

  /* ----------------------------------------------------------- content -- */

  app.get('/api/admin/content', async (request) => {
    const kind = (request.query as { kind?: string }).kind === 'reel' ? 'reel' : 'story';
    const { rows } = await pool.query(
      `SELECT p.id, p.kind, p.caption, p.video_url AS "videoUrl",
              p.media_id AS "mediaId", p.created_at AS "createdAt",
              p.expires_at AS "expiresAt", p.removed_at AS "removedAt",
              pr.display_name AS "authorName", pr.user_id AS "authorId",
              (SELECT count(*) FROM hearts h WHERE h.post_id = p.id)::int AS hearts
         FROM posts p JOIN profiles pr ON pr.id = p.profile_id
        WHERE p.kind = $1 ORDER BY p.created_at DESC LIMIT 100`,
      [kind],
    );
    return { posts: rows };
  });

  app.post(
    '/api/admin/posts/:id/remove',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 5, maxLength: 1000 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { reason } = request.body as { reason: string };
      if (badId(id)) return reply.code(404).send({ error: 'not_found' });
      const { rowCount } = await pool.query(
        'UPDATE posts SET removed_at = now() WHERE id = $1 AND removed_at IS NULL',
        [id],
      );
      if (!rowCount) return reply.code(404).send({ error: 'not_found' });
      await audit(request.user!.id, 'admin.post_removed', id, { reason });
      return { ok: true };
    },
  );

  app.get('/api/admin/clubs', async () => {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.slug, c.locality, c.archived_at AS "archivedAt",
              c.created_at AS "createdAt",
              (SELECT count(*) FROM club_members m WHERE m.club_id = c.id)::int AS members,
              (SELECT count(*) FROM club_posts p WHERE p.club_id = c.id)::int AS posts
         FROM clubs c ORDER BY c.created_at DESC LIMIT 100`,
    );
    return { clubs: rows };
  });

  app.post('/api/admin/clubs/:id/archive', async (request) => {
    const { id } = request.params as { id: string };
    await pool.query('UPDATE clubs SET archived_at = now() WHERE id = $1', [id]);
    await audit(request.user!.id, 'admin.club_archived', id);
    return { ok: true };
  });

  app.get('/api/admin/events', async () => {
    const { rows } = await pool.query(
      `SELECT e.id, e.title, e.venue, e.locality, e.starts_at AS "startsAt",
              e.capacity, e.cancelled_at AS "cancelledAt",
              (SELECT count(*) FROM event_rsvps r
                WHERE r.event_id = e.id AND r.status='going')::int AS going
         FROM events e ORDER BY e.starts_at DESC LIMIT 100`,
    );
    return { events: rows };
  });

  app.post('/api/admin/events/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    await pool.query('UPDATE events SET cancelled_at = now() WHERE id = $1', [id]);
    await audit(request.user!.id, 'admin.event_cancelled', id);
    return { ok: true };
  });

  /* ------------------------------------------------------------- audit -- */

  app.get('/api/admin/audit', async (request) => {
    const { action, limit } = request.query as { action?: string; limit?: string };
    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.subject, a.metadata, a.created_at AS "createdAt",
              (SELECT email FROM users u WHERE u.id = a.actor_id) AS actor
         FROM audit_events a
        WHERE ($1::text IS NULL OR a.action ILIKE '%' || $1 || '%')
        ORDER BY a.created_at DESC LIMIT $2`,
      [action || null, Math.min(Number(limit) || 100, 500)],
    );
    return { events: rows };
  });

  /** Who looked at what, and why. Reviewable by any admin, including on oneself. */
  app.get('/api/admin/sensitive-access', async (request) => {
    const { rows } = await pool.query(
      `SELECT s.id, s.resource, s.resource_id AS "resourceId", s.reason,
              s.created_at AS "createdAt",
              (SELECT email FROM users u WHERE u.id = s.admin_id) AS admin,
              (SELECT email FROM users u WHERE u.id = s.subject_id) AS subject
         FROM sensitive_access_log s
        ORDER BY s.created_at DESC LIMIT $1`,
      [Math.min(Number((request.query as { limit?: string }).limit) || 100, 500)],
    );
    return { access: rows };
  });
}

/** Tells the PWA whether to show the admin tab. Safe for any signed-in user. */
export async function whoamiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/me/roles', async (request) => {
    const { rows } = await pool.query<{ is_admin: boolean; is_moderator: boolean }>(
      'SELECT is_admin, is_moderator FROM users WHERE id = $1',
      [request.user!.id],
    );
    return {
      isAdmin: rows[0]?.is_admin ?? false,
      isModerator: rows[0]?.is_moderator ?? false,
    };
  });
}
