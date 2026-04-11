CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  upstream_id TEXT,
  model TEXT,
  app_name TEXT NOT NULL,
  app_port INTEGER NOT NULL,
  request_protocol TEXT NOT NULL,
  route_mode TEXT NOT NULL,
  success INTEGER NOT NULL,
  latency_ms INTEGER,
  status_code INTEGER,
  error_type TEXT,
  error_message TEXT,
  tokens_prompt INTEGER DEFAULT 0,
  tokens_completion INTEGER DEFAULT 0,
  tokens_total INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_upstream ON requests(upstream_id);
CREATE INDEX IF NOT EXISTS idx_requests_app ON requests(app_name);
CREATE INDEX IF NOT EXISTS idx_requests_port ON requests(app_port);
CREATE INDEX IF NOT EXISTS idx_requests_success ON requests(success);

CREATE TABLE IF NOT EXISTS upstream_states (
  upstream_id TEXT PRIMARY KEY,
  circuit_state TEXT NOT NULL,
  consecutive_failures INTEGER DEFAULT 0,
  cooldown_until INTEGER,
  last_failure_at INTEGER,
  last_success_at INTEGER,
  average_latency_ms REAL DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  last_error TEXT,
  last_failure_error TEXT,
  updated_at INTEGER NOT NULL
);
