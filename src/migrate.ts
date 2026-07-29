import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db.js';

/**
 * Applies db/migrations/*.sql in filename order, exactly once each.
 *
 * Runs automatically at startup so a deployment can never end up with a
 * running app and no tables — previously that required a manual step and was
 * the easiest thing in the whole deploy to forget.
 *
 * Each file runs inside a transaction together with its bookkeeping row, so a
 * failure leaves nothing half-applied.
 */
export async function migrate(log: {
  info: (msg: string) => void;
  error: (msg: string) => void;
}): Promise<void> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    log.info('no migrations directory; skipping');
    return;
  }

  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log.info(`applied migration ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      log.error(`migration ${file} failed: ${(error as Error).message}`);
      throw error;
    } finally {
      client.release();
    }
  }
}
