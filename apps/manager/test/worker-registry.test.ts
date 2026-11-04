import { WorkerRegistry } from '../src/worker-registry.js';

const capabilities = {
  platform: 'linux',
  architecture: 'x64',
  cpuCores: 4,
  totalMemoryBytes: 8_000_000_000,
};

describe('WorkerRegistry', () => {
  test('starts offline, registers an authenticated worker, and records heartbeats', () => {
    let now = Date.parse('2026-11-04T10:00:00.000Z');
    let monotonicNow = 100_000;
    const registry = new WorkerRegistry(
      'worker-01',
      () => now,
      () => monotonicNow,
    );

    expect(registry.snapshot().status).toBe('OFFLINE');
    expect(
      registry.register({ workerId: 'other-worker', agentVersion: '0.1.0', capabilities }),
    ).toBe(null);

    const sessionId = registry.register({
      workerId: 'worker-01',
      agentVersion: '0.1.0',
      capabilities,
    });
    expect(sessionId).not.toBeNull();
    expect(registry.snapshot()).toMatchObject({
      workerId: 'worker-01',
      status: 'ONLINE',
      agentVersion: '0.1.0',
      lastSeenAt: '2026-11-04T10:00:00.000Z',
    });

    now += 5_000;
    monotonicNow += 5_000;
    expect(registry.recordHeartbeat('worker-01', sessionId as string)).toBe(true);
    expect(registry.snapshot().lastSeenAt).toBe('2026-11-04T10:00:05.000Z');
  });

  test('marks a worker offline after a timeout and ignores a stale session close', () => {
    let now = 100_000;
    let monotonicNow = 100_000;
    const registry = new WorkerRegistry(
      'worker-01',
      () => now,
      () => monotonicNow,
    );
    const firstSession = registry.register({
      workerId: 'worker-01',
      agentVersion: '0.1.0',
      capabilities,
    });
    expect(firstSession).not.toBeNull();

    const replacementSession = registry.register({
      workerId: 'worker-01',
      agentVersion: '0.1.1',
      capabilities,
    });
    expect(replacementSession).not.toBeNull();
    expect(registry.disconnect('worker-01', firstSession as string)).toBe(false);
    expect(registry.snapshot().status).toBe('ONLINE');

    now += 45_001;
    monotonicNow += 45_001;
    expect(registry.expireIfStale(45_000)).toBe(replacementSession);
    expect(registry.snapshot().status).toBe('OFFLINE');
    expect(registry.expireIfStale(45_000)).toBeNull();
  });
});
