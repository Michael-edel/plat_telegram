INSERT INTO users (username, password_hash, role, is_active, display_name, created_at, updated_at)
VALUES (
  'integration_1c',
  'SYSTEM_EXTERNAL_INTEGRATION_STUB_NOT_FOR_MANUAL_LOGIN',
  'editor',
  1,
  '1C Integration',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT(username) DO NOTHING;

CREATE TABLE IF NOT EXISTS processed_1c_events (
  event_id TEXT PRIMARY KEY,
  entity_type TEXT NULL,
  entity_id INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing', 'processed', 'failed')),
  error_message TEXT NULL,
  processed_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_1c_events_status_created
ON processed_1c_events(status, created_at);
