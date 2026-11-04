import { AgentMessageSchema, PROTOCOL_VERSION } from '../src/index.js';

const authenticate = {
  protocolVersion: PROTOCOL_VERSION,
  messageId: '0c5c8e0d-f084-4fd6-9959-c89a4641eea6',
  timestamp: '2026-11-04T10:00:00.000Z',
  type: 'agent.authenticate',
  workerId: 'worker-01',
  credential: 'test-worker-token-that-is-at-least-32-characters-long',
  agentVersion: '0.1.0',
  capabilities: {
    platform: 'linux',
    architecture: 'x64',
    cpuCores: 4,
    totalMemoryBytes: 8_000_000_000,
  },
};

describe('versioned Agent protocol messages', () => {
  test('accepts a valid authentication message', () => {
    expect(AgentMessageSchema.safeParse(authenticate).success).toBe(true);
  });

  test('rejects unsupported versions and unknown fields', () => {
    expect(AgentMessageSchema.safeParse({ ...authenticate, protocolVersion: 2 }).success).toBe(
      false,
    );
    expect(AgentMessageSchema.safeParse({ ...authenticate, extra: 'not allowed' }).success).toBe(
      false,
    );
  });
});
