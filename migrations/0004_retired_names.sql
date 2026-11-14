-- A name that was renamed or deleted is never given out again.
-- link_code is the link's current code, or NULL when that link was deleted.
-- Earlier names are updated to the current code, so they do not form a chain.
CREATE TABLE IF NOT EXISTS retired_names (
  code       TEXT PRIMARY KEY,
  link_code  TEXT,
  owner_id   TEXT NOT NULL,
  retired_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retired_names_link ON retired_names (link_code);
