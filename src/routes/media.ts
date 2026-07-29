import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth-guard.js';
import {
  LIMITS,
  kindForMime,
  signMediaToken,
  storagePathFor,
  verifyMediaToken,
} from '../lib/media-store.js';

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Upload. Type is taken from the sniffed mime, not the filename. */
  app.post('/api/media', { config: { rateLimit: { max: 40, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const file = await request.file({
        limits: { fileSize: LIMITS.videoBytes, files: 1 },
      });
      if (!file) return reply.code(400).send({ error: 'no_file' });

      const kind = kindForMime(file.mimetype);
      if (!kind) return reply.code(415).send({ error: 'unsupported_type' });

      const oneTime = (request.query as { oneTime?: string }).oneTime === 'true';
      const ttl = (request.query as { ttl?: string }).ttl;

      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO media_objects (owner_id, kind, mime, bytes, storage_path, one_time, expires_at)
         VALUES ($1, $2, $3, 0, '', $4,
                 CASE WHEN $5::int IS NULL THEN NULL
                      ELSE now() + make_interval(secs => $5::int) END)
         RETURNING id`,
        [request.user!.id, kind, file.mimetype, oneTime, ttl ? Number(ttl) : null],
      );
      const id = rows[0]!.id;
      const path = storagePathFor(id);

      try {
        await pipeline(file.file, createWriteStream(path, { mode: 0o600 }));
      } catch (error) {
        await pool.query('DELETE FROM media_objects WHERE id = $1', [id]);
        throw error;
      }

      if (file.file.truncated) {
        await unlink(path).catch(() => {});
        await pool.query('DELETE FROM media_objects WHERE id = $1', [id]);
        return reply.code(413).send({ error: 'file_too_large' });
      }

      const { size } = await stat(path);
      if (kind === 'photo' && size > LIMITS.photoBytes) {
        await unlink(path).catch(() => {});
        await pool.query('DELETE FROM media_objects WHERE id = $1', [id]);
        return reply.code(413).send({ error: 'file_too_large' });
      }

      await pool.query('UPDATE media_objects SET bytes = $2, storage_path = $3 WHERE id = $1', [
        id,
        size,
        path,
      ]);
      await audit(request.user!.id, 'media.uploaded', id, { kind, oneTime });
      return reply.code(201).send({ id, kind, bytes: size, oneTime });
    },
  );

  /**
   * Mint a short-lived viewing token. Access is decided here, once, rather
   * than on every byte range request.
   */
  app.get('/api/media/:id/ticket', async (request, reply) => {
    const { id } = request.params as { id: string };
    const viewerId = request.user!.id;

    const { rows } = await pool.query<{
      owner_id: string;
      one_time: boolean;
      burned_at: string | null;
      kind: string;
    }>(
      `SELECT m.owner_id, m.one_time, m.burned_at, m.kind
         FROM media_objects m
        WHERE m.id = $1
          AND (m.expires_at IS NULL OR m.expires_at > now())
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $2 AND b.blocked_id = m.owner_id)
                OR (b.blocker_id = m.owner_id AND b.blocked_id = $2)
          )`,
      [id, viewerId],
    );
    const media = rows[0];
    if (!media) return reply.code(404).send({ error: 'not_found' });

    const isOwner = media.owner_id === viewerId;
    if (media.one_time && !isOwner) {
      const seen = await pool.query(
        'SELECT 1 FROM media_views WHERE media_id = $1 AND viewer_id = $2',
        [id, viewerId],
      );
      if (seen.rowCount || media.burned_at) {
        return reply.code(410).send({ error: 'already_viewed' });
      }
    }

    return {
      url: `/api/media/${id}/file?t=${signMediaToken(id, viewerId)}`,
      kind: media.kind,
      oneTime: media.one_time && !isOwner,
      /**
       * Rendered by the client as a moving overlay. Watermarking is a
       * deterrent and a traceability aid, not a guarantee — a second camera
       * defeats any of this, and the UI says so (PRD §7).
       */
      watermark: `${viewerId.slice(0, 8)} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    };
  });

  /** Serves bytes only against a valid, unexpired, per-viewer token. */
  app.get('/api/media/:id/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { t } = request.query as { t?: string };
    const viewerId = request.user!.id;

    if (!t || !verifyMediaToken(id, viewerId, t)) {
      return reply.code(403).send({ error: 'invalid_ticket' });
    }

    const { rows } = await pool.query<{
      storage_path: string;
      mime: string;
      owner_id: string;
      one_time: boolean;
    }>(
      `SELECT storage_path, mime, owner_id, one_time FROM media_objects
        WHERE id = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [id],
    );
    const media = rows[0];
    if (!media) return reply.code(404).send({ error: 'not_found' });

    // Record the view, and burn one-time media on first outside look.
    if (media.owner_id !== viewerId) {
      await pool.query(
        'INSERT INTO media_views (media_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, viewerId],
      );
      if (media.one_time) {
        await pool.query(
          'UPDATE media_objects SET burned_at = now() WHERE id = $1 AND burned_at IS NULL',
          [id],
        );
      }
    }

    return reply
      .header('Content-Type', media.mime)
      // No intermediary or browser cache may retain personal media.
      .header('Cache-Control', 'no-store, private')
      .header('Content-Disposition', 'inline')
      .send(createReadStream(media.storage_path));
  });

  /** Who has opened your media — the accountability half of watermarking. */
  app.get('/api/media/:id/views', async (request, reply) => {
    const { id } = request.params as { id: string };
    const owned = await pool.query('SELECT 1 FROM media_objects WHERE id = $1 AND owner_id = $2', [
      id,
      request.user!.id,
    ]);
    if (!owned.rowCount) return reply.code(404).send({ error: 'not_found' });

    const { rows } = await pool.query(
      `SELECT v.viewed_at AS "viewedAt",
              (SELECT p.display_name FROM profiles p
                WHERE p.user_id = v.viewer_id LIMIT 1) AS "viewerName"
         FROM media_views v WHERE v.media_id = $1 ORDER BY v.viewed_at DESC`,
      [id],
    );
    return { views: rows };
  });

  app.delete('/api/media/:id', async (request, reply) => {
    const { rows } = await pool.query<{ storage_path: string }>(
      'DELETE FROM media_objects WHERE id = $1 AND owner_id = $2 RETURNING storage_path',
      [(request.params as { id: string }).id, request.user!.id],
    );
    if (!rows.length) return reply.code(404).send({ error: 'not_found' });
    await unlink(rows[0]!.storage_path).catch(() => {});
    return { ok: true };
  });
}
