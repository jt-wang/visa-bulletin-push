-- MCP Events extension, webhook delivery mode (ChatGPT "MCP Events").
-- Spec: https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
-- No personal data: the callback URL, the event name, the (empty) arguments and the client-supplied
-- whsec_ signing secret, encrypted with TOKEN_ENC_KEY like the /v1/webhooks secrets.

CREATE TABLE mcp_subscriptions (
  id                    TEXT PRIMARY KEY,    -- 'sub_' + first 32 hex of sha256(canonical [principal, url, event, arguments])
  principal             TEXT NOT NULL,       -- always 'anonymous': the MCP endpoint has no accounts
  event                 TEXT NOT NULL CHECK (event IN ('bulletin.published', 'bulletin.updated', 'uscis.chart_decided')),
  arguments             TEXT NOT NULL,       -- canonical JSON
  url                   TEXT NOT NULL,
  secret_enc            TEXT NOT NULL,       -- AES-GCM(TOKEN_ENC_KEY) of the whsec_ secret
  secret_sha256         TEXT NOT NULL,       -- detects rotation without decrypting
  old_secret_enc        TEXT,                -- previous secret, still used for dual signing until old_secret_until
  old_secret_until      TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  expires_at            TEXT NOT NULL,       -- = refreshBefore granted to the client
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  total_deliveries      INTEGER NOT NULL DEFAULT 0,
  total_failures        INTEGER NOT NULL DEFAULT 0,
  last_delivery_at      TEXT,
  last_error            TEXT,                -- category only: timeout, connection_refused, http_4xx, http_5xx
  failed_since          TEXT,
  disabled_at           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX mcp_subscriptions_event ON mcp_subscriptions (event, status, expires_at);
CREATE INDEX mcp_subscriptions_expires ON mcp_subscriptions (expires_at);

-- Successful verification handshakes, per (principal, url) and bound to the secret that signed them.
CREATE TABLE mcp_verified_callbacks (
  principal      TEXT NOT NULL,
  url            TEXT NOT NULL,
  secret_sha256  TEXT NOT NULL,
  verified_at    TEXT NOT NULL,
  PRIMARY KEY (principal, url)
);

-- Handshake POSTs per callback URL per UTC day (each one is an outbound request to a client-chosen URL).
CREATE TABLE mcp_verification_attempts (
  url_sha256  TEXT NOT NULL,
  day         TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (url_sha256, day)
);

-- One row per (event, MCP subscription). The Queue message carries only the id.
CREATE TABLE mcp_deliveries (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  subscription_id   TEXT NOT NULL REFERENCES mcp_subscriptions (id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'skipped')),
  enqueued          INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_status_code  INTEGER,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX mcp_deliveries_subscription ON mcp_deliveries (subscription_id);
CREATE INDEX mcp_deliveries_unenqueued ON mcp_deliveries (enqueued) WHERE enqueued = 0;
