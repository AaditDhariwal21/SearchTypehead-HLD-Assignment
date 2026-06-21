-- queries: one row per distinct (normalized) search term.
--
-- WHY two term columns:
--   `term`         is the lowercased + trimmed form. This is what we MATCH and
--                  INDEX against. Storing the normalized form means prefix
--                  lookups are case-insensitive "for free" — no per-row LOWER()
--                  at query time (which would defeat the index).
--   `display_term` is the original casing as it appeared in the source data.
--                  This is what the UI shows. We never match against it.
--
-- WHY `term` is UNIQUE (and why there is NO separate CREATE INDEX on it):
--   A UNIQUE constraint already builds a B-tree index on `term`. Adding a second
--   plain index on the same column would be pure redundancy. That unique index
--   IS our prefix-search index — the /suggest range scan
--   (WHERE term >= ? AND term < ?) rides it directly.
--   UNIQUE(term) also makes seeding's case-collision merge clean: duplicate rows
--   that collapse to the same normalized term hit ON CONFLICT(term) and get their
--   counts summed instead of overwriting each other.
CREATE TABLE IF NOT EXISTS queries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  term             TEXT    NOT NULL UNIQUE,
  display_term     TEXT    NOT NULL,
  count            INTEGER NOT NULL DEFAULT 0,
  -- ISO-8601 timestamp of the most recent /search for this term.
  -- NULL until first searched. Feeds recency-aware "trending" ranking (step 7).
  last_searched_at TEXT
);
