import { randomUUID } from 'node:crypto';
import type { HostCapabilities } from '@craftdock/protocol';
import type { WorkerSnapshot } from '@craftdock/shared';

export interface WorkerRegistration {
  workerId: string;
  agentVersion: string;
  capabilities: HostCapabilities;
}

export class WorkerRegistry {
  private readonly configuredWorkerId: string;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private currentSessionId: string | null = null;
  private snapshotValue: WorkerSnapshot;
  private lastSeenMonotonicMs: number | null = null;

  constructor(
    workerId: string,
    now: () => number = Date.now,
    monotonicNow: () => number = () => performance.now(),
  ) {
    this.configuredWorkerId = workerId;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.snapshotValue = {
      workerId,
      status: 'OFFLINE',
      lastSeenAt: null,
      connectedSince: null,
      agentVersion: null,
      capabilities: null,
    };
  }

  register(registration: WorkerRegistration): string | null {
    if (registration.workerId !== this.configuredWorkerId) {
      return null;
    }

    const now = this.now();
    const timestamp = new Date(now).toISOString();
    const sessionId = randomUUID();
    this.currentSessionId = sessionId;
    this.lastSeenMonotonicMs = this.monotonicNow();
    this.snapshotValue = {
      workerId: registration.workerId,
      status: 'ONLINE',
      lastSeenAt: timestamp,
      connectedSince: timestamp,
      agentVersion: registration.agentVersion,
      capabilities: { ...registration.capabilities },
    };
    return sessionId;
  }

  recordHeartbeat(workerId: string, sessionId: string): boolean {
    if (workerId !== this.configuredWorkerId || sessionId !== this.currentSessionId) {
      return false;
    }

    const now = this.now();
    this.lastSeenMonotonicMs = this.monotonicNow();
    this.snapshotValue = {
      ...this.snapshotValue,
      status: 'ONLINE',
      lastSeenAt: new Date(now).toISOString(),
    };
    return true;
  }

  disconnect(workerId: string, sessionId: string): boolean {
    if (workerId !== this.configuredWorkerId || sessionId !== this.currentSessionId) {
      return false;
    }

    this.markOffline();
    return true;
  }

  expireIfStale(timeoutMs: number): string | null {
    if (
      this.currentSessionId === null ||
      this.lastSeenMonotonicMs === null ||
      this.monotonicNow() - this.lastSeenMonotonicMs <= timeoutMs
    ) {
      return null;
    }

    const expiredSessionId = this.currentSessionId;
    this.markOffline();
    return expiredSessionId;
  }

  snapshot(): WorkerSnapshot {
    return {
      ...this.snapshotValue,
      capabilities: this.snapshotValue.capabilities ? { ...this.snapshotValue.capabilities } : null,
    };
  }

  private markOffline(): void {
    this.currentSessionId = null;
    this.lastSeenMonotonicMs = null;
    this.snapshotValue = { ...this.snapshotValue, status: 'OFFLINE' };
  }
}
