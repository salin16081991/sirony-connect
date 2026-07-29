import pg from 'pg';
import { config } from './config.js';

/**
 * Postgres is reachable only on the project-internal Docker network, so no TLS
 * is configured here. If the database is ever moved off-box that must change.
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function pingDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
