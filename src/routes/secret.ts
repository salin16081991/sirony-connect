import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth-guard.js';

/**
 * END-TO-END ENCRYPTED SECRET CHAT — NOT SECURITY REVIEWED.
 *
 * PRD §7 requires specialist review of key management, device revocation and
 * recovery before launch, and §12 defers this feature entirely. Built at the
 * owner's explicit request. Do not describe it to users as audited.
 *
 * Design: ECDH P-256 in the browser, AES-GCM payloads. The server stores
 * public keys and ciphertext and nothing else. It cannot read messages, but
 * note the honest limits:
 *
 *   - the server distributes the public keys, so it could substitute its own
 *     (a classic MITM). Safety numbers below let users detect that manually.
 *   - there is no forward secrecy: keys are long-lived per device.
 *   - a compromised browser reads plaintext regardless.
 */
export async function secretRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Register this browser's public key. Private keys never leave the client. */
  app.put(
    '/api/secret/devices',
    {
      schema: {
        body: {
          type: 'object',
          required: ['deviceId', 'publicKey'],
          properties: {
            deviceId: { type: 'string', minLength: 8, maxLength: 64 },
            publicKey: { type: 'string', minLength: 40, maxLength: 512 },
            label: { type: 'string', maxLength: 60 },
          },
        },
      },
    },
    async (request) => {
      const { deviceId, publicKey, label } = request.body as {
        deviceId: string;
        publicKey: string;
        label?: string;
      };
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO device_keys (user_id, device_id, public_key, label)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, device_id)
         DO UPDATE SET public_key = EXCLUDED.public_key,
                       label = EXCLUDED.label,
                       revoked_at = NULL
         RETURNING id`,
        [request.user!.id, deviceId, publicKey, label ?? null],
      );
      await audit(request.user!.id, 'secret.device_registered', rows[0]!.id);
      return { deviceKeyId: rows[0]!.id };
    },
  );

  app.get('/api/secret/devices', async (request) => {
    const { rows } = await pool.query(
      `SELECT id, device_id AS "deviceId", label, public_key AS "publicKey",
              created_at AS "createdAt", revoked_at AS "revokedAt"
         FROM device_keys WHERE user_id = $1 ORDER BY created_at`,
      [request.user!.id],
    );
    return { devices: rows };
  });

  /** Revoking stops future deliveries to that device immediately. */
  app.delete('/api/secret/devices/:id', async (request, reply) => {
    const { rowCount } = await pool.query(
      'UPDATE device_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2',
      [(request.params as { id: string }).id, request.user!.id],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(request.user!.id, 'secret.device_revoked', (request.params as { id: string }).id);
    return { ok: true };
  });

  /**
   * The recipient's active devices, so the sender can encrypt once per device.
   * `safetyNumber` is a short fingerprint users can compare out of band to
   * detect a substituted key — the only real defence against the server
   * lying about who owns a key.
   */
  app.get('/api/secret/matches/:id/recipients', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;

    const { rows } = await pool.query(
      `SELECT dk.id, dk.public_key AS "publicKey", dk.label,
              substring(encode(digest(dk.public_key, 'sha256'), 'hex') from 1 for 12)
                AS "safetyNumber"
         FROM matches m
         JOIN profiles mine  ON mine.id IN (m.profile_a_id, m.profile_b_id) AND mine.user_id = $2
         JOIN profiles other ON other.id IN (m.profile_a_id, m.profile_b_id) AND other.id <> mine.id
         JOIN device_keys dk ON dk.user_id = other.user_id AND dk.revoked_at IS NULL
         JOIN users ou ON ou.id = other.user_id AND ou.status = 'active'
        WHERE m.id = $1 AND m.closed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = $2 AND b.blocked_id = other.user_id)
                OR (b.blocker_id = other.user_id AND b.blocked_id = $2)
          )`,
      [id, userId],
    );
    if (!rows.length) return reply.code(404).send({ error: 'no_recipient_devices' });
    return { recipients: rows };
  });

  /** Store one ciphertext per recipient device. Opaque to the server. */
  app.post(
    '/api/secret/matches/:id/messages',
    {
      schema: {
        body: {
          type: 'object',
          required: ['envelopes', 'senderPublicKey'],
          properties: {
            senderPublicKey: { type: 'string', maxLength: 512 },
            ttlSeconds: { type: ['integer', 'null'], minimum: 60, maximum: 604800 },
            envelopes: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                required: ['recipientDeviceId', 'ciphertext', 'iv'],
                properties: {
                  recipientDeviceId: { type: 'string', format: 'uuid' },
                  ciphertext: { type: 'string', maxLength: 20000 },
                  iv: { type: 'string', maxLength: 64 },
                },
              },
            },
          },
        },
      },
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { envelopes, senderPublicKey, ttlSeconds } = request.body as {
        envelopes: { recipientDeviceId: string; ciphertext: string; iv: string }[];
        senderPublicKey: string;
        ttlSeconds?: number | null;
      };
      const userId = request.user!.id;

      const { rows } = await pool.query<{ mine: string }>(
        `SELECT mine.id AS mine FROM matches m
           JOIN profiles mine ON mine.id IN (m.profile_a_id, m.profile_b_id) AND mine.user_id = $2
          WHERE m.id = $1 AND m.closed_at IS NULL`,
        [id, userId],
      );
      if (!rows.length) return reply.code(404).send({ error: 'not_found' });
      const myProfileId = rows[0]!.mine;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const env of envelopes) {
          await client.query(
            `INSERT INTO secret_messages
               (match_id, sender_profile_id, recipient_device_id, ciphertext, iv,
                sender_public_key, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6,
                     CASE WHEN $7::int IS NULL THEN NULL
                          ELSE now() + make_interval(secs => $7::int) END)`,
            [id, myProfileId, env.recipientDeviceId, env.ciphertext, env.iv, senderPublicKey, ttlSeconds ?? null],
          );
        }
        await client.query('UPDATE matches SET secret_mode = true WHERE id = $1', [id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return reply.code(201).send({ delivered: envelopes.length });
    },
  );

  /** Fetch and immediately delete: secret messages are not stored twice. */
  app.get('/api/secret/devices/:deviceKeyId/inbox', async (request, reply) => {
    const { deviceKeyId } = request.params as { deviceKeyId: string };
    const owned = await pool.query('SELECT 1 FROM device_keys WHERE id = $1 AND user_id = $2', [
      deviceKeyId,
      request.user!.id,
    ]);
    if (!owned.rowCount) return reply.code(404).send({ error: 'not_found' });

    await pool.query(
      'DELETE FROM secret_messages WHERE expires_at IS NOT NULL AND expires_at < now()',
    );

    const { rows } = await pool.query(
      `SELECT s.id, s.match_id AS "matchId", s.ciphertext, s.iv,
              s.sender_public_key AS "senderPublicKey",
              s.created_at AS "createdAt",
              p.display_name AS "senderName"
         FROM secret_messages s
         JOIN profiles p ON p.id = s.sender_profile_id
        WHERE s.recipient_device_id = $1
        ORDER BY s.created_at LIMIT 200`,
      [deviceKeyId],
    );
    return { messages: rows };
  });

  app.post('/api/secret/ack', {
    schema: {
      body: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: { type: 'array', maxItems: 200, items: { type: 'string', format: 'uuid' } },
        },
      },
    },
  }, async (request) => {
    const { ids } = request.body as { ids: string[] };
    // Deleted only after the client confirms it decrypted and stored them.
    const { rowCount } = await pool.query(
      `DELETE FROM secret_messages s USING device_keys d
        WHERE s.id = ANY($1::uuid[]) AND d.id = s.recipient_device_id AND d.user_id = $2`,
      [ids, request.user!.id],
    );
    return { deleted: rowCount ?? 0 };
  });
}
