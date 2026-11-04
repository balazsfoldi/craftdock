import { parseManagerConfig } from './config.js';
import { buildManagerApp } from './app.js';

async function main(): Promise<void> {
  const config = parseManagerConfig(process.env);
  const { app } = buildManagerApp(config);

  await app.listen({ host: config.host, port: config.port });
  app.log.info({ host: config.host, port: config.port }, 'Manager listening');

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Manager shutting down');
    await app.close();
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unexpected startup error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
