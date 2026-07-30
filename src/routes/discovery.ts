import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireAuth } from '../lib/auth-guard.js';
import { signMediaToken } from '../lib/media-store.js';

/** Free tier: a small number of curated introductions, not an infinite deck. */
const DAILY_INTRODUCTIONS = 5;

/**
 * Candidate selection (PRD §5.1). Every clause here is a product requirement:
 *
 * - same profile kind, and `discoverable` visibility only
 * - overlapping, mutually selected connection modes (PRD §3)
 * - each person inside the other's stated age range — mutual, not one-way
 * - blocks respected in both directions, across all of a user's profiles
 * - nobody already liked or already introduced
 *
 * Ordering is by shared-mode count then shared interests, so introductions are
 * explainable ("you both chose long-term and share 3 interests") rather than
 * an opaque score.
 */
const CANDIDATE_SQL = `
WITH me AS (
  SELECT p.id, p.user_id, p.kind, p.interests, p.age_min, p.age_max,
         date_part('year', age(u.date_of_birth))::int AS my_age
    FROM profiles p
    JOIN users u ON u.id = p.user_id
   WHERE p.id = $1 AND p.user_id = $2
),
my_modes AS (
  SELECT mode FROM profile_modes WHERE profile_id = (SELECT id FROM me)
)
SELECT c.id,
       c.display_name AS "displayName",
       c.headline,
       c.bio,
       c.locality,
       c.interests,
       date_part('year', age(cu.date_of_birth))::int AS age,
       ARRAY(
         SELECT cm.mode FROM profile_modes cm
          WHERE cm.profile_id = c.id AND cm.mode IN (SELECT mode FROM my_modes)
       ) AS "sharedModes",
       ARRAY(SELECT unnest(c.interests) INTERSECT SELECT unnest(me.interests)) AS "sharedInterests"
  FROM profiles c
  JOIN users cu ON cu.id = c.user_id
 CROSS JOIN me
 WHERE c.kind = me.kind
   AND c.visibility = 'discoverable'
   AND c.user_id <> me.user_id
   AND cu.status = 'active'
   -- mutual mode overlap
   AND EXISTS (
     SELECT 1 FROM profile_modes cm
      WHERE cm.profile_id = c.id AND cm.mode IN (SELECT mode FROM my_modes)
   )
   -- mutual age acceptance
   AND date_part('year', age(cu.date_of_birth))::int BETWEEN me.age_min AND me.age_max
   AND me.my_age BETWEEN c.age_min AND c.age_max
   -- blocks in either direction
   AND NOT EXISTS (
     SELECT 1 FROM blocks b
      WHERE (b.blocker_id = me.user_id AND b.blocked_id = c.user_id)
         OR (b.blocker_id = c.user_id AND b.blocked_id = me.user_id)
   )
   AND NOT EXISTS (
     SELECT 1 FROM likes l WHERE l.from_profile_id = me.id AND l.to_profile_id = c.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM introductions i WHERE i.profile_id = me.id AND i.candidate_id = c.id
   )
 ORDER BY cardinality(ARRAY(
            SELECT cm.mode FROM profile_modes cm
             WHERE cm.profile_id = c.id AND cm.mode IN (SELECT mode FROM my_modes)
          )) DESC,
          cardinality(ARRAY(
            SELECT unnest(c.interests) INTERSECT SELECT unnest(me.interests)
          )) DESC,
          c.created_at DESC
 LIMIT $3`;

export async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /**
   * Today's introductions for one profile. Idempotent within a day: re-issuing
   * returns the same set rather than handing out more.
   */
  app.get('/api/discovery/:profileId', async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const userId = request.user!.id;

    const owned = await pool.query('SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2', [
      profileId,
      userId,
    ]);
    if (!owned.rowCount) return reply.code(404).send({ error: 'not_found' });

    const existing = await pool.query(
      `SELECT i.candidate_id FROM introductions i
        WHERE i.profile_id = $1 AND i.issued_on = CURRENT_DATE`,
      [profileId],
    );
    const remaining = DAILY_INTRODUCTIONS - existing.rowCount!;

    if (remaining > 0) {
      const fresh = await pool.query<{ id: string }>(CANDIDATE_SQL, [
        profileId,
        userId,
        remaining,
      ]);
      if (fresh.rowCount) {
        await pool.query(
          `INSERT INTO introductions (profile_id, candidate_id)
           SELECT $1, c FROM unnest($2::uuid[]) AS c
           ON CONFLICT DO NOTHING`,
          [profileId, fresh.rows.map((r) => r.id)],
        );
      }
    }

    // Return today's set, hiding anyone blocked since the introduction issued.
    const { rows } = await pool.query(
      `SELECT c.id,
              c.display_name AS "displayName",
              c.headline, c.bio, c.locality, c.interests,
              date_part('year', age(cu.date_of_birth))::int AS age,
              c.photo_media_id AS "photoMediaId",
              i.acted_at AS "actedAt",
              ARRAY(
                SELECT cm.mode FROM profile_modes cm
                 WHERE cm.profile_id = c.id
                   AND cm.mode IN (SELECT mode FROM profile_modes WHERE profile_id = $1)
              ) AS "sharedModes"
         FROM introductions i
         JOIN profiles c ON c.id = i.candidate_id
         JOIN users cu ON cu.id = c.user_id
        WHERE i.profile_id = $1
          AND i.issued_on = CURRENT_DATE
          AND cu.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $2 AND b.blocked_id = c.user_id)
                OR (b.blocker_id = c.user_id AND b.blocked_id = $2)
          )
        ORDER BY i.id`,
      [profileId, userId],
    );

    return {
      // Each card gets its own short-lived ticket, so a photo URL copied out
      // of the page stops working within minutes.
      introductions: rows.map((row) => ({
        ...row,
        photoUrl: row.photoMediaId
          ? `/api/media/${row.photoMediaId}/file?t=${signMediaToken(row.photoMediaId, userId)}`
          : null,
      })),
      dailyLimit: DAILY_INTRODUCTIONS,
      // Surfaced so the UI can explain *why* someone appeared, per PRD §5.2:
      // agreements and questions, never an authoritative percentage.
      explanation: 'Introductions are ordered by shared connection modes and interests.',
    };
  });
}
