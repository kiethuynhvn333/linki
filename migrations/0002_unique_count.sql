-- All-time unique clicks live on the link row, so stats pages no longer
-- re-count every click. The index makes "has this visitor clicked today" a
-- single lookup.
ALTER TABLE links ADD COLUMN unique_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_clicks_code_visitor ON clicks (code, visitor_hash);
UPDATE links SET unique_count = (
  SELECT COUNT(DISTINCT visitor_hash) FROM clicks WHERE clicks.code = links.code
);
