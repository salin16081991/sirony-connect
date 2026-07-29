import { pool } from '../db.js';

/**
 * Append-only audit trail (PRD §6, §8). Deliberately records *what* changed
 * and never the content involved — no message bodies, no report free-text, no
 * IP addresses. The trail exists for accountability, not surveillance.
 */
export async function audit(
  actorId: string | null,
  action: string,
  subject?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    'INSERT INTO audit_events (actor_id, action, subject, metadata) VALUES ($1, $2, $3, $4)',
    [actorId, action, subject ?? null, JSON.stringify(metadata)],
  );
}
