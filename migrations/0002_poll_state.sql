-- Scheduled poll state (PDF ETag, USCIS cache, alert dedup dates). Key/value, JSON values.
CREATE TABLE poll_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
