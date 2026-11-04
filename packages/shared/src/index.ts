import type { HostCapabilities } from '@craftdock/protocol';

export type WorkerStatus = 'ONLINE' | 'OFFLINE';

export interface WorkerSnapshot {
  workerId: string;
  status: WorkerStatus;
  lastSeenAt: string | null;
  connectedSince: string | null;
  agentVersion: string | null;
  capabilities: HostCapabilities | null;
}
