import type { FastifyInstance } from 'fastify';
import { pingDatabase } from '../db.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness: is the process up? Never touches the database. */
  app.get('/healthz', async () => ({ status: 'ok' }));

  /** Readiness: can we actually serve traffic? Used by the Docker healthcheck. */
  app.get('/readyz', async (_request, reply) => {
    try {
      await pingDatabase();
      return { status: 'ready' };
    } catch (error) {
      app.log.error({ err: error }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
