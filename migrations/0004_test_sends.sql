-- Test alerts sent on request (POST /v1/webhooks/:id/test, and the welcome event after an MCP
-- subscription), counted per target per UTC day. Each one is an outbound request, so it is capped.
CREATE TABLE test_sends (
  target  TEXT NOT NULL,   -- subscription id (wh_… or sub_…)
  day     TEXT NOT NULL,   -- YYYY-MM-DD (UTC)
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (target, day)
);
