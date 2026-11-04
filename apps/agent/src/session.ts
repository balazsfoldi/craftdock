import { randomUUID } from 'node:crypto';
import os from 'node:os';
import {
  AgentAuthenticateSchema,
  AgentHeartbeatSchema,
  ManagerAuthResultSchema,
  ManagerMessageSchema,
  PROTOCOL_VERSION,
} from '@craftdock/protocol';
import type { HostCapabilities, ManagerMessage } from '@craftdock/protocol';
import type { Logger } from 'pino';
import WebSocket from 'ws';
import type { AgentConfig } from './config.js';

const MAX_MESSAGE_BYTES = 16 * 1024;

export function readRuntimeCapabilities(): HostCapabilities {
  return {
    platform: os.platform(),
    architecture: os.arch(),
    cpuCores: Math.max(1, os.cpus().length),
    totalMemoryBytes: os.totalmem(),
  };
}

export function runAgentSession(
  config: AgentConfig,
  logger: Logger,
  signal: AbortSignal,
  markConnected: () => void,
): Promise<void> {
  const socket = new WebSocket(config.managerWsUrl, {
    handshakeTimeout: config.connectionTimeoutMs,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  return new Promise((resolve, reject) => {
    let authenticated = false;
    let settled = false;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let authTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (authTimer) {
        clearTimeout(authTimer);
      }
      signal.removeEventListener('abort', abortSession);
    };

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1008, 'Agent session ended');
        }
        reject(error);
      } else {
        resolve();
      }
    };

    const abortSession = (): void => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1001, 'Agent shutting down');
      }
      finish();
    };

    const sendHeartbeat = (): void => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const heartbeat = AgentHeartbeatSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        messageId: randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'agent.heartbeat',
        workerId: config.workerId,
      });
      socket.send(JSON.stringify(heartbeat));
    };

    socket.once('open', () => {
      const authentication = AgentAuthenticateSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        messageId: randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'agent.authenticate',
        workerId: config.workerId,
        credential: config.workerToken,
        agentVersion: '0.1.0',
        capabilities: readRuntimeCapabilities(),
      });
      socket.send(JSON.stringify(authentication));
      authTimer = setTimeout(
        () => finish(new Error('Authentication response timed out')),
        config.connectionTimeoutMs,
      );
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        finish(new Error('Manager sent an unsupported binary message'));
        socket.close(1003, 'Text messages required');
        return;
      }

      let raw: unknown;
      try {
        const payload = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        raw = JSON.parse(payload.toString('utf8')) as unknown;
      } catch {
        finish(new Error('Manager sent invalid JSON'));
        socket.close(1007, 'Invalid JSON');
        return;
      }

      if (!authenticated) {
        const result = ManagerAuthResultSchema.safeParse(raw);
        if (!result.success || !result.data.accepted) {
          finish(new Error('Manager rejected worker authentication'));
          socket.close(1008, 'Authentication rejected');
          return;
        }
        if (result.data.workerId !== config.workerId) {
          finish(new Error('Manager authenticated a different worker identity'));
          socket.close(1008, 'Worker identity mismatch');
          return;
        }

        authenticated = true;
        if (authTimer) {
          clearTimeout(authTimer);
          authTimer = null;
        }
        markConnected();
        logger.info({ workerId: config.workerId, agentVersion: '0.1.0' }, 'Connected to Manager');
        heartbeatTimer = setInterval(sendHeartbeat, result.data.heartbeatIntervalMs);
        sendHeartbeat();
        return;
      }

      const message = ManagerMessageSchema.safeParse(raw);
      if (!message.success) {
        finish(new Error('Manager sent an invalid protocol message'));
        socket.close(1008, 'Invalid protocol message');
        return;
      }
      handleManagerMessage(message.data, logger, config.workerId, finish);
    });

    socket.once('close', () => {
      if (authenticated) {
        finish();
      } else {
        finish(new Error('Manager connection closed before authentication'));
      }
    });

    socket.once('error', (error) => {
      finish(new Error(error.name || 'WebSocketError'));
    });

    signal.addEventListener('abort', abortSession, { once: true });
    if (signal.aborted) {
      abortSession();
    }
  });
}

function handleManagerMessage(
  message: ManagerMessage,
  logger: Logger,
  workerId: string,
  finish: (error?: Error) => void,
): void {
  switch (message.type) {
    case 'manager.heartbeat-ack':
      if (message.workerId !== workerId) {
        finish(new Error('Manager heartbeat acknowledgement had a worker identity mismatch'));
      }
      break;
    case 'manager.error':
      logger.warn({ workerId, code: message.code }, 'Manager rejected an Agent message');
      finish(new Error(`Manager protocol error: ${message.code}`));
      break;
    case 'manager.auth-result':
      finish(new Error('Manager sent an unexpected authentication result'));
      break;
  }
}
