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

export type DesiredServerState = 'RUNNING' | 'STOPPED';
export type ObservedServerState =
  'PROVISIONING' | 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR' | 'UNKNOWN';
export type ServerOperationType = 'CREATE' | 'START' | 'STOP' | 'DELETE' | 'CONSOLE';
export type OperationStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type PlatformRole = 'ADMIN' | 'USER';
export type ServerRole = 'OWNER' | 'OPERATOR' | 'VIEWER';

export interface UserSnapshot {
  id: string;
  email: string;
  role: PlatformRole;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
}

export interface ServerMemberSnapshot {
  userId: string;
  email: string;
  role: ServerRole;
  createdAt: string;
}

export interface ServerSnapshot {
  id: string;
  name: string;
  minecraftVersion: string;
  desiredState: DesiredServerState;
  observedState: ObservedServerState;
  workerId: string;
  hostPort: number;
  memoryMb: number;
  cpuLimit: number;
  createdAt: string;
  updatedAt: string;
  lastObservedAt: string | null;
  accessRole?: ServerRole;
}

export interface OperationSnapshot {
  id: string;
  serverId: string;
  type: ServerOperationType;
  status: OperationStatus;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  consoleOutput: string | null;
}
