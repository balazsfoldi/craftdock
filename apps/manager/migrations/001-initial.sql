CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'ADMIN'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_single_admin_idx ON users(role);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ONLINE', 'OFFLINE')),
  last_seen_at TIMESTAMPTZ,
  agent_version TEXT
);

CREATE TABLE IF NOT EXISTS servers (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  minecraft_version TEXT NOT NULL,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('RUNNING', 'STOPPED')),
  observed_state TEXT NOT NULL CHECK (observed_state IN ('PROVISIONING', 'STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'ERROR', 'UNKNOWN')),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  host_port INTEGER NOT NULL CHECK (host_port BETWEEN 25565 AND 60000),
  memory_mb INTEGER NOT NULL CHECK (memory_mb BETWEEN 1024 AND 8192),
  cpu_limit REAL NOT NULL CHECK (cpu_limit BETWEEN 1 AND 8),
  eula_accepted_at TIMESTAMPTZ NOT NULL,
  container_id TEXT,
  last_observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (worker_id, host_port)
);

CREATE TABLE IF NOT EXISTS operations (
  id UUID PRIMARY KEY,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('CREATE', 'START', 'STOP')),
  idempotency_key UUID NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  payload JSONB NOT NULL,
  error_code TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 5),
  requested_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS operations_server_created_idx ON operations(server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS operations_pending_idx ON operations(status, created_at) WHERE status IN ('QUEUED', 'RUNNING');

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY,
  actor_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('001-initial') ON CONFLICT (version) DO NOTHING;
