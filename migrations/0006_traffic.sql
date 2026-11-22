-- Who created a link, and whether a click was a person.
-- created_via is 'web' or 'mcp'. traffic is 'human', 'bot', 'datacenter' or 'internal'.
-- Both are nullable. Existing rows stay NULL, which means unknown.
-- Reports count a NULL click with people. Apply this with the other
-- migrations before deploying. Do not run it by hand against a remote database.

ALTER TABLE links ADD COLUMN created_via TEXT;
ALTER TABLE links ADD COLUMN traffic TEXT;
ALTER TABLE clicks ADD COLUMN traffic TEXT;
