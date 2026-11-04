import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { buildManagerApp, type ManagerRuntime } from '../../manager/src/app.js';
import type { ManagerConfig } from '../../manager/src/config.js';
import type { AgentConfig } from '../src/config.js';
import { runWithReconnect } from '../src/reconnect.js';
import { runAgentSession } from '../src/session.js';

const workerToken = 'test-worker-token-that-is-at-least-32-characters-long';
function managerConfig(): ManagerConfig {
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

describe('Agent session integration', () => {
  const createdManagers: ManagerRuntime[] = [];
  const closedManagers = new Set<ManagerRuntime>();
  let controller: AbortController | null = null;
  let agentLoop: Promise<void> | null = null;

  afterEach(async () => {
    controller?.abort();
    for (const manager of createdManagers) {
      if (!closedManagers.has(manager)) {
        await manager.app.close();
        closedManagers.add(manager);
      }
    }
    if (agentLoop) {
      await agentLoop;
    }
    createdManagers.length = 0;
    closedManagers.clear();
    controller = null;
    agentLoop = null;
  });

  test('authenticates, heartbeats, and reconnects after the Manager restarts', async () => {
    const firstManager = buildManagerApp(managerConfig(), { enableHeartbeatSweep: false });
    createdManagers.push(firstManager);
    await firstManager.app.listen({ host: '127.0.0.1', port: 0 });
    const firstAddress = firstManager.app.server.address() as AddressInfo;
    const managerUrl = `ws://127.0.0.1:${firstAddress.port}/api/v1/agent`;
    const agentConfig: AgentConfig = {
      nodeEnv: 'test',
      managerWsUrl: managerUrl,
      workerId: 'worker-01',
      workerToken,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 100,
      connectionTimeoutMs: 1_000,
      logLevel: 'silent',
    };

    const firstConnection = deferred<void>();
    const secondConnection = deferred<void>();
    let connectionCount = 0;
    const agentController = new AbortController();
    controller = agentController;
    agentLoop = runWithReconnect(
      (markConnected) =>
        runAgentSession(agentConfig, pino({ level: 'silent' }), agentController.signal, () => {
          connectionCount += 1;
          markConnected();
          if (connectionCount === 1) {
            firstConnection.resolve(undefined);
          } else if (connectionCount === 2) {
            secondConnection.resolve(undefined);
          }
        }),
      {
        signal: agentController.signal,
        baseDelayMs: 10,
        maxDelayMs: 100,
        random: () => 0.5,
      },
    );

    await firstConnection.promise;
    expect(firstManager.registry.snapshot()).toMatchObject({
      workerId: 'worker-01',
      status: 'ONLINE',
    });

    await firstManager.app.close();
    closedManagers.add(firstManager);

    const restartedManager = buildManagerApp(managerConfig(), { enableHeartbeatSweep: false });
    createdManagers.push(restartedManager);
    await restartedManager.app.listen({ host: '127.0.0.1', port: firstAddress.port });
    await secondConnection.promise;
    expect(restartedManager.registry.snapshot()).toMatchObject({
      workerId: 'worker-01',
      status: 'ONLINE',
    });

    agentController.abort();
    await agentLoop;
  });
});

function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
