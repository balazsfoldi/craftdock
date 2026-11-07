import { z } from 'zod';
import { randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 2;

const TimestampSchema = z.string().datetime({ offset: false });
const MessageIdSchema = z.string().uuid();
const WorkerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const HostCapabilitiesSchema = z
  .object({
    platform: z.string().min(1).max(32),
    architecture: z.string().min(1).max(32),
    cpuCores: z.number().int().positive().max(4096),
    totalMemoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const MessageBaseShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: MessageIdSchema,
  timestamp: TimestampSchema,
};

export const AgentAuthenticateSchema = z
  .object({
    ...MessageBaseShape,
    type: z.literal('agent.authenticate'),
    workerId: WorkerIdSchema,
    credential: z.string().min(32).max(256),
    agentVersion: z.string().min(1).max(64),
    capabilities: HostCapabilitiesSchema,
  })
  .strict();

export const ManagerAuthResultSchema = z
  .object({
    ...MessageBaseShape,
    type: z.literal('manager.auth-result'),
    accepted: z.boolean(),
    workerId: WorkerIdSchema,
    heartbeatIntervalMs: z.number().int().positive().max(300_000),
    errorCode: z.enum(['UNAUTHORIZED', 'INVALID_MESSAGE']).optional(),
  })
  .strict();

export const AgentHeartbeatSchema = z
  .object({
    ...MessageBaseShape,
    type: z.literal('agent.heartbeat'),
    workerId: WorkerIdSchema,
  })
  .strict();

const ServerIdSchema = z.string().uuid();
const ServerNameSchema = z.string().trim().min(1).max(64);
const MinecraftVersionSchema = z.string().regex(/^\d+\.\d+(?:\.\d+)?$/);
const HostPortSchema = z.number().int().min(25_565).max(60_000);
const MemoryMbSchema = z.number().int().min(1_024).max(8_192);
const CpuLimitSchema = z.number().min(1).max(8);

const ManagerCommandBase = {
  ...MessageBaseShape,
  type: z.literal('manager.command'),
  commandId: MessageIdSchema,
  operationId: MessageIdSchema,
  idempotencyKey: MessageIdSchema,
  deadline: TimestampSchema,
  serverId: ServerIdSchema,
};

const ServerCommandConfig = {
  name: ServerNameSchema,
  minecraftVersion: MinecraftVersionSchema,
  hostPort: HostPortSchema,
  memoryMb: MemoryMbSchema,
  cpuLimit: CpuLimitSchema,
  eulaAccepted: z.literal(true),
};

export const ManagerCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...ManagerCommandBase,
      action: z.literal('server.create'),
      server: z
        .object({ ...ServerCommandConfig, desiredState: z.enum(['RUNNING', 'STOPPED']) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ManagerCommandBase,
      action: z.literal('server.start'),
      server: z.object({ ...ServerCommandConfig, desiredState: z.literal('RUNNING') }).strict(),
    })
    .strict(),
  z.object({ ...ManagerCommandBase, action: z.literal('server.stop') }).strict(),
  z
    .object({
      ...ManagerCommandBase,
      action: z.literal('server.delete'),
      deleteWorld: z.boolean(),
    })
    .strict(),
]);

export const AgentCommandAckSchema = z
  .object({
    ...MessageBaseShape,
    type: z.literal('agent.command-ack'),
    commandId: MessageIdSchema,
    operationId: MessageIdSchema,
  })
  .strict();

export const AgentCommandResultSchema = z
  .object({
    ...MessageBaseShape,
    type: z.literal('agent.command-result'),
    commandId: MessageIdSchema,
    operationId: MessageIdSchema,
    status: z.enum(['SUCCEEDED', 'FAILED']),
    observedState: z.enum(['STOPPED', 'RUNNING', 'UNKNOWN']),
    errorCode: z
      .enum([
        'VALIDATION_FAILED',
        'DOCKER_UNAVAILABLE',
        'IMAGE_PULL_FAILED',
        'PORT_IN_USE',
        'OPERATION_FAILED',
        'SERVER_NOT_RUNNING',
      ])
      .optional(),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.status === 'FAILED' && !message.errorCode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Failed results require an error code',
      });
    }
    if (message.status === 'SUCCEEDED' && message.errorCode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Successful results cannot include an error code',
      });
    }
  });

export const AgentServerSnapshotSchema = z
  .object({
    ...MessageBaseShape,
    type: z.literal('agent.server-snapshot'),
    workerId: WorkerIdSchema,
    engineAvailable: z.boolean(),
    servers: z
      .array(
        z
          .object({
            serverId: ServerIdSchema,
            state: z.enum(['STOPPED', 'RUNNING', 'UNKNOWN']),
            hostPort: HostPortSchema,
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const AgentServerLogSchema = z
  .object({
    ...MessageBaseShape,
    type: z.literal('agent.server-log'),
    serverId: ServerIdSchema,
    stream: z.enum(['stdout', 'stderr']),
    line: z.string().min(1).max(4_000),
  })
  .strict();

export const ManagerHeartbeatAckSchema = z
  .object({
    ...MessageBaseShape,
    type: z.literal('manager.heartbeat-ack'),
    workerId: WorkerIdSchema,
    receivedMessageId: MessageIdSchema,
  })
  .strict();

export const ManagerErrorSchema = z
  .object({
    ...MessageBaseShape,
    type: z.literal('manager.error'),
    code: z.enum(['INVALID_MESSAGE', 'UNAUTHORIZED', 'WORKER_MISMATCH']),
    message: z.string().min(1).max(160),
  })
  .strict();

export const AgentMessageSchema = z.union([
  AgentAuthenticateSchema,
  AgentHeartbeatSchema,
  AgentCommandAckSchema,
  AgentCommandResultSchema,
  AgentServerSnapshotSchema,
  AgentServerLogSchema,
]);

export const ManagerMessageSchema = z.union([
  ManagerAuthResultSchema,
  ManagerHeartbeatAckSchema,
  ManagerCommandSchema,
  ManagerErrorSchema,
]);

export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;
export type AgentAuthenticate = z.infer<typeof AgentAuthenticateSchema>;
export type AgentHeartbeat = z.infer<typeof AgentHeartbeatSchema>;
export type ManagerCommand = z.infer<typeof ManagerCommandSchema>;
export type AgentCommandAck = z.infer<typeof AgentCommandAckSchema>;
export type AgentCommandResult = z.infer<typeof AgentCommandResultSchema>;
export type AgentServerSnapshot = z.infer<typeof AgentServerSnapshotSchema>;
export type AgentServerLog = z.infer<typeof AgentServerLogSchema>;
export type ManagerAuthResult = z.infer<typeof ManagerAuthResultSchema>;
export type ManagerHeartbeatAck = z.infer<typeof ManagerHeartbeatAckSchema>;
export type ManagerError = z.infer<typeof ManagerErrorSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type ManagerMessage = z.infer<typeof ManagerMessageSchema>;

export function createMessageMetadata(now: () => number = Date.now): {
  protocolVersion: typeof PROTOCOL_VERSION;
  messageId: string;
  timestamp: string;
} {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: randomUUID(),
    timestamp: new Date(now()).toISOString(),
  };
}
