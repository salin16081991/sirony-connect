import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth-guard.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function communityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /* ------------------------------------------------------------- clubs -- */

  app.get('/api/clubs', async (request) => {
    const { rows } = await pool.query(
      `SELECT c.id, c.slug, c.name, c.description, c.locality,
              (SELECT count(*) FROM club_members m WHERE m.club_id = c.id)::int AS members,
              EXISTS (SELECT 1 FROM club_members m
                       WHERE m.club_id = c.id AND m.user_id = $1) AS joined
         FROM clubs c
        WHERE c.archived_at IS NULL
        ORDER BY members DESC, c.created_at DESC
        LIMIT 100`,
      [request.user!.id],
    );
    return { clubs: rows };
  });

  app.post(
    '/api/clubs',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 60 },
            description: { type: 'string', maxLength: 1000 },
            locality: { type: 'string', maxLength: 80 },
          },
        },
      },
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const { name, description, locality } = request.body as {
        name: string;
        description?: string;
        locality?: string;
      };
      const userId = request.user!.id;
      const slug = slugify(name);
      if (!slug) return reply.code(400).send({ error: 'invalid_name' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO clubs (slug, name, description, locality, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [slug, name, description ?? null, locality ?? null, userId],
        );
        // The creator is the first organiser.
        await client.query(
          "INSERT INTO club_members (club_id, user_id, role) VALUES ($1, $2, 'organiser')",
          [rows[0]!.id, userId],
        );
        await client.query('COMMIT');
        await audit(userId, 'club.created', rows[0]!.id);
        return reply.code(201).send({ id: rows[0]!.id, slug });
      } catch (error) {
        await client.query('ROLLBACK');
        if ((error as { code?: string }).code === '23505') {
          return reply.code(409).send({ error: 'club_exists' });
        }
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post('/api/clubs/:id/join', async (request) => {
    await pool.query(
      'INSERT INTO club_members (club_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [(request.params as { id: string }).id, request.user!.id],
    );
    return { ok: true };
  });

  app.delete('/api/clubs/:id/join', async (request) => {
    await pool.query('DELETE FROM club_members WHERE club_id = $1 AND user_id = $2', [
      (request.params as { id: string }).id,
      request.user!.id,
    ]);
    return { ok: true };
  });

  app.get('/api/clubs/:id/posts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const member = await pool.query(
      'SELECT 1 FROM club_members WHERE club_id = $1 AND user_id = $2',
      [id, request.user!.id],
    );
    // Club conversation is for members. Non-members see the club, not its posts.
    if (!member.rowCount) return reply.code(403).send({ error: 'join_required' });

    const { rows } = await pool.query(
      `SELECT p.id, p.body, p.created_at AS "createdAt",
              pr.display_name AS "authorName", pr.id AS "authorProfileId"
         FROM club_posts p
         JOIN profiles pr ON pr.id = p.profile_id
         JOIN users u ON u.id = pr.user_id AND u.status = 'active'
        WHERE p.club_id = $1
          AND p.removed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $2 AND b.blocked_id = pr.user_id)
                OR (b.blocker_id = pr.user_id AND b.blocked_id = $2)
          )
        ORDER BY p.created_at DESC LIMIT 100`,
      [id, request.user!.id],
    );
    return { posts: rows };
  });

  app.post(
    '/api/clubs/:id/posts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['profileId', 'body'],
          properties: {
            profileId: { type: 'string', format: 'uuid' },
            body: { type: 'string', minLength: 1, maxLength: 4000 },
          },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { profileId, body } = request.body as { profileId: string; body: string };
      const userId = request.user!.id;

      const ok = await pool.query(
        `SELECT 1 FROM club_members m, profiles p
          WHERE m.club_id = $1 AND m.user_id = $2 AND p.id = $3 AND p.user_id = $2`,
        [id, userId, profileId],
      );
      if (!ok.rowCount) return reply.code(403).send({ error: 'join_required' });

      const { rows } = await pool.query(
        'INSERT INTO club_posts (club_id, profile_id, body) VALUES ($1, $2, $3) RETURNING id',
        [id, profileId, body],
      );
      return reply.code(201).send({ id: rows[0]!.id });
    },
  );

  /* ------------------------------------------------------------ events -- */

  app.get('/api/events', async (request) => {
    const { rows } = await pool.query(
      `SELECT e.id, e.title, e.description, e.venue, e.locality,
              e.starts_at AS "startsAt", e.capacity,
              c.name AS "clubName",
              (SELECT count(*) FROM event_rsvps r
                WHERE r.event_id = e.id AND r.status = 'going')::int AS going,
              (SELECT r.status FROM event_rsvps r
                WHERE r.event_id = e.id AND r.user_id = $1) AS "myRsvp"
         FROM events e
         LEFT JOIN clubs c ON c.id = e.club_id
        WHERE e.cancelled_at IS NULL AND e.starts_at > now()
        ORDER BY e.starts_at ASC LIMIT 100`,
      [request.user!.id],
    );
    return { events: rows };
  });

  app.post(
    '/api/events',
    {
      schema: {
        body: {
          type: 'object',
          required: ['title', 'startsAt'],
          properties: {
            title: { type: 'string', minLength: 3, maxLength: 120 },
            description: { type: 'string', maxLength: 2000 },
            venue: { type: 'string', maxLength: 200 },
            locality: { type: 'string', maxLength: 80 },
            startsAt: { type: 'string', format: 'date-time' },
            capacity: { type: 'integer', minimum: 1, maximum: 1000 },
            clubId: { type: 'string', format: 'uuid' },
          },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const b = request.body as Record<string, unknown>;
      if (new Date(b['startsAt'] as string).getTime() < Date.now()) {
        return reply.code(400).send({ error: 'event_in_the_past' });
      }
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO events (club_id, title, description, venue, locality, starts_at, capacity, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          b['clubId'] ?? null,
          b['title'],
          b['description'] ?? null,
          b['venue'] ?? null,
          b['locality'] ?? null,
          b['startsAt'],
          b['capacity'] ?? null,
          request.user!.id,
        ],
      );
      await audit(request.user!.id, 'event.created', rows[0]!.id);
      return reply.code(201).send({ id: rows[0]!.id });
    },
  );

  app.put(
    '/api/events/:id/rsvp',
    {
      schema: {
        body: {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', enum: ['going', 'maybe', 'declined'] } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { status } = request.body as { status: string };

      const { rows } = await pool.query<{ capacity: number | null; going: number }>(
        `SELECT e.capacity,
                (SELECT count(*) FROM event_rsvps r
                  WHERE r.event_id = e.id AND r.status = 'going')::int AS going
           FROM events e WHERE e.id = $1 AND e.cancelled_at IS NULL`,
        [id],
      );
      const event = rows[0];
      if (!event) return reply.code(404).send({ error: 'not_found' });

      const already = await pool.query(
        "SELECT 1 FROM event_rsvps WHERE event_id = $1 AND user_id = $2 AND status = 'going'",
        [id, request.user!.id],
      );
      if (
        status === 'going' &&
        !already.rowCount &&
        event.capacity !== null &&
        event.going >= event.capacity
      ) {
        return reply.code(409).send({ error: 'event_full' });
      }

      await pool.query(
        `INSERT INTO event_rsvps (event_id, user_id, status) VALUES ($1, $2, $3)
         ON CONFLICT (event_id, user_id) DO UPDATE SET status = EXCLUDED.status`,
        [id, request.user!.id, status],
      );
      return { status };
    },
  );

  /* ----------------------------------------------------- compatibility -- */

  app.get('/api/compatibility/questions/:profileId', async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const owned = await pool.query('SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2', [
      profileId,
      request.user!.id,
    ]);
    if (!owned.rowCount) return reply.code(404).send({ error: 'not_found' });

    const { rows } = await pool.query(
      `SELECT q.id, q.category, q.prompt, q.options, a.choice
         FROM compatibility_questions q
         LEFT JOIN compatibility_answers a
           ON a.question_id = q.id AND a.profile_id = $1
        ORDER BY q.sort`,
      [profileId],
    );
    return { questions: rows };
  });

  app.put(
    '/api/compatibility/answers',
    {
      schema: {
        body: {
          type: 'object',
          required: ['profileId', 'questionId', 'choice'],
          properties: {
            profileId: { type: 'string', format: 'uuid' },
            questionId: { type: 'string', format: 'uuid' },
            choice: { type: 'integer', minimum: 0, maximum: 9 },
          },
        },
      },
    },
    async (request, reply) => {
      const { profileId, questionId, choice } = request.body as {
        profileId: string;
        questionId: string;
        choice: number;
      };
      const owned = await pool.query('SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2', [
        profileId,
        request.user!.id,
      ]);
      if (!owned.rowCount) return reply.code(404).send({ error: 'not_found' });

      await pool.query(
        `INSERT INTO compatibility_answers (profile_id, question_id, choice)
         VALUES ($1, $2, $3)
         ON CONFLICT (profile_id, question_id)
         DO UPDATE SET choice = EXCLUDED.choice, answered_at = now()`,
        [profileId, questionId, choice],
      );
      return { ok: true };
    },
  );

  /**
   * Compatibility Radar between two matched profiles.
   *
   * Per PRD §5.2 and §6 this reports agreements and differences per category,
   * NOT a single authoritative score and NOT a prediction. Categories where
   * you differ are surfaced as questions worth asking, not as problems.
   */
  app.get('/api/compatibility/radar/:matchId', async (request, reply) => {
    const { matchId } = request.params as { matchId: string };
    const userId = request.user!.id;

    const { rows: ctx } = await pool.query<{ mine: string; theirs: string; name: string }>(
      `SELECT mine.id AS mine, other.id AS theirs, other.display_name AS name
         FROM matches m
         JOIN profiles mine ON mine.id IN (m.profile_a_id, m.profile_b_id) AND mine.user_id = $2
         JOIN profiles other ON other.id IN (m.profile_a_id, m.profile_b_id) AND other.id <> mine.id
        WHERE m.id = $1 AND m.closed_at IS NULL`,
      [matchId, userId],
    );
    if (!ctx.length) return reply.code(404).send({ error: 'not_found' });

    const { rows } = await pool.query(
      `SELECT q.category,
              count(*) FILTER (WHERE a.choice = b.choice)::int AS agreed,
              count(*)::int AS answered,
              array_agg(q.prompt) FILTER (WHERE a.choice <> b.choice) AS "differOn"
         FROM compatibility_questions q
         JOIN compatibility_answers a ON a.question_id = q.id AND a.profile_id = $1
         JOIN compatibility_answers b ON b.question_id = q.id AND b.profile_id = $2
        GROUP BY q.category
        ORDER BY q.category`,
      [ctx[0]!.mine, ctx[0]!.theirs],
    );

    return {
      otherName: ctx[0]!.name,
      categories: rows,
      // Shown verbatim in the UI. The PRD forbids presenting this as a
      // prediction of relationship success.
      disclaimer:
        'Based on answers you both chose to give. These are conversation starters, not a prediction about your relationship.',
    };
  });
}
