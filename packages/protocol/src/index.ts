import { z } from 'zod';
import { randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 1;

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

export const AgentMessageSchema = z.discriminatedUnion('type', [
  AgentAuthenticateSchema,
  AgentHeartbeatSchema,
]);

export const ManagerMessageSchema = z.discriminatedUnion('type', [
  ManagerAuthResultSchema,
  ManagerHeartbeatAckSchema,
  ManagerErrorSchema,
]);

export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;
export type AgentAuthenticate = z.infer<typeof AgentAuthenticateSchema>;
export type AgentHeartbeat = z.infer<typeof AgentHeartbeatSchema>;
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
