import pino from 'pino';
import { parseAgentConfig } from './config.js';
import { runWithReconnect } from './reconnect.js';
import { runAgentSession } from './session.js';

async function main(): Promise<void> {
  const config = parseAgentConfig(process.env);
  const logger = pino({ level: config.logLevel });
  const controller = new AbortController();

  const shutdown = (signal: string): void => {
    logger.info({ signal, workerId: config.workerId }, 'Agent shutting down');
    controller.abort();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await runWithReconnect(
    (markConnected) => runAgentSession(config, logger, controller.signal, markConnected),
    {
      signal: controller.signal,
      baseDelayMs: config.reconnectBaseDelayMs,
      maxDelayMs: config.reconnectMaxDelayMs,
      onRetry: ({ attempt, delayMs, errorName }) => {
        logger.warn(
          { workerId: config.workerId, attempt, delayMs, errorName },
          'Manager unavailable; reconnecting',
        );
      },
    },
  );

  logger.info({ workerId: config.workerId }, 'Agent stopped');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unexpected startup error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
