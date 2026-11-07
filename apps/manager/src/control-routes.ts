import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ControlPlane, CreateServerInput } from './control-plane.js';
import { AdminAuth, type AdminSession } from './admin-auth.js';
import { ServerLogHub } from './server-log-hub.js';

const LoginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(1_024) }).strict();
const CreateServerSchema = z.object({
  name: z.string().trim().min(1).max(64),
  minecraftVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/),
  memoryMb: z.number().int().min(1_024).max(8_192).default(2_048),
  cpuLimit: z.number().min(1).max(8).default(2),
  acceptMinecraftEula: z.literal(true),
}).strict();
const ServerIdSchema = z.string().uuid();
const OperationIdSchema = z.string().uuid();
const IdempotencyKeySchema = z.string().uuid();

export interface ControlRouteOptions {
  controlPlane: ControlPlane;
  adminAuth: AdminAuth;
  logHub: ServerLogHub;
  workerId: string;
  dispatchPending: (workerId: string) => Promise<void>;
}

export function registerControlRoutes(app: FastifyInstance, options: ControlRouteOptions): void {
  const { controlPlane, adminAuth, logHub, workerId, dispatchPending } = options;

  app.get('/', async (_request, reply) => {
    const html = await readFile(new URL('../../web/public/index.html', import.meta.url), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/api/v1/auth/session', async (request) => {
    const session = adminAuth.authenticate(request.headers.cookie);
    return session ? { authenticated: true, email: session.email } : { authenticated: false };
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = LoginSchema.safeParse(request.body);
    if (!body.success || !originAllowed(request, adminAuth)) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    }
    const result = await adminAuth.login(body.data.email, body.data.password, request.ip);
    if (!result) return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS' } });
    reply.header('set-cookie', adminAuth.cookie(result.token, result.session.expiresAt));
    return reply.send({ email: result.account.email });
  });

  app.get('/api/v1/auth/csrf', async (request, reply) => {
    const session = requireSession(request, reply, adminAuth);
    return session ? { csrfToken: session.csrfToken } : undefined;
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const session = requireSession(request, reply, adminAuth);
    if (!session || !requireCsrf(request, reply, adminAuth, session)) return undefined;
    adminAuth.remove(session);
    reply.header('set-cookie', adminAuth.clearCookie());
    return reply.send({ loggedOut: true });
  });

  app.get('/api/v1/servers', async (request, reply) => {
    const session = requireSession(request, reply, adminAuth);
    if (!session) return undefined;
    try {
      return { servers: await controlPlane.listServers(workerId) };
    } catch (error) {
      return serverError(app, reply, error);
    }
  });

  app.post('/api/v1/servers', async (request, reply) => {
    const session = requireSession(request, reply, adminAuth);
    if (!session || !requireCsrf(request, reply, adminAuth, session)) return undefined;
    const body = CreateServerSchema.safeParse(request.body);
    const idempotencyKey = IdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!body.success || !idempotencyKey.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    const input: CreateServerInput = {
      name: body.data.name,
      minecraftVersion: body.data.minecraftVersion,
      memoryMb: body.data.memoryMb,
      cpuLimit: body.data.cpuLimit,
      eulaAccepted: true,
    };
    try {
      const result = await controlPlane.createServer(workerId, session.accountId, idempotencyKey.data, input);
      await dispatchPending(workerId);
      return reply.code(202).send(result);
    } catch (error) {
      return serverError(app, reply, error);
    }
  });

  app.get<{ Params: { serverId: string } }>('/api/v1/servers/:serverId', async (request, reply) => {
    const session = requireSession(request, reply, adminAuth);
    if (!session) return undefined;
    const serverId = ServerIdSchema.safeParse(request.params.serverId);
    if (!serverId.success) return reply.code(404).send({ error: { code: 'SERVER_NOT_FOUND' } });
    try {
      const server = await controlPlane.getServer(serverId.data);
      return server ? server : reply.code(404).send({ error: { code: 'SERVER_NOT_FOUND' } });
    } catch (error) {
      return serverError(app, reply, error);
    }
  });

  for (const [action, desiredState] of [['start', 'RUNNING'], ['stop', 'STOPPED']] as const) {
    app.post<{ Params: { serverId: string } }>(`/api/v1/servers/:serverId/${action}`, async (request, reply) => {
      const session = requireSession(request, reply, adminAuth);
      if (!session || !requireCsrf(request, reply, adminAuth, session)) return undefined;
      const serverId = ServerIdSchema.safeParse(request.params.serverId);
      const idempotencyKey = IdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
      if (!serverId.success || !idempotencyKey.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
      try {
        const operation = await controlPlane.requestServerState(serverId.data, session.accountId, idempotencyKey.data, desiredState);
        await dispatchPending(workerId);
        return reply.code(202).send({ operation });
      } catch (error) {
        return serverError(app, reply, error);
      }
    });
  }

  app.delete<{ Params: { serverId: string } }>('/api/v1/servers/:serverId', async (request, reply) => {
    const session = requireSession(request, reply, adminAuth);
    if (!session || !requireCsrf(request, reply, adminAuth, session)) return undefined;
    const serverId = ServerIdSchema.safeParse(request.params.serverId);
    const idempotencyKey = IdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    const body = z.object({ deleteWorld: z.boolean().default(false) }).strict().safeParse(request.body);
    if (!serverId.success || !idempotencyKey.success || !body.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    try {
      const operation = await controlPlane.requestServerDelete(serverId.data, session.accountId, idempotencyKey.data, body.data.deleteWorld);
      await dispatchPending(workerId);
      return reply.code(202).send({ operation });
    } catch (error) {
      return serverError(app, reply, error);
    }
  });

  app.get<{ Params: { serverId: string } }>('/api/v1/servers/:serverId/operations', async (request, reply) => {
    const session = requireSession(request, reply, adminAuth);
    if (!session) return undefined;
    const serverId = ServerIdSchema.safeParse(request.params.serverId);
    if (!serverId.success) return reply.code(404).send({ error: { code: 'SERVER_NOT_FOUND' } });
    try {
      if (!(await controlPlane.getServer(serverId.data))) return reply.code(404).send({ error: { code: 'SERVER_NOT_FOUND' } });
      return { operations: await controlPlane.listOperations(serverId.data) };
    } catch (error) {
      return serverError(app, reply, error);
    }
  });

  app.get<{ Params: { operationId: string } }>('/api/v1/operations/:operationId', async (request, reply) => {
    const session = requireSession(request, reply, adminAuth);
    if (!session) return undefined;
    const operationId = OperationIdSchema.safeParse(request.params.operationId);
    if (!operationId.success) return reply.code(404).send({ error: { code: 'OPERATION_NOT_FOUND' } });
    try {
      const operation = await controlPlane.getOperation(operationId.data);
      return operation ? { operation } : reply.code(404).send({ error: { code: 'OPERATION_NOT_FOUND' } });
    } catch (error) {
      return serverError(app, reply, error);
    }
  });

  app.get<{ Params: { serverId: string } }>('/api/v1/servers/:serverId/logs', async (request, reply) => {
    const session = requireSession(request, reply, adminAuth);
    if (!session) return undefined;
    const serverId = ServerIdSchema.safeParse(request.params.serverId);
    if (!serverId.success) return reply.code(404).send({ error: { code: 'SERVER_NOT_FOUND' } });
    try {
      if (!(await controlPlane.getServer(serverId.data))) return reply.code(404).send({ error: { code: 'SERVER_NOT_FOUND' } });
    } catch (error) {
      return serverError(app, reply, error);
    }
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    response.write(': connected\n\n');
    const unsubscribe = logHub.subscribe(serverId.data, (event) => {
      if (!response.destroyed) response.write(`event: log\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
    request.raw.once('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      response.end();
    });
  });
}

function requireSession(request: FastifyRequest, reply: FastifyReply, adminAuth: AdminAuth): AdminSession | null {
  const session = adminAuth.authenticate(request.headers.cookie);
  if (!session) {
    reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    return null;
  }
  return session;
}

function requireCsrf(request: FastifyRequest, reply: FastifyReply, adminAuth: AdminAuth, session: AdminSession): boolean {
  const csrfHeader = request.headers['x-craftdock-csrf'];
  const csrfToken = typeof csrfHeader === 'string' ? csrfHeader : undefined;
  if (!adminAuth.validateMutation(session, request.headers.origin, csrfToken)) {
    reply.code(403).send({ error: { code: 'CSRF_REJECTED' } });
    return false;
  }
  return true;
}

function originAllowed(request: FastifyRequest, adminAuth: AdminAuth): boolean {
  return adminAuth.isAllowedOrigin(request.headers.origin);
}

function serverError(app: FastifyInstance, reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : 'UNEXPECTED_ERROR';
  const response = {
    SERVER_NOT_FOUND: [404, 'SERVER_NOT_FOUND'],
    OPERATION_IN_PROGRESS: [409, 'OPERATION_IN_PROGRESS'],
    IDEMPOTENCY_KEY_CONFLICT: [409, 'IDEMPOTENCY_KEY_CONFLICT'],
    PORT_RANGE_EXHAUSTED: [503, 'PORT_RANGE_EXHAUSTED'],
    SERVER_NOT_RUNNING: [409, 'SERVER_NOT_RUNNING'],
  } as const;
  const known = code in response ? response[code as keyof typeof response] : null;
  if (known) return reply.code(known[0]).send({ error: { code: known[1] } });
  app.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Control plane request failed');
  return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
}
