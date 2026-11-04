export interface ReconnectOptions {
  signal: AbortSignal;
  baseDelayMs: number;
  maxDelayMs: number;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onRetry?: (details: { attempt: number; delayMs: number; errorName: string }) => void;
}

export type SessionRunner = (markConnected: () => void) => Promise<void>;

export function calculateReconnectDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.min(Math.floor(attempt), 30));
  const exponentialDelay = Math.min(baseDelayMs * 2 ** safeAttempt, maxDelayMs);
  const jitterFactor = 0.8 + Math.min(Math.max(random(), 0), 1) * 0.4;
  return Math.min(maxDelayMs, Math.max(0, Math.round(exponentialDelay * jitterFactor)));
}

export async function runWithReconnect(
  runSession: SessionRunner,
  options: ReconnectOptions,
): Promise<void> {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  let failedAttempts = 0;

  while (!options.signal.aborted) {
    let connected = false;
    let errorName = 'ConnectionClosed';
    try {
      await runSession(() => {
        connected = true;
      });
    } catch (error) {
      errorName = error instanceof Error ? error.name : 'ConnectionError';
    }

    if (options.signal.aborted) {
      return;
    }
    if (connected) {
      failedAttempts = 0;
    }

    const delayMs = calculateReconnectDelay(
      failedAttempts,
      options.baseDelayMs,
      options.maxDelayMs,
      random,
    );
    failedAttempts += 1;
    options.onRetry?.({ attempt: failedAttempts, delayMs, errorName });
    await sleep(delayMs, options.signal);
  }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };

    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}
