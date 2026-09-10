import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { config, isProduction } from './config.js';
import { closePool } from './db.js';
import { migrate } from './migrate.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { profileRoutes } from './routes/profiles.js';
import { discoveryRoutes } from './routes/discovery.js';
import { connectionRoutes } from './routes/connections.js';
import { privacyRoutes } from './routes/privacy.js';
import { messageRoutes } from './routes/messages.js';
import { communityRoutes } from './routes/community.js';
import { moderationRoutes, appealRoutes } from './routes/moderation.js';
import { mediaRoutes } from './routes/media.js';
import { socialRoutes } from './routes/social.js';
import { secretRoutes } from './routes/secret.js';
import { adminRoutes, whoamiRoutes } from './routes/admin.js';
import {
  LIMITS,
  ensureMediaRoot,
  loadSigningKey,
  sweepExpiredMedia,
} from './lib/media-store.js';

const app = Fastify({
  trustProxy: config.trustProxy,
  logger: {
    level: config.logLevel,
    /**
     * Privacy-first: request logs must not carry credentials or bearer tokens.
     * Client IPs are intentionally omitted from the serialiser below.
     */
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req(request) {
        return { method: request.method, url: request.url };
      },
    },
  },
});

await app.register(helmet, {
  // Everything the PWA loads is first-party, so the policy can stay tight.
  // 'unsafe-inline' is deliberately absent — keep it that way.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      ...(isProduction ? { upgradeInsecureRequests: [] } : {}),
    },
  },
});

await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

await app.register(cookie);

await app.register(multipart, {
  limits: { fileSize: LIMITS.uploadBytes, files: 1 },
});

await app.register(healthRoutes);
await app.register(authRoutes);
await app.register(profileRoutes);
await app.register(discoveryRoutes);
await app.register(connectionRoutes);
await app.register(privacyRoutes);
await app.register(messageRoutes);
await app.register(communityRoutes);
await app.register(moderationRoutes);
await app.register(appealRoutes);
await app.register(mediaRoutes);
await app.register(socialRoutes);
await app.register(secretRoutes);
await app.register(adminRoutes);
await app.register(whoamiRoutes);

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * The service worker's cache name is stamped per process start rather than
 * hand-bumped in the source. A forgotten bump meant a deploy could leave
 * returning browsers on the previous shell for one extra load; now every
 * deploy (or restart) yields a new SW byte-for-byte, which triggers install,
 * precache and the controllerchange reload the client already handles.
 */
const BUILD_STAMP = Date.now().toString(36);
const swSource = await readFile(join(publicDir, 'sw.js'), 'utf8');
app.get('/sw.js', async (_request, reply) =>
  reply
    .type('application/javascript; charset=utf-8')
    .header('Cache-Control', 'no-cache')
    .send(swSource.replace(/const VERSION = '[^']*';/, `const VERSION = '${BUILD_STAMP}';`)),
);

await app.register(fastifyStatic, {
  root: publicDir,
  index: ['index.html'],
  // The plugin writes its own Cache-Control after setHeaders runs, so disable
  // it and set the header explicitly below.
  cacheControl: false,
  setHeaders(res, path) {
    if (path.includes('/icons/')) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else {
      // Everything else revalidates on every load. With ETags that is a cheap
      // 304, and it means a deploy reaches returning users immediately. The
      // previous max-age=3600 let the browser — and the service worker's
      // precache, which reads through the HTTP cache — hold old JS and CSS
      // for an hour after a deploy while index.html was already new.
      // Instant loads come from the service worker, not from the HTTP cache.
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
});

// SPA fallback: unknown non-API GETs return the shell so client-side routing
// works on a hard refresh. API 404s stay JSON.
app.setNotFoundHandler((request, reply) => {
  if (request.method === 'GET' && !request.url.startsWith('/api/')) {
    return reply.type('text/html').sendFile('index.html');
  }
  return reply.code(404).send({ error: 'not_found' });
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await closePool();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  // Schema first: refuse to serve rather than come up against a database the
  // app cannot actually use.
  await migrate({
    info: (msg) => app.log.info(msg),
    error: (msg) => app.log.error(msg),
  });
  await ensureMediaRoot();
  await loadSigningKey();

  // Retention is a promise, so expired media is swept on a timer rather than
  // only when someone happens to look at it.
  const sweeper = setInterval(
    () => void sweepExpiredMedia((msg) => app.log.info(msg)).catch((err) =>
      app.log.error({ err }, 'media sweep failed'),
    ),
    15 * 60 * 1000,
  );
  sweeper.unref();
  await sweepExpiredMedia((msg) => app.log.info(msg));

  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
