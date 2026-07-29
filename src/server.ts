import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import { config, isProduction } from './config.js';
import { closePool } from './db.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { profileRoutes } from './routes/profiles.js';
import { discoveryRoutes } from './routes/discovery.js';
import { connectionRoutes } from './routes/connections.js';
import { privacyRoutes } from './routes/privacy.js';

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

await app.register(healthRoutes);
await app.register(authRoutes);
await app.register(profileRoutes);
await app.register(discoveryRoutes);
await app.register(connectionRoutes);
await app.register(privacyRoutes);

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

await app.register(fastifyStatic, {
  root: publicDir,
  index: ['index.html'],
  // The plugin writes its own Cache-Control after setHeaders runs, so disable
  // it and set the header explicitly below.
  cacheControl: false,
  setHeaders(res, path) {
    if (path.endsWith('/sw.js') || path.endsWith('.html')) {
      // Must revalidate every load: a stale service worker or shell can pin
      // users to an old app version indefinitely.
      res.setHeader('Cache-Control', 'no-cache');
    } else if (path.includes('/icons/')) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
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

// Domain routes are not scaffolded yet — they follow from the PRD.

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
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
