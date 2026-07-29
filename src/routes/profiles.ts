import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth-guard.js';

export const PROFILE_KINDS = ['dating', 'friends', 'activities', 'networking'] as const;

export const CONNECTION_MODES = [
  'marriage',
  'long_term',
  'casual_dating',
  'fun_hangout',
  'hookup',
  'friends',
  'activity_partners',
  'networking',
] as const;

export const VISIBILITIES = ['invisible', 'audiences', 'clubs_events', 'discoverable'] as const;

const profileBody = {
  type: 'object',
  required: ['kind', 'displayName'],
  properties: {
    kind: { type: 'string', enum: [...PROFILE_KINDS] },
    displayName: { type: 'string', minLength: 1, maxLength: 60 },
    headline: { type: 'string', maxLength: 140 },
    bio: { type: 'string', maxLength: 2000 },
    // Locality is free text at town/city granularity — never coordinates.
    locality: { type: 'string', maxLength: 80 },
    interests: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', maxLength: 40 },
    },
    visibility: { type: 'string', enum: [...VISIBILITIES] },
    ageMin: { type: 'integer', minimum: 18, maximum: 120 },
    ageMax: { type: 'integer', minimum: 18, maximum: 120 },
    modes: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', enum: [...CONNECTION_MODES] },
    },
  },
} as const;

interface ProfileBody {
  kind: string;
  displayName: string;
  headline?: string;
  bio?: string;
  locality?: string;
  interests?: string[];
  visibility?: string;
  ageMin?: number;
  ageMax?: number;
  modes?: string[];
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/profiles', async (request) => {
    const { rows } = await pool.query(
      `SELECT p.id, p.kind, p.display_name AS "displayName", p.headline, p.bio,
              p.locality, p.interests, p.visibility,
              p.age_min AS "ageMin", p.age_max AS "ageMax",
              COALESCE(
                (SELECT array_agg(m.mode) FROM profile_modes m WHERE m.profile_id = p.id),
                '{}'
              ) AS modes
         FROM profiles p
        WHERE p.user_id = $1
        ORDER BY p.kind`,
      [request.user!.id],
    );
    return { profiles: rows };
  });

  /** Create or update the profile for one purpose. */
  app.put('/api/profiles', { schema: { body: profileBody } }, async (request, reply) => {
    const body = request.body as ProfileBody;
    const userId = request.user!.id;

    const ageMin = body.ageMin ?? 18;
    const ageMax = body.ageMax ?? 99;
    if (ageMax < ageMin) {
      return reply.code(400).send({ error: 'age_range_inverted' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO profiles
           (user_id, kind, display_name, headline, bio, locality, interests,
            visibility, age_min, age_max)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_id, kind) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           headline     = EXCLUDED.headline,
           bio          = EXCLUDED.bio,
           locality     = EXCLUDED.locality,
           interests    = EXCLUDED.interests,
           visibility   = EXCLUDED.visibility,
           age_min      = EXCLUDED.age_min,
           age_max      = EXCLUDED.age_max,
           updated_at   = now()
         RETURNING id`,
        [
          userId,
          body.kind,
          body.displayName,
          body.headline ?? null,
          body.bio ?? null,
          body.locality ?? null,
          body.interests ?? [],
          body.visibility ?? 'invisible',
          ageMin,
          ageMax,
        ],
      );
      const profileId = rows[0]!.id;

      if (body.modes) {
        await client.query('DELETE FROM profile_modes WHERE profile_id = $1', [profileId]);
        await client.query(
          `INSERT INTO profile_modes (profile_id, mode)
           SELECT $1, m FROM unnest($2::text[]) AS m`,
          [profileId, body.modes],
        );
      }

      await client.query('COMMIT');
      await audit(userId, 'profile.saved', profileId, { kind: body.kind });
      return reply.send({ id: profileId });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  /** Visibility is separated so it can be changed instantly from anywhere. */
  app.patch(
    '/api/profiles/:id/visibility',
    {
      schema: {
        body: {
          type: 'object',
          required: ['visibility'],
          properties: { visibility: { type: 'string', enum: [...VISIBILITIES] } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { visibility } = request.body as { visibility: string };
      const { rowCount } = await pool.query(
        `UPDATE profiles SET visibility = $1, updated_at = now()
          WHERE id = $2 AND user_id = $3`,
        [visibility, id, request.user!.id],
      );
      if (!rowCount) return reply.code(404).send({ error: 'not_found' });
      await audit(request.user!.id, 'profile.visibility_changed', id, { visibility });
      return { ok: true };
    },
  );

  app.delete('/api/profiles/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { rowCount } = await pool.query(
      'DELETE FROM profiles WHERE id = $1 AND user_id = $2',
      [id, request.user!.id],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(request.user!.id, 'profile.deleted', id);
    return { ok: true };
  });
}
