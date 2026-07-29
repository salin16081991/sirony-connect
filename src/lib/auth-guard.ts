import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, resolveSession, type SessionUser } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

/** Attaches the session user when present. Never rejects. */
export async function loadUser(request: FastifyRequest): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  const user = await resolveSession(token);
  if (user) request.user = user;
}

/** Route guard: use as an onRequest/preHandler hook. */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await loadUser(request);
  if (!request.user) {
    await reply.code(401).send({ error: 'authentication_required' });
  }
}
