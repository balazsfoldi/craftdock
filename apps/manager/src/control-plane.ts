import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import {
  createMessageMetadata,
  ManagerCommandSchema,
  type AgentServerSnapshot,
  type ManagerCommand,
} from '@craftdock/protocol';
import type {
  OperationSnapshot,
  PlatformRole,
  ServerMemberSnapshot,
  ServerRole,
  ServerSnapshot,
  UserSnapshot,
} from '@craftdock/shared';

export interface CreateServerInput {
  name: string;
  minecraftVersion: string;
  memoryMb: number;
  cpuLimit: number;
  eulaAccepted: true;
}

export interface UserAccount extends UserSnapshot {
  passwordHash: string;
}

export interface AuditEventSnapshot {
  id: string;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface UpdateUserInput {
  role?: PlatformRole;
  status?: UserSnapshot['status'];
  passwordHash?: string;
}

export interface CreateUserInput {
  email: string;
  role: PlatformRole;
  passwordHash: string;
}

export interface CreateServerResult {
  server: ServerSnapshot;
  operation: OperationSnapshot;
}

export interface OperationWithCommand {
  operation: OperationSnapshot;
  command: ManagerCommand;
}

export interface ControlPlane {
  initialize(workerId: string, adminEmail: string, adminPasswordHash: string): Promise<void>;
  close(): Promise<void>;
  getUserByEmail(email: string): Promise<UserAccount | null>;
  getUserById(userId: string): Promise<UserAccount | null>;
  listUsers(): Promise<UserSnapshot[]>;
  createUser(input: CreateUserInput, actorId: string): Promise<UserSnapshot>;
  updateUser(userId: string, input: UpdateUserInput, actorId: string): Promise<UserSnapshot>;
  updateOwnPassword(userId: string, passwordHash: string): Promise<void>;
  listAuditEvents(limit?: number): Promise<AuditEventSnapshot[]>;
  listServers(workerId: string): Promise<ServerSnapshot[]>;
  getServer(serverId: string): Promise<ServerSnapshot | null>;
  getServerMemberRole(serverId: string, userId: string): Promise<ServerRole | null>;
  listServerMembers(serverId: string): Promise<ServerMemberSnapshot[]>;
  setServerMember(
    serverId: string,
    userId: string,
    role: ServerRole,
    actorId: string,
  ): Promise<void>;
  removeServerMember(serverId: string, userId: string, actorId: string): Promise<void>;
  createServer(
    workerId: string,
    adminId: string,
    idempotencyKey: string,
    input: CreateServerInput,
  ): Promise<CreateServerResult>;
  requestServerState(
    serverId: string,
    adminId: string,
    idempotencyKey: string,
    desiredState: 'RUNNING' | 'STOPPED',
  ): Promise<OperationSnapshot>;
  requestServerDelete(
    serverId: string,
    actorId: string,
    idempotencyKey: string,
    deleteWorld: boolean,
  ): Promise<OperationSnapshot>;
  requestConsoleCommand(
    serverId: string,
    actorId: string,
    idempotencyKey: string,
    command: string,
  ): Promise<OperationSnapshot>;
  getOperation(operationId: string): Promise<OperationSnapshot | null>;
  listOperations(serverId: string): Promise<OperationSnapshot[]>;
  getPendingOperations(workerId: string, replayRunning?: boolean): Promise<OperationWithCommand[]>;
  markOperationStarted(operationId: string): Promise<void>;
  completeOperation(
    operationId: string,
    result: {
      succeeded: boolean;
      observedState: 'STOPPED' | 'RUNNING' | 'UNKNOWN';
      errorCode?: string;
      consoleOutput?: string;
    },
  ): Promise<void>;
  reconcileWorker(workerId: string, snapshot: AgentServerSnapshot): Promise<void>;
  recordWorker(
    workerId: string,
    status: 'ONLINE' | 'OFFLINE',
    agentVersion?: string,
  ): Promise<void>;
  recordAudit(
    action: string,
    actorId: string | null,
    targetType: string,
    targetId: string | null,
    metadata?: Record<string, string | number | boolean>,
  ): Promise<void>;
}

interface ServerRow {
  id: string;
  name: string;
  minecraft_version: string;
  desired_state: ServerSnapshot['desiredState'];
  observed_state: ServerSnapshot['observedState'];
  worker_id: string;
  host_port: number;
  memory_mb: number;
  cpu_limit: number;
  created_at: Date;
  updated_at: Date;
  last_observed_at: Date | null;
  member_role?: ServerRole;
}

interface OperationRow {
  id: string;
  server_id: string;
  type: OperationSnapshot['type'];
  idempotency_key: string;
  status: OperationSnapshot['status'];
  error_code: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  requested_by?: string;
  retry_count?: number;
  payload?: { deleteWorld?: boolean; command?: string };
  result?: { consoleOutput?: string } | null;
}

const PORT_START = 25_565;
const PORT_END = 60_000;
const PORT_LOCK_ID = 0x43524654;
const ROLE_CHANGE_LOCK_ID = 0x43524f4c;

export class PostgresControlPlane implements ControlPlane {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  }

  async initialize(workerId: string, adminEmail: string, adminPasswordHash: string): Promise<void> {
    await this.pool.query('SELECT 1');
    const initialMigration = await readFile(
      new URL('../migrations/001-initial.sql', import.meta.url),
      'utf8',
    );
    const deleteMigration = await readFile(
      new URL('../migrations/002-server-delete.sql', import.meta.url),
      'utf8',
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const migrationTable = await client.query<{ name: string | null }>(
        "SELECT to_regclass('public.schema_migrations') AS name",
      );
      let initialApplied = false;
      if (migrationTable.rows[0]?.name) {
        const initial = await client.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          ['001-initial'],
        );
        initialApplied = Boolean(initial.rowCount);
      }
      if (!initialApplied) await client.query(initialMigration);
      const migration = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations WHERE version = $1',
        ['002-server-delete'],
      );
      if (!migration.rowCount) {
        await client.query(deleteMigration);
      }
      await client.query(
        `INSERT INTO workers (id, name, status) VALUES ($1, 'Windows worker', 'OFFLINE')
         ON CONFLICT (id) DO UPDATE SET status = 'OFFLINE'`,
        [workerId],
      );
      await client.query(
        "UPDATE servers SET observed_state = 'UNKNOWN', updated_at = now() WHERE worker_id = $1 AND deleted_at IS NULL",
        [workerId],
      );
      await client.query(
        `INSERT INTO users (id, email, password_hash, role)
         VALUES ($1, $2, $3, 'ADMIN')
         ON CONFLICT (email) DO NOTHING`,
        [randomUUID(), adminEmail.toLowerCase(), adminPasswordHash],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getUserByEmail(email: string): Promise<UserAccount | null> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      password_hash: string;
      role: PlatformRole;
      created_at: Date;
    }>(
      'SELECT id, email, password_hash, role, created_at FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          email: row.email,
          passwordHash: row.password_hash,
          role: row.role,
          status: 'ACTIVE',
          createdAt: row.created_at.toISOString(),
        }
      : null;
  }

  async getUserById(userId: string): Promise<UserAccount | null> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      password_hash: string;
      role: PlatformRole;
      status: UserSnapshot['status'];
      created_at: Date;
    }>(
      'SELECT id, email, password_hash, role, status, created_at FROM users WHERE id = $1',
      [userId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          email: row.email,
          passwordHash: row.password_hash,
          role: row.role,
          status: row.status,
          createdAt: row.created_at.toISOString(),
        }
      : null;
  }

  async listUsers(): Promise<UserSnapshot[]> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      role: PlatformRole;
      status: UserSnapshot['status'];
      created_at: Date;
    }>('SELECT id, email, role, status, created_at FROM users ORDER BY email');
    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async createUser(input: CreateUserInput, actorId: string): Promise<UserSnapshot> {
    try {
      return await this.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [ROLE_CHANGE_LOCK_ID]);
        const result = await client.query<{
          id: string;
          email: string;
          role: PlatformRole;
          status: UserSnapshot['status'];
          created_at: Date;
        }>(
          `INSERT INTO users (id, email, password_hash, role, status)
           VALUES ($1, $2, $3, $4, 'ACTIVE')
           RETURNING id, email, role, status, created_at`,
          [randomUUID(), input.email.toLowerCase(), input.passwordHash, input.role],
        );
        const user = toUserSnapshot(result.rows[0]!);
        await insertAudit(client, 'user.created', actorId, 'user', user.id, { role: user.role });
        return user;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error('USER_ALREADY_EXISTS');
      }
      throw error;
    }
  }

  async updateUser(
    userId: string,
    input: UpdateUserInput,
    actorId: string,
  ): Promise<UserSnapshot> {
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [ROLE_CHANGE_LOCK_ID]);
      const current = await client.query<{
        id: string;
        email: string;
        role: PlatformRole;
        status: UserSnapshot['status'];
        created_at: Date;
      }>('SELECT id, email, role, status, created_at FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const row = current.rows[0];
      if (!row) {
        throw new Error('USER_NOT_FOUND');
      }
      const nextRole = input.role ?? row.role;
      const nextStatus = input.status ?? row.status;
      if (row.role === 'ADMIN' && row.status === 'ACTIVE' && (nextRole !== 'ADMIN' || nextStatus !== 'ACTIVE')) {
        const activeAdmins = await client.query<{ count: string }>(
          "SELECT count(*) AS count FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'",
        );
        if (Number(activeAdmins.rows[0]?.count ?? 0) <= 1) {
          throw new Error('LAST_ADMIN_REQUIRED');
        }
      }
      if (row.status === 'ACTIVE' && nextStatus === 'DISABLED') {
        const ownedServers = await client.query<{ server_id: string }>(
          `SELECT m.server_id FROM server_members m JOIN servers s ON s.id = m.server_id
           WHERE m.user_id = $1 AND m.role = 'OWNER' AND s.deleted_at IS NULL`,
          [userId],
        );
        for (const owned of ownedServers.rows) {
          const otherOwners = await client.query<{ count: string }>(
            `SELECT count(*) AS count FROM server_members m JOIN users u ON u.id = m.user_id
             WHERE m.server_id = $1 AND m.role = 'OWNER' AND m.user_id <> $2 AND u.status = 'ACTIVE'`,
            [owned.server_id, userId],
          );
          if (Number(otherOwners.rows[0]?.count ?? 0) === 0) {
            throw new Error('LAST_SERVER_OWNER_REQUIRED');
          }
        }
      }
      const updated = await client.query<{
        id: string;
        email: string;
        role: PlatformRole;
        status: UserSnapshot['status'];
        created_at: Date;
      }>(
        `UPDATE users SET role = $2, status = $3,
                          password_hash = COALESCE($4, password_hash)
         WHERE id = $1 RETURNING id, email, role, status, created_at`,
        [userId, nextRole, nextStatus, input.passwordHash ?? null],
      );
      const user = toUserSnapshot(updated.rows[0]!);
      await insertAudit(client, 'user.updated', actorId, 'user', user.id, {
        role: user.role,
        status: user.status,
        passwordChanged: Boolean(input.passwordHash),
      });
      return user;
    });
  }

  async updateOwnPassword(userId: string, passwordHash: string): Promise<void> {
    const result = await this.pool.query(
      "UPDATE users SET password_hash = $2 WHERE id = $1 AND status = 'ACTIVE'",
      [userId, passwordHash],
    );
    if (!result.rowCount) {
      throw new Error('USER_NOT_FOUND');
    }
  }

  async listAuditEvents(limit = 100): Promise<AuditEventSnapshot[]> {
    const result = await this.pool.query<{
      id: string;
      actor_email: string | null;
      action: string;
      target_type: string;
      target_id: string | null;
      metadata: Record<string, string | number | boolean>;
      created_at: Date;
    }>(
      `SELECT e.id, u.email AS actor_email, e.action, e.target_type, e.target_id,
              e.metadata, e.created_at
       FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
       ORDER BY e.created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(500, limit))],
    );
    return result.rows.map((row) => ({
      id: row.id,
      actorEmail: row.actor_email,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async listServers(workerId: string): Promise<ServerSnapshot[]> {
    const result = await this.pool.query<ServerRow>(
      `SELECT id, name, minecraft_version, desired_state, observed_state, worker_id,
              host_port, memory_mb, cpu_limit, created_at, updated_at, last_observed_at
       FROM servers WHERE worker_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [workerId],
    );
    return result.rows.map(toServerSnapshot);
  }

  async getServer(serverId: string): Promise<ServerSnapshot | null> {
    const result = await this.pool.query<ServerRow>(
      `SELECT id, name, minecraft_version, desired_state, observed_state, worker_id,
              host_port, memory_mb, cpu_limit, created_at, updated_at, last_observed_at
       FROM servers WHERE id = $1 AND deleted_at IS NULL`,
      [serverId],
    );
    const row = result.rows[0];
    return row ? toServerSnapshot(row) : null;
  }

  async getServerMemberRole(serverId: string, userId: string): Promise<ServerRole | null> {
    const result = await this.pool.query<{ role: ServerRole }>(
      'SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2',
      [serverId, userId],
    );
    return result.rows[0]?.role ?? null;
  }

  async listServerMembers(serverId: string): Promise<ServerMemberSnapshot[]> {
    const result = await this.pool.query<{
      user_id: string;
      email: string;
      role: ServerRole;
      created_at: Date;
    }>(
      `SELECT m.user_id, u.email, m.role, m.created_at FROM server_members m
       JOIN users u ON u.id = m.user_id WHERE m.server_id = $1 AND u.status = 'ACTIVE'
       ORDER BY u.email`,
      [serverId],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      role: row.role,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async setServerMember(
    serverId: string,
    userId: string,
    role: ServerRole,
    actorId: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [ROLE_CHANGE_LOCK_ID]);
      const server = await client.query(
        'SELECT 1 FROM servers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [serverId],
      );
      if (!server.rowCount) throw new Error('SERVER_NOT_FOUND');
      const user = await client.query(
        "SELECT 1 FROM users WHERE id = $1 AND status = 'ACTIVE'",
        [userId],
      );
      if (!user.rowCount) throw new Error('USER_NOT_FOUND');
      const existingMember = await client.query<{ role: ServerRole }>(
        'SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2 FOR UPDATE',
        [serverId, userId],
      );
      if (existingMember.rows[0]?.role === 'OWNER' && role !== 'OWNER') {
        const owners = await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM server_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.server_id = $1 AND m.role = 'OWNER' AND u.status = 'ACTIVE'
             AND m.user_id <> $2`,
          [serverId, userId],
        );
        if (Number(owners.rows[0]?.count ?? 0) === 0) {
          throw new Error('LAST_SERVER_OWNER_REQUIRED');
        }
      }
      await client.query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (server_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [serverId, userId, role],
      );
      await insertAudit(client, 'server.member.set', actorId, 'server', serverId, {
        userId,
        role,
      });
    });
  }

  async removeServerMember(serverId: string, userId: string, actorId: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [ROLE_CHANGE_LOCK_ID]);
      const server = await client.query(
        'SELECT 1 FROM servers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [serverId],
      );
      if (!server.rowCount) throw new Error('SERVER_NOT_FOUND');
      const member = await client.query<{ role: ServerRole; status: UserSnapshot['status'] }>(
        `SELECT m.role, u.status FROM server_members m JOIN users u ON u.id = m.user_id
         WHERE m.server_id = $1 AND m.user_id = $2 FOR UPDATE OF m`,
        [serverId, userId],
      );
      const role = member.rows[0]?.role;
      if (!role) throw new Error('MEMBER_NOT_FOUND');
      if (role === 'OWNER' && member.rows[0]?.status === 'ACTIVE') {
        const owners = await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM server_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.server_id = $1 AND m.role = 'OWNER' AND u.status = 'ACTIVE'
             AND m.user_id <> $2`,
          [serverId, userId],
        );
        if (Number(owners.rows[0]?.count ?? 0) === 0) throw new Error('LAST_SERVER_OWNER_REQUIRED');
      }
      await client.query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [
        serverId,
        userId,
      ]);
      await insertAudit(client, 'server.member.removed', actorId, 'server', serverId, { userId });
    });
  }

  async createServer(
    workerId: string,
    adminId: string,
    idempotencyKey: string,
    input: CreateServerInput,
  ): Promise<CreateServerResult> {
    return this.transaction(async (client) => {
      const existing = await client.query<OperationRow>(
        `SELECT id, server_id, type, idempotency_key, status, error_code, created_at, started_at, finished_at
         FROM operations WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].type !== 'CREATE') {
          throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        }
        const server = await client.query<ServerRow>(
          `SELECT id, name, minecraft_version, desired_state, observed_state, worker_id,
                  host_port, memory_mb, cpu_limit, created_at, updated_at, last_observed_at
           FROM servers WHERE id = $1`,
          [existing.rows[0].server_id],
        );
        if (!server.rows[0]) {
          throw new Error('IDEMPOTENCY_RECORD_INVALID');
        }
        return {
          server: toServerSnapshot(server.rows[0]),
          operation: toOperationSnapshot(existing.rows[0]),
        };
      }

      await client.query('SELECT pg_advisory_xact_lock($1)', [PORT_LOCK_ID]);
      const reserved = await client.query<{ host_port: number }>(
        'SELECT host_port FROM servers WHERE worker_id = $1 AND deleted_at IS NULL',
        [workerId],
      );
      const used = new Set(reserved.rows.map((row) => Number(row.host_port)));
      let hostPort = PORT_START;
      while (hostPort <= PORT_END && used.has(hostPort)) {
        hostPort += 1;
      }
      if (hostPort > PORT_END) {
        throw new Error('PORT_RANGE_EXHAUSTED');
      }

      const serverId = randomUUID();
      const insertedServer = await client.query<ServerRow>(
        `INSERT INTO servers (id, name, minecraft_version, desired_state, observed_state, worker_id,
                              host_port, memory_mb, cpu_limit, eula_accepted_at)
         VALUES ($1, $2, $3, 'STOPPED', 'PROVISIONING', $4, $5, $6, $7, now())
         RETURNING id, name, minecraft_version, desired_state, observed_state, worker_id,
                   host_port, memory_mb, cpu_limit, created_at, updated_at, last_observed_at`,
        [
          serverId,
          input.name,
          input.minecraftVersion,
          workerId,
          hostPort,
          input.memoryMb,
          input.cpuLimit,
        ],
      );
      const operationId = randomUUID();
      const insertedOperation = await client.query<OperationRow>(
        `INSERT INTO operations (id, server_id, type, idempotency_key, status, payload, requested_by)
         VALUES ($1, $2, 'CREATE', $3, 'QUEUED', $4::jsonb, $5)
         RETURNING id, server_id, type, idempotency_key, status, error_code, created_at, started_at, finished_at, requested_by`,
        [operationId, serverId, idempotencyKey, JSON.stringify({ eulaAccepted: true }), adminId],
      );
      await insertAudit(client, 'server.create.requested', adminId, 'server', serverId, {
        hostPort,
        minecraftVersion: input.minecraftVersion,
      });
      return {
        server: toServerSnapshot(insertedServer.rows[0]!),
        operation: toOperationSnapshot(insertedOperation.rows[0]!),
      };
    });
  }

  async requestServerState(
    serverId: string,
    adminId: string,
    idempotencyKey: string,
    desiredState: 'RUNNING' | 'STOPPED',
  ): Promise<OperationSnapshot> {
    return this.transaction(async (client) => {
      const duplicate = await client.query<OperationRow>(
        `SELECT id, server_id, type, idempotency_key, status, error_code, created_at, started_at, finished_at
         FROM operations WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (duplicate.rows[0]) {
        const expectedType = desiredState === 'RUNNING' ? 'START' : 'STOP';
        if (duplicate.rows[0].server_id !== serverId || duplicate.rows[0].type !== expectedType) {
          throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        }
        return toOperationSnapshot(duplicate.rows[0]);
      }

      const serverResult = await client.query<ServerRow>(
        `SELECT id, name, minecraft_version, desired_state, observed_state, worker_id,
                host_port, memory_mb, cpu_limit, created_at, updated_at, last_observed_at
         FROM servers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [serverId],
      );
      const server = serverResult.rows[0];
      if (!server) {
        throw new Error('SERVER_NOT_FOUND');
      }
      const active = await client.query(
        "SELECT 1 FROM operations WHERE server_id = $1 AND status IN ('QUEUED', 'RUNNING') LIMIT 1",
        [serverId],
      );
      if (active.rowCount) {
        throw new Error('OPERATION_IN_PROGRESS');
      }

      const operationId = randomUUID();
      const type = desiredState === 'RUNNING' ? 'START' : 'STOP';
      const inserted = await client.query<OperationRow>(
        `INSERT INTO operations (id, server_id, type, idempotency_key, status, payload, requested_by)
         VALUES ($1, $2, $3, $4, 'QUEUED', '{}'::jsonb, $5)
         RETURNING id, server_id, type, idempotency_key, status, error_code, created_at, started_at, finished_at`,
        [operationId, serverId, type, idempotencyKey, adminId],
      );
      await client.query(
        'UPDATE servers SET desired_state = $2, updated_at = now() WHERE id = $1',
        [serverId, desiredState],
      );
      await insertAudit(
        client,
        `server.${desiredState.toLowerCase()}.requested`,
        adminId,
        'server',
        serverId,
      );
      return toOperationSnapshot(inserted.rows[0]!);
    });
  }

  async requestServerDelete(
    serverId: string,
    actorId: string,
    idempotencyKey: string,
    deleteWorld: boolean,
  ): Promise<OperationSnapshot> {
    return this.transaction(async (client) => {
      const duplicate = await client.query<OperationRow>(
        `SELECT id, server_id, type, idempotency_key, status, error_code, created_at,
                started_at, finished_at FROM operations WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].server_id !== serverId || duplicate.rows[0].type !== 'DELETE') {
          throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        }
        return toOperationSnapshot(duplicate.rows[0]);
      }
      const server = await client.query(
        'SELECT id FROM servers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [serverId],
      );
      if (!server.rowCount) throw new Error('SERVER_NOT_FOUND');
      const active = await client.query(
        "SELECT 1 FROM operations WHERE server_id = $1 AND status IN ('QUEUED', 'RUNNING') LIMIT 1",
        [serverId],
      );
      if (active.rowCount) throw new Error('OPERATION_IN_PROGRESS');
      const inserted = await client.query<OperationRow>(
        `INSERT INTO operations (id, server_id, type, idempotency_key, status, payload, requested_by)
         VALUES ($1, $2, 'DELETE', $3, 'QUEUED', $4::jsonb, $5)
         RETURNING id, server_id, type, idempotency_key, status, error_code, created_at,
                   started_at, finished_at, result`,
        [randomUUID(), serverId, idempotencyKey, JSON.stringify({ deleteWorld }), actorId],
      );
      await client.query(
        "UPDATE servers SET desired_state = 'STOPPED', updated_at = now() WHERE id = $1",
        [serverId],
      );
      await insertAudit(client, 'server.delete.requested', actorId, 'server', serverId, {
        worldDataDeleted: deleteWorld,
      });
      return toOperationSnapshot(inserted.rows[0]!);
    });
  }

  async requestConsoleCommand(
    serverId: string,
    actorId: string,
    idempotencyKey: string,
    command: string,
  ): Promise<OperationSnapshot> {
    const normalizedCommand = command.trim().replace(/^\//, '');
    if (
      !normalizedCommand ||
      normalizedCommand.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(normalizedCommand)
    ) {
      throw new Error('INVALID_CONSOLE_COMMAND');
    }
    return this.transaction(async (client) => {
      const duplicate = await client.query<OperationRow>(
        `SELECT id, server_id, type, idempotency_key, status, error_code, created_at,
                started_at, finished_at FROM operations WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].server_id !== serverId || duplicate.rows[0].type !== 'CONSOLE') {
          throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        }
        return toOperationSnapshot(duplicate.rows[0]);
      }
      const server = await client.query<{ observed_state: ServerSnapshot['observedState'] }>(
        'SELECT observed_state FROM servers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [serverId],
      );
      if (!server.rows[0]) throw new Error('SERVER_NOT_FOUND');
      if (server.rows[0].observed_state !== 'RUNNING') throw new Error('SERVER_NOT_RUNNING');
      const active = await client.query(
        "SELECT 1 FROM operations WHERE server_id = $1 AND status IN ('QUEUED', 'RUNNING') LIMIT 1",
        [serverId],
      );
      if (active.rowCount) throw new Error('OPERATION_IN_PROGRESS');
      const inserted = await client.query<OperationRow>(
        `INSERT INTO operations (id, server_id, type, idempotency_key, status, payload, requested_by)
         VALUES ($1, $2, 'CONSOLE', $3, 'QUEUED', $4::jsonb, $5)
         RETURNING id, server_id, type, idempotency_key, status, error_code, created_at,
                   started_at, finished_at, result`,
        [randomUUID(), serverId, idempotencyKey, JSON.stringify({ command: normalizedCommand }), actorId],
      );
      await insertAudit(client, 'server.console.requested', actorId, 'server', serverId, {
        commandName: normalizedCommand.split(/\s+/, 1)[0] ?? '',
      });
      return toOperationSnapshot(inserted.rows[0]!);
    });
  }

  async getOperation(operationId: string): Promise<OperationSnapshot | null> {
    const result = await this.pool.query<OperationRow>(
      `SELECT id, server_id, type, idempotency_key, status, error_code, created_at, started_at, finished_at
       FROM operations WHERE id = $1`,
      [operationId],
    );
    const row = result.rows[0];
    return row ? toOperationSnapshot(row) : null;
  }

  async listOperations(serverId: string): Promise<OperationSnapshot[]> {
    const result = await this.pool.query<OperationRow>(
      `SELECT id, server_id, type, idempotency_key, status, error_code, created_at, started_at, finished_at
       FROM operations WHERE server_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [serverId],
    );
    return result.rows.map(toOperationSnapshot);
  }

  async getPendingOperations(
    workerId: string,
    replayRunning = false,
  ): Promise<OperationWithCommand[]> {
    const result = await this.pool.query<OperationRow & ServerRow>(
      `SELECT o.id, o.server_id, o.type, o.idempotency_key, o.status, o.error_code, o.payload,
              o.created_at, o.started_at, o.finished_at,
              s.name, s.minecraft_version, s.desired_state, s.observed_state, s.worker_id,
              s.host_port, s.memory_mb, s.cpu_limit, s.created_at AS server_created_at,
              s.updated_at, s.last_observed_at
       FROM operations o JOIN servers s ON s.id = o.server_id
       WHERE s.worker_id = $1 AND s.deleted_at IS NULL
          AND (o.status = 'QUEUED' OR ($2::boolean AND o.status = 'RUNNING'))
       ORDER BY o.created_at`,
      [workerId, replayRunning],
    );
    return result.rows.map((row) => {
      const operation = toOperationSnapshot({
        id: row.id,
        server_id: row.server_id,
        type: row.type,
        idempotency_key: row.idempotency_key,
        status: row.status,
        error_code: row.error_code,
        created_at: row.created_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
      });
      const commandBase = {
        ...createMessageMetadata(),
        type: 'manager.command' as const,
        commandId: randomUUID(),
        operationId: row.id,
        idempotencyKey: row.idempotency_key,
        deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
        serverId: row.server_id,
      };
      const serverConfig = {
        name: row.name,
        minecraftVersion: row.minecraft_version,
        hostPort: row.host_port,
        memoryMb: row.memory_mb,
        cpuLimit: row.cpu_limit,
        eulaAccepted: true as const,
      };
      const command =
        row.type === 'CREATE'
          ? ManagerCommandSchema.parse({
              ...commandBase,
              action: 'server.create',
              server: { ...serverConfig, desiredState: row.desired_state },
            })
          : row.type === 'START'
            ? ManagerCommandSchema.parse({
                ...commandBase,
                action: 'server.start',
                server: { ...serverConfig, desiredState: 'RUNNING' },
              })
            : row.type === 'STOP'
              ? ManagerCommandSchema.parse({ ...commandBase, action: 'server.stop' })
              : ManagerCommandSchema.parse({
                  ...commandBase,
                  action: 'server.delete',
                  deleteWorld: row.payload?.deleteWorld === true,
                });
      return { operation, command };
    });
  }

  async markOperationStarted(operationId: string): Promise<void> {
    await this.pool.query(
      `UPDATE operations SET status = 'RUNNING', started_at = COALESCE(started_at, now())
       WHERE id = $1 AND status IN ('QUEUED', 'RUNNING')`,
      [operationId],
    );
  }

  async completeOperation(
    operationId: string,
    result: {
      succeeded: boolean;
      observedState: 'STOPPED' | 'RUNNING' | 'UNKNOWN';
      errorCode?: string;
    },
  ): Promise<void> {
    await this.transaction(async (client) => {
      const selected = await client.query<OperationRow>(
        `SELECT id, server_id, type, idempotency_key, status, error_code, created_at, started_at,
                finished_at, requested_by, retry_count, payload
         FROM operations WHERE id = $1 AND status IN ('QUEUED', 'RUNNING') FOR UPDATE`,
        [operationId],
      );
      const row = selected.rows[0];
      if (!row) {
        return;
      }

      if (!result.succeeded && result.errorCode === 'PORT_IN_USE' && (row.retry_count ?? 0) < 5) {
        await client.query('SELECT pg_advisory_xact_lock($1)', [PORT_LOCK_ID]);
        const serverResult = await client.query<{ worker_id: string; host_port: number }>(
          'SELECT worker_id, host_port FROM servers WHERE id = $1 FOR UPDATE',
          [row.server_id],
        );
        const server = serverResult.rows[0];
        if (server) {
          const usedPorts = await client.query<{ host_port: number }>(
            'SELECT host_port FROM servers WHERE worker_id = $1 AND id <> $2 AND deleted_at IS NULL',
            [server.worker_id, row.server_id],
          );
          const used = new Set(usedPorts.rows.map((entry) => Number(entry.host_port)));
          let newPort = PORT_START;
          while (
            newPort <= PORT_END &&
            (used.has(newPort) || newPort === Number(server.host_port))
          ) {
            newPort += 1;
          }
          if (newPort <= PORT_END) {
            await client.query(
              `UPDATE servers SET host_port = $2, observed_state = 'STOPPED', last_observed_at = now(), updated_at = now()
               WHERE id = $1`,
              [row.server_id, newPort],
            );
            await client.query(
              `UPDATE operations SET status = 'QUEUED', error_code = NULL, retry_count = retry_count + 1,
                                     started_at = NULL, finished_at = NULL
               WHERE id = $1`,
              [operationId],
            );
            await insertAudit(
              client,
              'server.port.reallocated',
              row.requested_by ?? null,
              'server',
              row.server_id,
              {
                previousPort: Number(server.host_port),
                hostPort: newPort,
                retry: (row.retry_count ?? 0) + 1,
              },
            );
            return;
          }
        }
      }

      const finalErrorCode =
        !result.succeeded && result.errorCode === 'PORT_IN_USE' && (row.retry_count ?? 0) < 5
          ? 'PORT_RANGE_EXHAUSTED'
          : (result.errorCode ?? null);
      const completed = await client.query(
        `UPDATE operations SET status = $2, error_code = $3, finished_at = now()
         WHERE id = $1 AND status IN ('QUEUED', 'RUNNING')`,
        [
          operationId,
          result.succeeded ? 'SUCCEEDED' : 'FAILED',
          finalErrorCode,
        ],
      );
      if (!completed.rowCount) {
        return;
      }
      if (row.type === 'DELETE' && result.succeeded) {
        await client.query(
          `UPDATE servers SET deleted_at = now(), desired_state = 'STOPPED', observed_state = 'STOPPED',
                              last_observed_at = now(), updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL`,
          [row.server_id],
        );
      } else {
        const observedState = result.succeeded ? result.observedState : 'ERROR';
        await client.query(
          'UPDATE servers SET observed_state = $2, last_observed_at = now(), updated_at = now() WHERE id = $1',
          [row.server_id, observedState],
        );
      }
      await insertAudit(
        client,
        `server.${row.type.toLowerCase()}.${result.succeeded ? 'succeeded' : 'failed'}`,
        row.requested_by ?? null,
        'server',
        row.server_id,
        {
          ...(finalErrorCode ? { errorCode: finalErrorCode } : {}),
          ...(row.type === 'DELETE' ? { worldDataDeleted: row.payload?.deleteWorld === true } : {}),
        },
      );
    });
  }

  async reconcileWorker(workerId: string, snapshot: AgentServerSnapshot): Promise<void> {
    await this.transaction(async (client) => {
      if (snapshot.workerId !== workerId) {
        throw new Error('WORKER_MISMATCH');
      }
      if (!snapshot.engineAvailable) {
        await client.query(
          "UPDATE servers SET observed_state = 'UNKNOWN', updated_at = now() WHERE worker_id = $1 AND deleted_at IS NULL",
          [workerId],
        );
        return;
      }
      const reported = new Map(snapshot.servers.map((server) => [server.serverId, server]));
      const servers = await client.query<ServerRow>(
        `SELECT id, name, minecraft_version, desired_state, observed_state, worker_id,
                host_port, memory_mb, cpu_limit, created_at, updated_at, last_observed_at
         FROM servers WHERE worker_id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [workerId],
      );
      const admin = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1",
      );
      const adminId = admin.rows[0]?.id;
      if (!adminId) {
        throw new Error('ADMIN_NOT_CONFIGURED');
      }

      for (const server of servers.rows) {
        const actual = reported.get(server.id);
        const observed = actual ? actual.state : 'UNKNOWN';
        await client.query(
          `UPDATE servers SET observed_state = $2, last_observed_at = now(), updated_at = now()
           WHERE id = $1`,
          [server.id, observed],
        );
        const active = await client.query(
          "SELECT 1 FROM operations WHERE server_id = $1 AND status IN ('QUEUED', 'RUNNING') LIMIT 1",
          [server.id],
        );
        if (active.rowCount) {
          continue;
        }
        const latest = await client.query<{ status: OperationSnapshot['status'] }>(
          'SELECT status FROM operations WHERE server_id = $1 ORDER BY created_at DESC LIMIT 1',
          [server.id],
        );
        if (latest.rows[0]?.status === 'FAILED') {
          continue;
        }

        let type: OperationSnapshot['type'] | null = null;
        if (!actual) {
          type = 'CREATE';
        } else if (server.desired_state === 'RUNNING' && actual.state !== 'RUNNING') {
          type = 'START';
        } else if (server.desired_state === 'STOPPED' && actual.state === 'RUNNING') {
          type = 'STOP';
        }
        if (type) {
          await client.query(
            `INSERT INTO operations (id, server_id, type, idempotency_key, status, payload, requested_by)
             VALUES ($1, $2, $3, $4, 'QUEUED', '{}'::jsonb, $5)`,
            [randomUUID(), server.id, type, randomUUID(), adminId],
          );
        }
      }
    });
  }

  async recordWorker(
    workerId: string,
    status: 'ONLINE' | 'OFFLINE',
    agentVersion?: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO workers (id, name, status, last_seen_at, agent_version)
       VALUES ($1, 'Windows worker', $2, CASE WHEN $2 = 'ONLINE' THEN now() ELSE NULL END, $3)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status,
         last_seen_at = CASE WHEN EXCLUDED.status = 'ONLINE' THEN now() ELSE workers.last_seen_at END,
         agent_version = COALESCE(EXCLUDED.agent_version, workers.agent_version)`,
      [workerId, status, agentVersion ?? null],
    );
    if (status === 'OFFLINE') {
      await this.pool.query(
        "UPDATE servers SET observed_state = 'UNKNOWN', updated_at = now() WHERE worker_id = $1 AND deleted_at IS NULL",
        [workerId],
      );
    }
  }

  async recordAudit(
    action: string,
    actorId: string | null,
    targetType: string,
    targetId: string | null,
    metadata: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [randomUUID(), actorId, action, targetType, targetId, JSON.stringify(metadata)],
    );
  }

  private async transaction<Result>(
    action: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function toServerSnapshot(row: ServerRow): ServerSnapshot {
  return {
    id: row.id,
    name: row.name,
    minecraftVersion: row.minecraft_version,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    workerId: row.worker_id,
    hostPort: Number(row.host_port),
    memoryMb: Number(row.memory_mb),
    cpuLimit: Number(row.cpu_limit),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastObservedAt: row.last_observed_at?.toISOString() ?? null,
    ...(row.member_role ? { accessRole: row.member_role } : {}),
  };
}

function toUserSnapshot(row: {
  id: string;
  email: string;
  role: PlatformRole;
  status: UserSnapshot['status'];
  created_at: Date;
}): UserSnapshot {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function toOperationSnapshot(row: OperationRow): OperationSnapshot {
  return {
    id: row.id,
    serverId: row.server_id,
    type: row.type,
    status: row.status,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    consoleOutput: row.result?.consoleOutput ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

async function insertAudit(
  client: PoolClient,
  action: string,
  actorId: string | null,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, string | number | boolean> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (id, actor_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), actorId, action, targetType, targetId, JSON.stringify(metadata)],
  );
}
