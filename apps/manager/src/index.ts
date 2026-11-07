import { Algorithm, hash } from '@node-rs/argon2';
import { parseManagerConfig } from './config.js';
import { buildManagerApp } from './app.js';
import { PostgresControlPlane } from './control-plane.js';

async function main(): Promise<void> {
  const config = parseManagerConfig(process.env);
  if (!config.databaseUrl || !config.adminEmail || !config.adminPassword) {
    throw new Error(
      'DATABASE_URL, ADMIN_EMAIL, and ADMIN_PASSWORD are required to bootstrap the first Manager administrator.',
    );
  }
  const passwordHash = await hash(config.adminPassword, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  });
  const controlPlane = new PostgresControlPlane(config.databaseUrl);
  try {
    await controlPlane.initialize(config.workerId, config.adminEmail, passwordHash);
  } catch (error) {
    await controlPlane.close();
    throw error;
  }
  const { app } = buildManagerApp(config, { controlPlane });

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
