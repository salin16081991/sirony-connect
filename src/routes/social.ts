import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth-guard.js';
import { LIMITS } from '../lib/media-store.js';
import { parseYouTubeUrl, thumbnailUrl } from '../lib/youtube.js';

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /* ------------------------------------------------- stories and reels -- */

  app.post(
    '/api/posts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['profileId', 'kind'],
          properties: {
            profileId: { type: 'string', format: 'uuid' },
            mediaId: { type: 'string', format: 'uuid' },
            kind: { type: 'string', enum: ['story', 'reel'] },
            caption: { type: 'string', maxLength: 500 },
            // Reels only. The video lives on the author's YouTube channel.
            videoUrl: { type: 'string', maxLength: 500 },
          },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const { profileId, mediaId, kind, caption, videoUrl } = request.body as {
        profileId: string;
        mediaId?: string;
        kind: 'story' | 'reel';
        caption?: string;
        videoUrl?: string;
      };
      const userId = request.user!.id;

      const owned = await pool.query('SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2', [
        profileId,
        userId,
      ]);
      if (!owned.rowCount) return reply.code(404).send({ error: 'not_found' });

      // A reel is a link to the author's own YouTube upload; nothing is stored
      // here but the identifier. A story is uploaded media. Never both.
      let video = null;
      if (kind === 'reel') {
        if (!videoUrl) return reply.code(400).send({ error: 'video_url_required' });
        video = parseYouTubeUrl(videoUrl);
        if (!video) return reply.code(400).send({ error: 'invalid_youtube_url' });
        if (mediaId) return reply.code(400).send({ error: 'reels_do_not_take_uploads' });
      } else if (videoUrl) {
        // A story may also be a YouTube link. What it may never be is an
        // uploaded video — see the upload route.
        video = parseYouTubeUrl(videoUrl);
        if (!video) return reply.code(400).send({ error: 'invalid_youtube_url' });
        if (mediaId) return reply.code(400).send({ error: 'photo_or_link_not_both' });
      }

      if (mediaId) {
        const media = await pool.query('SELECT 1 FROM media_objects WHERE id = $1 AND owner_id = $2', [
          mediaId,
          userId,
        ]);
        if (!media.rowCount) return reply.code(404).send({ error: 'media_not_found' });
      }

      // Stories last a day, reels a month. The media inherits the deadline so
      // the file is swept at the same time as the post.
      const interval =
        kind === 'story' ? `${LIMITS.storyHours} hours` : `${LIMITS.reelDays} days`;

      const { rows } = await pool.query<{ id: string; expiresAt: string }>(
        `INSERT INTO posts (profile_id, media_id, kind, caption, expires_at, video_url, video_id)
         VALUES ($1, $2, $3, $4, now() + $5::interval, $6, $7)
         RETURNING id, expires_at AS "expiresAt"`,
        [
          profileId,
          mediaId ?? null,
          kind,
          caption ?? null,
          interval,
          video?.canonicalUrl ?? null,
          video?.videoId ?? null,
        ],
      );

      if (mediaId) {
        await pool.query(
          `UPDATE media_objects SET expires_at = now() + $2::interval WHERE id = $1`,
          [mediaId, interval],
        );
      }

      await audit(userId, `post.created.${kind}`, rows[0]!.id);
      return reply.code(201).send(rows[0]);
    },
  );

  /**
   * Feed of live posts from people you follow, plus your own.
   *
   * Heart counts are NOT included for other people's posts — see the hearts
   * endpoint below for why.
   */
  app.get('/api/posts', async (request) => {
    const kind = (request.query as { kind?: string }).kind === 'reel' ? 'reel' : 'story';
    const userId = request.user!.id;

    const { rows } = await pool.query(
      `SELECT p.id, p.kind, p.caption, p.media_id AS "mediaId",
              p.video_url AS "videoUrl", p.video_id AS "videoId",
              p.created_at AS "createdAt", p.expires_at AS "expiresAt",
              pr.id AS "profileId", pr.display_name AS "displayName",
              (pr.user_id = $1) AS mine,
              EXISTS (SELECT 1 FROM hearts h
                       WHERE h.post_id = p.id AND h.user_id = $1) AS hearted,
              CASE WHEN pr.user_id = $1
                   THEN (SELECT count(*) FROM hearts h WHERE h.post_id = p.id)::int
                   ELSE NULL END AS "heartsIfMine"
         FROM posts p
         JOIN profiles pr ON pr.id = p.profile_id
         JOIN users u ON u.id = pr.user_id AND u.status = 'active'
        WHERE p.kind = $2
          AND p.removed_at IS NULL
          AND p.expires_at > now()
          AND (pr.user_id = $1
               OR EXISTS (SELECT 1 FROM follows f
                           WHERE f.follower_id = $1 AND f.followee_id = pr.id))
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $1 AND b.blocked_id = pr.user_id)
                OR (b.blocker_id = pr.user_id AND b.blocked_id = $1)
          )
        ORDER BY p.created_at DESC LIMIT 100`,
      [userId, kind],
    );
    return {
      posts: rows.map((row) => ({
        ...row,
        // Supplied so the client can offer a thumbnail, but the client decides
        // whether to load it: fetching it contacts Google.
        thumbnailUrl: row.videoId ? thumbnailUrl(row.videoId) : null,
      })),
    };
  });

  /**
   * Where to send someone who wants to post a reel. They upload on YouTube,
   * then paste the resulting link back here.
   */
  app.get('/api/reels/upload-target', async () => ({
    uploadUrl: 'https://www.youtube.com/upload',
    instructions:
      'Upload the video to your own YouTube channel, then paste the link here. Sirony Connect stores only the link — the video stays yours and deleting it on YouTube removes it here too.',
  }));

  app.delete('/api/posts/:id', async (request, reply) => {
    const { rowCount } = await pool.query(
      `DELETE FROM posts p USING profiles pr
        WHERE p.id = $1 AND pr.id = p.profile_id AND pr.user_id = $2`,
      [(request.params as { id: string }).id, request.user!.id],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  /* ------------------------------------------------------------ hearts -- */

  /**
   * Hearting is a private signal to the author. The count is returned only to
   * the post's owner and never appears on anyone else's profile: PRD §8 rules
   * out popularity as a reputation signal, and a public counter is exactly
   * the attention-extraction loop the product sets out to avoid.
   */
  app.post('/api/posts/:id/heart', async (request, reply) => {
    const { id } = request.params as { id: string };
    const visible = await pool.query(
      `SELECT 1 FROM posts p JOIN profiles pr ON pr.id = p.profile_id
        WHERE p.id = $1 AND p.removed_at IS NULL AND p.expires_at > now()
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $2 AND b.blocked_id = pr.user_id)
                OR (b.blocker_id = pr.user_id AND b.blocked_id = $2)
          )`,
      [id, request.user!.id],
    );
    if (!visible.rowCount) return reply.code(404).send({ error: 'not_found' });

    await pool.query(
      'INSERT INTO hearts (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, request.user!.id],
    );
    return { hearted: true };
  });

  app.delete('/api/posts/:id/heart', async (request) => {
    await pool.query('DELETE FROM hearts WHERE post_id = $1 AND user_id = $2', [
      (request.params as { id: string }).id,
      request.user!.id,
    ]);
    return { hearted: false };
  });

  /* ----------------------------------------------------------- follows -- */

  app.post('/api/profiles/:id/follow', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;

    const target = await pool.query<{ user_id: string }>(
      `SELECT p.user_id FROM profiles p JOIN users u ON u.id = p.user_id
        WHERE p.id = $1 AND u.status = 'active' AND p.visibility = 'discoverable'
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $2 AND b.blocked_id = p.user_id)
                OR (b.blocker_id = p.user_id AND b.blocked_id = $2)
          )`,
      [id, userId],
    );
    if (!target.rowCount) return reply.code(404).send({ error: 'not_found' });
    if (target.rows[0]!.user_id === userId) {
      return reply.code(400).send({ error: 'cannot_follow_self' });
    }

    await pool.query(
      'INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, id],
    );
    return { following: true };
  });

  app.delete('/api/profiles/:id/follow', async (request) => {
    await pool.query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [
      request.user!.id,
      (request.params as { id: string }).id,
    ]);
    return { following: false };
  });

  /** Your own numbers, visible only to you. */
  app.get('/api/me/stats', async (request) => {
    const userId = request.user!.id;
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*) FROM follows f
           JOIN profiles p ON p.id = f.followee_id
          WHERE p.user_id = $1)::int AS followers,
         (SELECT count(*) FROM follows WHERE follower_id = $1)::int AS following,
         (SELECT count(*) FROM hearts h
            JOIN posts po ON po.id = h.post_id
            JOIN profiles p ON p.id = po.profile_id
           WHERE p.user_id = $1)::int AS "heartsReceived",
         (SELECT count(*) FROM posts po
            JOIN profiles p ON p.id = po.profile_id
           WHERE p.user_id = $1 AND po.expires_at > now())::int AS "livePosts"`,
      [userId],
    );
    return {
      ...rows[0],
      note: 'These numbers are private. Nobody else can see your hearts or follower count.',
    };
  });

  /* --------------------------------------------------------------- QR -- */

  /**
   * A QR code for meeting in person. The token is single-use and expires in
   * five minutes, so a photographed code does not become a permanent handle.
   */
  app.post('/api/qr/:profileId', async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const owned = await pool.query('SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2', [
      profileId,
      request.user!.id,
    ]);
    if (!owned.rowCount) return reply.code(404).send({ error: 'not_found' });

    const token = randomBytes(16).toString('base64url');
    await pool.query(
      "INSERT INTO qr_tokens (token, profile_id, expires_at) VALUES ($1, $2, now() + interval '5 minutes')",
      [token, profileId],
    );
    return { token, expiresInSeconds: 300 };
  });

  app.post(
    '/api/qr/redeem',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', maxLength: 64 } },
        },
      },
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const { token } = request.body as { token: string };
      const userId = request.user!.id;

      const { rows } = await pool.query<{ profile_id: string; owner: string; name: string }>(
        `UPDATE qr_tokens q SET used_at = now(), used_by = $2
           FROM profiles p, users u
          WHERE q.token = $1
            AND q.used_at IS NULL
            AND q.expires_at > now()
            AND p.id = q.profile_id
            AND u.id = p.user_id AND u.status = 'active'
          RETURNING q.profile_id, p.user_id AS owner, p.display_name AS name`,
        [token, userId],
      );
      const found = rows[0];
      if (!found) return reply.code(404).send({ error: 'qr_invalid_or_used' });
      if (found.owner === userId) return reply.code(400).send({ error: 'cannot_follow_self' });

      // Scanning follows them; it does not create a match. Meeting someone in
      // person is not consent to be matched with them.
      await pool.query(
        'INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, found.profile_id],
      );
      await audit(userId, 'qr.redeemed', found.profile_id);
      return { profileId: found.profile_id, displayName: found.name, following: true };
    },
  );
}
