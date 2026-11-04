import { z } from 'zod';

const positiveInteger = (defaultValue: number, minimum = 1) =>
  z.preprocess(
    (value) => (value === undefined || value === '' ? defaultValue : value),
    z.coerce.number().int().min(minimum),
  );

const ManagerConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    MANAGER_HOST: z.string().min(1).default('0.0.0.0'),
    MANAGER_PORT: positiveInteger(4000, 1).pipe(z.number().max(65_535)),
    WORKER_ID: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    WORKER_TOKEN: z.string().min(32).max(256),
    HEARTBEAT_INTERVAL_MS: positiveInteger(10_000, 1_000).pipe(z.number().max(300_000)),
    WORKER_TIMEOUT_MS: positiveInteger(45_000, 5_000).pipe(z.number().max(900_000)),
    HEARTBEAT_SWEEP_INTERVAL_MS: positiveInteger(5_000, 500).pipe(z.number().max(60_000)),
    AUTH_TIMEOUT_MS: positiveInteger(10_000, 1_000).pipe(z.number().max(60_000)),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((config, context) => {
    if (config.WORKER_TIMEOUT_MS <= config.HEARTBEAT_INTERVAL_MS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'WORKER_TIMEOUT_MS must be greater than HEARTBEAT_INTERVAL_MS',
        path: ['WORKER_TIMEOUT_MS'],
      });
    }
  });

export interface ManagerConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  workerId: string;
  workerToken: string;
  heartbeatIntervalMs: number;
  workerTimeoutMs: number;
  heartbeatSweepIntervalMs: number;
  authTimeoutMs: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export function parseManagerConfig(env: NodeJS.ProcessEnv): ManagerConfig {
  const result = ManagerConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid Manager configuration: ${issues}`);
  }

  return {
    nodeEnv: result.data.NODE_ENV,
    host: result.data.MANAGER_HOST,
    port: result.data.MANAGER_PORT,
    workerId: result.data.WORKER_ID,
    workerToken: result.data.WORKER_TOKEN,
    heartbeatIntervalMs: result.data.HEARTBEAT_INTERVAL_MS,
    workerTimeoutMs: result.data.WORKER_TIMEOUT_MS,
    heartbeatSweepIntervalMs: result.data.HEARTBEAT_SWEEP_INTERVAL_MS,
    authTimeoutMs: result.data.AUTH_TIMEOUT_MS,
    logLevel: result.data.LOG_LEVEL,
  };
}
