-- OAuth 2.1 clients, consent forms, authorization codes, and access/refresh
-- tokens for the shared MCP endpoint. Additive only: new tables.
-- Apply with the other migrations before deploying. Do not run this by hand
-- against a remote database from a pull request.

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
