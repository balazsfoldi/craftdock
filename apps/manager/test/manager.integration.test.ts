import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { buildManagerApp } from '../src/app.js';
import type { ManagerConfig } from '../src/config.js';

const workerToken = 'test-worker-token-that-is-at-least-32-characters-long';
const capabilities = {
  platform: 'linux',
  architecture: 'x64',
  cpuCores: 4,
  totalMemoryBytes: 8_000_000_000,
};

function createConfig(): ManagerConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    workerId: 'worker-01',
    workerToken,
    heartbeatIntervalMs: 10_000,
    workerTimeoutMs: 45_000,
    heartbeatSweepIntervalMs: 5_000,
    authTimeoutMs: 5_000,
    logLevel: 'silent',
  };
}

function waitForMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data, isBinary) => {
      if (isBinary) {
        reject(new Error('Expected a text protocol message'));
        return;
      }
      try {
        resolve(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.close();
  await closed;
}

describe('Manager worker API and protocol', () => {
  let now: number;
  let monotonicNow: number;
  let runtime: ReturnType<typeof buildManagerApp>;
  let managerUrl: string;
  let managerHttpUrl: string;

  beforeEach(async () => {
    now = Date.parse('2026-11-04T10:00:00.000Z');
    monotonicNow = 100_000;
    runtime = buildManagerApp(createConfig(), {
      now: () => now,
      monotonicNow: () => monotonicNow,
      enableHeartbeatSweep: false,
    });
    await runtime.app.listen({ host: '127.0.0.1', port: 0 });
    const address = runtime.app.server.address() as AddressInfo;
    managerUrl = `ws://127.0.0.1:${address.port}/api/v1/agent`;
    managerHttpUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await runtime.app.close();
  });

  test('authenticates the configured worker, acknowledges heartbeats, and exposes status', async () => {
    const before = await fetch(`${managerHttpUrl}/api/v1/workers`);
    expect(await before.json()).toMatchObject({
      workers: [{ workerId: 'worker-01', status: 'OFFLINE' }],
    });

    const socket = await openSocket(managerUrl);
    const authResponse = waitForMessage(socket);
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        timestamp: new Date(now).toISOString(),
        type: 'agent.authenticate',
        workerId: 'worker-01',
        credential: workerToken,
        agentVersion: '0.1.0',
        capabilities,
      }),
    );
    expect(await authResponse).toMatchObject({ type: 'manager.auth-result', accepted: true });

    now += 2_000;
    monotonicNow += 2_000;
    const heartbeatId = randomUUID();
    const heartbeatPayload = JSON.stringify({
      protocolVersion: 1,
      messageId: heartbeatId,
      timestamp: new Date(now).toISOString(),
      type: 'agent.heartbeat',
      workerId: 'worker-01',
    });
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const heartbeatAck = waitForMessage(socket);
      socket.send(heartbeatPayload);
      expect(await heartbeatAck).toMatchObject({
        type: 'manager.heartbeat-ack',
        receivedMessageId: heartbeatId,
      });
    }

    const online = await fetch(`${managerHttpUrl}/api/v1/workers/worker-01`);
    expect(await online.json()).toMatchObject({
      workerId: 'worker-01',
      status: 'ONLINE',
      lastSeenAt: new Date(now).toISOString(),
    });

    now += 45_001;
    monotonicNow += 45_001;
    expect(runtime.registry.expireIfStale(45_000)).not.toBeNull();
    const offline = await fetch(`${managerHttpUrl}/api/v1/workers/worker-01`);
    expect(await offline.json()).toMatchObject({ workerId: 'worker-01', status: 'OFFLINE' });
    await closeSocket(socket);
  });

  test('rejects invalid credentials without echoing the credential', async () => {
    const socket = await openSocket(managerUrl);
    const authResponse = waitForMessage(socket);
    const invalidCredential = 'wrong-worker-secret-that-is-32-characters';
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        timestamp: new Date(now).toISOString(),
        type: 'agent.authenticate',
        workerId: 'worker-01',
        credential: invalidCredential,
        agentVersion: '0.1.0',
        capabilities,
      }),
    );
    const response = await authResponse;
    expect(response).toMatchObject({
      type: 'manager.auth-result',
      accepted: false,
      errorCode: 'UNAUTHORIZED',
    });
    expect(JSON.stringify(response)).not.toContain(invalidCredential);
    expect(runtime.registry.snapshot().status).toBe('OFFLINE');
    await closeSocket(socket);
  });

  test('rejects messages with an unsupported protocol version', async () => {
    const socket = await openSocket(managerUrl);
    const responsePromise = waitForMessage(socket);
    socket.send(
      JSON.stringify({
        protocolVersion: 9,
        messageId: randomUUID(),
        timestamp: new Date(now).toISOString(),
        type: 'agent.authenticate',
        workerId: 'worker-01',
        credential: workerToken,
        agentVersion: '0.1.0',
        capabilities,
      }),
    );
    expect(await responsePromise).toMatchObject({
      type: 'manager.auth-result',
      accepted: false,
      errorCode: 'INVALID_MESSAGE',
    });
    expect(runtime.registry.snapshot().status).toBe('OFFLINE');
    await closeSocket(socket);
  });
});
