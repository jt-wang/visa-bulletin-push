-- Share card (og:image) per bulletin month and USCIS chart, rendered by Browser Run when a new
-- bulletin or chart appears. Key: '2026-10-B' ('x' while USCIS has not picked a chart).
CREATE TABLE cards (
  key         TEXT PRIMARY KEY,
  png         BLOB NOT NULL,
  created_at  TEXT NOT NULL
);
