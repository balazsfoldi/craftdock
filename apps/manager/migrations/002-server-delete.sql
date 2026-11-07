ALTER TABLE servers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_worker_id_host_port_key;
CREATE UNIQUE INDEX IF NOT EXISTS servers_active_worker_port_idx
  ON servers(worker_id, host_port) WHERE deleted_at IS NULL;

ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check
  CHECK (type IN ('CREATE', 'START', 'STOP', 'DELETE'));

INSERT INTO schema_migrations(version) VALUES ('002-server-delete') ON CONFLICT (version) DO NOTHING;