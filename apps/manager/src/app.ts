import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import {
  AgentAuthenticateSchema,
  AgentHeartbeatSchema,
  HostCapabilitiesSchema,
  ManagerMessageSchema,
  PROTOCOL_VERSION,
} from '@craftdock/protocol';
import type { HostCapabilities } from '@craftdock/protocol';
import { z } from 'zod';
import type { RawData, WebSocket } from 'ws';
import type { ManagerConfig } from './config.js';
import { WorkerRegistry } from './worker-registry.js';

interface ActiveSession {
  sessionId: string;
  socket: WebSocket;
}

interface BuildManagerOptions {
  now?: () => number;
  monotonicNow?: () => number;
  enableHeartbeatSweep?: boolean;
}

export interface ManagerRuntime {
  app: FastifyInstance;
  registry: WorkerRegistry;
}

const WorkerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const MAX_MESSAGE_BYTES = 16 * 1024;

function constantTimeTokenEquals(candidate: string, expected: string): boolean {
  const candidateHash = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function decodeFrame(data: RawData): unknown {
  let text: string;
  if (Array.isArray(data)) {
    text = Buffer.concat(data).toString('utf8');
  } else if (Buffer.isBuffer(data)) {
    text = data.toString('utf8');
  } else {
    text = Buffer.from(data).toString('utf8');
  }

  return JSON.parse(text) as unknown;
}

function sendMessage(socket: WebSocket, value: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(value));
  }
}

function hostCapabilities(value: unknown): HostCapabilities | null {
  const parsed = HostCapabilitiesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildManagerApp(
  config: ManagerConfig,
  options: BuildManagerOptions = {},
): ManagerRuntime {
  const now = options.now ?? Date.now;
  const registry = new WorkerRegistry(config.workerId, now, options.monotonicNow);
  const activeSessions = new Map<string, ActiveSession>();
  const app = Fastify({ logger: { level: config.logLevel } });

  void app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/api/v1/workers', async () => ({ workers: [registry.snapshot()] }));

  app.get<{ Params: { workerId: string } }>('/api/v1/workers/:workerId', async (request, reply) => {
    const parsed = WorkerIdSchema.safeParse(request.params.workerId);
    if (!parsed.success || parsed.data !== config.workerId) {
      return reply.code(404).send({ error: { code: 'WORKER_NOT_FOUND' } });
    }
    return registry.snapshot();
  });

  app.register(async function registerAgentWebSocketRoutes(fastify) {
    fastify.get('/api/v1/agent', { websocket: true }, (socket, request) => {
      let authenticated = false;
      let workerId: string | null = null;
      let sessionId: string | null = null;

      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          socket.close(1008, 'Authentication required');
        }
      }, config.authTimeoutMs);

      const rejectMessage = (code: 'INVALID_MESSAGE' | 'UNAUTHORIZED' | 'WORKER_MISMATCH') => {
        const message = {
          type: 'manager.error',
          ...metadata(now),
          code,
          message:
            code === 'UNAUTHORIZED'
              ? 'Worker authentication failed.'
              : code === 'WORKER_MISMATCH'
                ? 'Message worker identity does not match this connection.'
                : 'Message is invalid for the current protocol state.',
        };
        sendMessage(socket, ManagerMessageSchema.parse(message));
        socket.close(1008, 'Protocol error');
      };

      socket.on('message', (data, isBinary) => {
        if (socket.readyState !== socket.OPEN) {
          return;
        }

        if (isBinary) {
          rejectMessage('INVALID_MESSAGE');
          return;
        }

        let rawMessage: unknown;
        try {
          rawMessage = decodeFrame(data);
        } catch {
          rejectMessage('INVALID_MESSAGE');
          return;
        }

        if (!authenticated) {
          const authentication = AgentAuthenticateSchema.safeParse(rawMessage);
          if (!authentication.success) {
            sendMessage(
              socket,
              ManagerMessageSchema.parse({
                type: 'manager.auth-result',
                ...metadata(now),
                accepted: false,
                workerId: config.workerId,
                heartbeatIntervalMs: config.heartbeatIntervalMs,
                errorCode: 'INVALID_MESSAGE',
              }),
            );
            socket.close(1008, 'Invalid authentication message');
            return;
          }

          const auth = authentication.data;
          const validCredential =
            auth.workerId === config.workerId &&
            constantTimeTokenEquals(auth.credential, config.workerToken);
          if (!validCredential) {
            sendMessage(
              socket,
              ManagerMessageSchema.parse({
                type: 'manager.auth-result',
                ...metadata(now),
                accepted: false,
                workerId: config.workerId,
                heartbeatIntervalMs: config.heartbeatIntervalMs,
                errorCode: 'UNAUTHORIZED',
              }),
            );
            socket.close(1008, 'Worker authentication failed');
            return;
          }

          const capabilities = hostCapabilities(auth.capabilities);
          if (!capabilities) {
            rejectMessage('INVALID_MESSAGE');
            return;
          }

          workerId = auth.workerId;
          sessionId = registry.register({
            workerId,
            agentVersion: auth.agentVersion,
            capabilities,
          });
          if (!sessionId) {
            rejectMessage('UNAUTHORIZED');
            return;
          }

          const previousSession = activeSessions.get(workerId);
          activeSessions.set(workerId, { sessionId, socket });
          if (previousSession && previousSession.socket !== socket) {
            previousSession.socket.close(4001, 'Replaced by a newer worker connection');
          }

          authenticated = true;
          clearTimeout(authTimeout);
          app.log.info({ workerId, agentVersion: auth.agentVersion }, 'Worker connected');
          sendMessage(
            socket,
            ManagerMessageSchema.parse({
              type: 'manager.auth-result',
              ...metadata(now),
              accepted: true,
              workerId,
              heartbeatIntervalMs: config.heartbeatIntervalMs,
            }),
          );
          return;
        }

        const heartbeat = AgentHeartbeatSchema.safeParse(rawMessage);
        if (!heartbeat.success) {
          rejectMessage('INVALID_MESSAGE');
          return;
        }
        if (heartbeat.data.workerId !== workerId || sessionId === null || workerId === null) {
          rejectMessage('WORKER_MISMATCH');
          return;
        }
        if (!registry.recordHeartbeat(workerId, sessionId)) {
          rejectMessage('WORKER_MISMATCH');
          return;
        }

        sendMessage(
          socket,
          ManagerMessageSchema.parse({
            type: 'manager.heartbeat-ack',
            ...metadata(now),
            workerId,
            receivedMessageId: heartbeat.data.messageId,
          }),
        );
      });

      socket.on('close', () => {
        clearTimeout(authTimeout);
        if (workerId !== null && sessionId !== null) {
          registry.disconnect(workerId, sessionId);
          const active = activeSessions.get(workerId);
          if (active?.sessionId === sessionId) {
            activeSessions.delete(workerId);
            app.log.info({ workerId }, 'Worker disconnected');
          }
        }
      });

      socket.on('error', (error) => {
        request.log.warn({ workerId, errorName: error.name }, 'Worker WebSocket error');
      });
    });
  });

  const sweepTimer =
    options.enableHeartbeatSweep === false
      ? null
      : setInterval(() => {
          const expiredSessionId = registry.expireIfStale(config.workerTimeoutMs);
          if (!expiredSessionId) {
            return;
          }

          for (const [workerId, active] of activeSessions) {
            if (active.sessionId === expiredSessionId) {
              activeSessions.delete(workerId);
              active.socket.close(4000, 'Worker heartbeat timed out');
              app.log.warn({ workerId }, 'Worker marked offline after heartbeat timeout');
              break;
            }
          }
        }, config.heartbeatSweepIntervalMs);

  app.addHook('onClose', async () => {
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
    }
    for (const active of activeSessions.values()) {
      active.socket.close(1001, 'Manager shutting down');
    }
    activeSessions.clear();
  });

  return { app, registry };
}

function metadata(now: () => number): {
  protocolVersion: typeof PROTOCOL_VERSION;
  messageId: string;
  timestamp: string;
} {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: randomUUID(),
    timestamp: new Date(now()).toISOString(),
  };
}
