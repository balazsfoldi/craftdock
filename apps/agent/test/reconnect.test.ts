import { calculateReconnectDelay, runWithReconnect } from '../src/reconnect.js';

describe('Agent reconnect behavior', () => {
  test('uses capped exponential backoff with bounded jitter', () => {
    expect(calculateReconnectDelay(0, 1_000, 30_000, () => 0.5)).toBe(1_000);
    expect(calculateReconnectDelay(3, 1_000, 30_000, () => 0.5)).toBe(8_000);
    expect(calculateReconnectDelay(10, 1_000, 30_000, () => 0.5)).toBe(30_000);
    expect(calculateReconnectDelay(10, 1_000, 30_000, () => 1)).toBeLessThanOrEqual(30_000);
  });

  test('reconnects after a Manager restart and exits when shutdown is requested', async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    let sessionCount = 0;

    await runWithReconnect(
      async (markConnected) => {
        sessionCount += 1;
        if (sessionCount === 1) {
          throw new Error('Manager is restarting');
        }
        markConnected();
      },
      {
        signal: controller.signal,
        baseDelayMs: 1_000,
        maxDelayMs: 30_000,
        random: () => 0.5,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
          if (delays.length === 2) {
            controller.abort();
          }
        },
      },
    );

    expect(sessionCount).toBe(2);
    expect(delays).toEqual([1_000, 1_000]);
  });
});
