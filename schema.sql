CREATE TABLE IF NOT EXISTS links (
  code         TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  destination  TEXT NOT NULL,
  label        TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  click_count  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  creator_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_links_owner ON links (owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_links_creator ON links (creator_hash, created_at);

CREATE TABLE IF NOT EXISTS clicks (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  visitor_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_clicks_code_ts ON clicks (code, ts);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
