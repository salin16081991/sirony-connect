function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  /** Port inside the container. The host mapping lives in docker-compose.yml. */
  port: Number(optional('PORT', '3000')),
  host: '0.0.0.0',
  logLevel: optional('LOG_LEVEL', 'info'),
  databaseUrl: required('DATABASE_URL'),
  /** Public origin, used for absolute URLs, CORS and cookie scoping. */
  publicOrigin: optional('PUBLIC_ORIGIN', 'https://connect.sirony.in'),
  /**
   * The app sits behind a host-level reverse proxy that terminates TLS, so
   * Fastify must read X-Forwarded-* to see the real protocol and client IP.
   */
  trustProxy: optional('TRUST_PROXY', 'true') === 'true',
} as const;

export const isProduction = config.env === 'production';
