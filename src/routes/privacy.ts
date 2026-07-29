import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth-guard.js';

const CONSENT_KINDS = [
  'ai_profile_assist',
  'ai_chat_analysis',
  'ai_voice_analysis',
  'approximate_location',
  'push_notifications',
  'trusted_contacts',
] as const;

/**
 * Plain-language descriptions shown next to each toggle. PRD §6 requires that
 * inputs, outputs and retention are explained wherever consent is requested —
 * not buried in a policy document.
 */
const CONSENT_COPY: Record<string, { label: string; explains: string }> = {
  ai_profile_assist: {
    label: 'Writing suggestions for my profile',
    explains:
      'Sends only the profile text you are editing. Suggestions are optional and never posted for you.',
  },
  ai_chat_analysis: {
    label: 'Conversation observations',
    explains:
      'Reads your messages to show observations such as unanswered questions. Off by default. These are observations, not judgements about you or anyone else.',
  },
  ai_voice_analysis: {
    label: 'Voice note analysis',
    explains:
      'Processes voice notes you record. Off by default. Never used to infer emotion, honesty or attraction.',
  },
  approximate_location: {
    label: 'Approximate location',
    explains:
      'Shares your town or city, never your precise position. Used to order introductions by proximity.',
  },
  push_notifications: {
    label: 'Push notifications',
    explains: 'Delivers new-introduction and match alerts to this device.',
  },
  trusted_contacts: {
    label: 'Trusted contacts',
    explains:
      'Lets you share a date plan and check-in with people you choose. Nothing is shared until you send it.',
  },
};

export async function privacyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/consents', async (request) => {
    const { rows } = await pool.query<{ kind: string; granted: boolean; updated_at: string }>(
      'SELECT kind, granted, updated_at FROM consents WHERE user_id = $1',
      [request.user!.id],
    );
    const state = new Map(rows.map((r) => [r.kind, r]));
    return {
      consents: CONSENT_KINDS.map((kind) => ({
        kind,
        granted: state.get(kind)?.granted ?? false,
        updatedAt: state.get(kind)?.updated_at ?? null,
        ...CONSENT_COPY[kind],
      })),
    };
  });

  /** Each consent is granted and withdrawn independently (PRD §6). */
  app.put(
    '/api/consents/:kind',
    {
      schema: {
        body: {
          type: 'object',
          required: ['granted'],
          properties: { granted: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const { kind } = request.params as { kind: string };
      const { granted } = request.body as { granted: boolean };
      if (!(CONSENT_KINDS as readonly string[]).includes(kind)) {
        return reply.code(400).send({ error: 'unknown_consent' });
      }

      await pool.query(
        `INSERT INTO consents (user_id, kind, granted, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, kind)
         DO UPDATE SET granted = EXCLUDED.granted, updated_at = now()`,
        [request.user!.id, kind, granted],
      );

      await audit(request.user!.id, granted ? 'consent.granted' : 'consent.withdrawn', kind);
      return { kind, granted };
    },
  );

  /**
   * Data export (PRD §7). Returns everything held about the caller. Blocks are
   * emitted as counts, not identities, so an export cannot be used to work out
   * who blocked whom.
   */
  app.get('/api/privacy/export', async (request) => {
    const userId = request.user!.id;
    const [account, profiles, consents, likes, matches, blocked] = await Promise.all([
      pool.query(
        `SELECT id, email, date_of_birth AS "dateOfBirth", status,
                identity_verified_at AS "identityVerifiedAt", created_at AS "createdAt"
           FROM users WHERE id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT p.*, COALESCE(
                  (SELECT array_agg(m.mode) FROM profile_modes m WHERE m.profile_id = p.id),
                  '{}') AS modes
           FROM profiles p WHERE p.user_id = $1`,
        [userId],
      ),
      pool.query('SELECT kind, granted, updated_at FROM consents WHERE user_id = $1', [userId]),
      pool.query(
        `SELECT l.to_profile_id, l.created_at FROM likes l
           JOIN profiles p ON p.id = l.from_profile_id WHERE p.user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT m.id, m.created_at FROM matches m
           JOIN profiles p ON p.id IN (m.profile_a_id, m.profile_b_id)
          WHERE p.user_id = $1`,
        [userId],
      ),
      pool.query('SELECT count(*)::int AS n FROM blocks WHERE blocker_id = $1', [userId]),
    ]);

    await audit(userId, 'privacy.exported');
    return {
      exportedAt: new Date().toISOString(),
      account: account.rows[0],
      profiles: profiles.rows,
      consents: consents.rows,
      likes: likes.rows,
      matches: matches.rows,
      blockedCount: blocked.rows[0]?.n ?? 0,
    };
  });
}
