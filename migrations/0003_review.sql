-- Staging review comments (Figma-style pins). Apply to the staging database only:
--   npx wrangler d1 migrations apply linki-staging --env staging --remote
-- The tables are empty and additive, so applying them to production is harmless.
-- The feature stays off until the REVIEW_KEY secret is set, which is staging only.

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
