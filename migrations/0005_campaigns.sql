-- Saved UTM campaigns for an MCP connector. owner_id is the owner behind the
-- token. A name is created or updated, and rows are never deleted.
-- Apply with the other migrations before deploying. Do not run this by hand
-- against a remote database from a pull request.

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
