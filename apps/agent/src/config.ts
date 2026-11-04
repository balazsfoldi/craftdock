import { z } from 'zod';

const positiveInteger = (defaultValue: number, minimum = 1) =>
  z.preprocess(
    (value) => (value === undefined || value === '' ? defaultValue : value),
    z.coerce.number().int().min(minimum),
  );

const AgentConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    MANAGER_WS_URL: z.string().url(),
    WORKER_ID: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    WORKER_TOKEN: z.string().min(32).max(256),
    RECONNECT_BASE_DELAY_MS: positiveInteger(1_000, 250).pipe(z.number().max(60_000)),
    RECONNECT_MAX_DELAY_MS: positiveInteger(30_000, 250).pipe(z.number().max(300_000)),
    CONNECTION_TIMEOUT_MS: positiveInteger(10_000, 1_000).pipe(z.number().max(120_000)),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((config, context) => {
    let managerUrl: URL;
    try {
      managerUrl = new URL(config.MANAGER_WS_URL);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MANAGER_WS_URL must be a valid WebSocket URL',
        path: ['MANAGER_WS_URL'],
      });
      return;
    }

    if (managerUrl.protocol !== 'ws:' && managerUrl.protocol !== 'wss:') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MANAGER_WS_URL must use ws:// or wss://',
        path: ['MANAGER_WS_URL'],
      });
    }
    if (managerUrl.username || managerUrl.password || managerUrl.search || managerUrl.hash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MANAGER_WS_URL cannot contain credentials, a query string, or a fragment',
        path: ['MANAGER_WS_URL'],
      });
    }
    if (config.NODE_ENV === 'production' && managerUrl.protocol !== 'wss:') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Production Agent connections must use wss://',
        path: ['MANAGER_WS_URL'],
      });
    }
    if (managerUrl.pathname !== '/api/v1/agent') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MANAGER_WS_URL path must be /api/v1/agent',
        path: ['MANAGER_WS_URL'],
      });
    }
    if (config.RECONNECT_MAX_DELAY_MS < config.RECONNECT_BASE_DELAY_MS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RECONNECT_MAX_DELAY_MS must be at least RECONNECT_BASE_DELAY_MS',
        path: ['RECONNECT_MAX_DELAY_MS'],
      });
    }
  });

export interface AgentConfig {
  nodeEnv: 'development' | 'test' | 'production';
  managerWsUrl: string;
  workerId: string;
  workerToken: string;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  connectionTimeoutMs: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export function parseAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const result = AgentConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid Agent configuration: ${issues}`);
  }

  return {
    nodeEnv: result.data.NODE_ENV,
    managerWsUrl: result.data.MANAGER_WS_URL,
    workerId: result.data.WORKER_ID,
    workerToken: result.data.WORKER_TOKEN,
    reconnectBaseDelayMs: result.data.RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelayMs: result.data.RECONNECT_MAX_DELAY_MS,
    connectionTimeoutMs: result.data.CONNECTION_TIMEOUT_MS,
    logLevel: result.data.LOG_LEVEL,
  };
}
