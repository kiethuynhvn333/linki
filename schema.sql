-- Idempotent schema for a new Linki database. Existing databases are updated
-- by migrations/ (wrangler d1 migrations apply). Statements here only create
-- tables and indexes if they are missing. The campaigns statements at the
-- bottom match migrations/0005_campaigns.sql. created_via and traffic match
-- the columns migrations/0006_traffic.sql adds to an existing database.

CREATE TABLE IF NOT EXISTS links (
  code         TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  destination  TEXT NOT NULL,
  label        TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  click_count  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  creator_hash TEXT,
  unique_count INTEGER NOT NULL DEFAULT 0,
  created_via  TEXT,
  traffic      TEXT
);
CREATE INDEX IF NOT EXISTS idx_links_owner ON links (owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_links_creator ON links (creator_hash, created_at);

CREATE TABLE IF NOT EXISTS clicks (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  visitor_hash TEXT,
  traffic      TEXT
);
CREATE INDEX IF NOT EXISTS idx_clicks_code_ts ON clicks (code, ts);
CREATE INDEX IF NOT EXISTS idx_clicks_code_visitor ON clicks (code, visitor_hash);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_comments (
  id           INTEGER PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  path         TEXT NOT NULL,
  selector     TEXT NOT NULL,
  element_desc TEXT NOT NULL,
  x_pct        REAL NOT NULL,
  y_pct        REAL NOT NULL,
  viewport_w   INTEGER NOT NULL,
  user_agent   TEXT NOT NULL,
  author       TEXT NOT NULL,
  body         TEXT NOT NULL,
  mentions     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'fixed')),
  status_note  TEXT,
  pr_url       TEXT,
  assignee     TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_comments_status ON review_comments (status);
CREATE INDEX IF NOT EXISTS idx_review_comments_path ON review_comments (path);

CREATE TABLE IF NOT EXISTS review_replies (
  id         INTEGER PRIMARY KEY,
  comment_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_replies_comment ON review_replies (comment_id, id);

CREATE TABLE IF NOT EXISTS retired_names (
  code       TEXT PRIMARY KEY,
  link_code  TEXT,
  owner_id   TEXT NOT NULL,
  retired_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retired_names_link ON retired_names (link_code);

CREATE TABLE IF NOT EXISTS campaigns (
  owner_id            TEXT NOT NULL,
  name                TEXT NOT NULL,
  utm_source          TEXT NOT NULL,
  utm_medium          TEXT NOT NULL,
  utm_campaign        TEXT NOT NULL,
  utm_content_pattern TEXT,
  notes               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (owner_id, name)
);
CREATE INDEX IF NOT EXISTS idx_campaigns_owner ON campaigns (owner_id, updated_at);

-- OAuth 2.1 for the shared /mcp endpoint. Matches migrations/0007_oauth.sql.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_consents (
  token_hash     TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state          TEXT,
  resource       TEXT NOT NULL,
  scope          TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  owner_id       TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource       TEXT NOT NULL,
  scope          TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  grant_id   TEXT NOT NULL,
  resource   TEXT NOT NULL,
  scope      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_owner ON oauth_tokens (owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens (grant_id);
