-- Visa Bulletin Push: initial schema.

-- One row per bulletin month. `snapshot` is the validated ingest JSON
-- (the public latest.json / bulletins/{month}.json body).
CREATE TABLE bulletins (
  month         TEXT PRIMARY KEY,            -- 'YYYY-MM'
  snapshot      TEXT NOT NULL,               -- JSON
  fingerprint   TEXT NOT NULL,               -- sha256 over the signal fields (cells + USCIS chart for this month)
  uscis_chart   TEXT CHECK (uscis_chart IN ('A', 'B')),  -- chart USCIS picked for this month, NULL if unknown
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- One row per emitted event; also the Atom feed.
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('bulletin.published', 'bulletin.updated', 'uscis.chart_decided')),
  month       TEXT NOT NULL,
  message     TEXT NOT NULL,
  data        TEXT NOT NULL,                 -- snapshot JSON at the time of the event
  created_at  TEXT NOT NULL
);
CREATE INDEX events_created_at ON events (created_at DESC);

-- Webhook subscriptions. No emails, names or priority dates are stored.
CREATE TABLE subscriptions (
  id                    TEXT PRIMARY KEY,
  url                   TEXT NOT NULL,
  events                TEXT NOT NULL,       -- JSON array of event types
  signing_secret_enc    TEXT NOT NULL,       -- AES-GCM(TOKEN_ENC_KEY), base64(iv || ciphertext)
  bearer_token_enc      TEXT,                -- AES-GCM(TOKEN_ENC_KEY), NULL when not given
  manage_token_sha256   TEXT NOT NULL,       -- hex
  ip_hash               TEXT NOT NULL,       -- sha256(IP_HASH_SALT ':' client IP), hex
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  total_deliveries      INTEGER NOT NULL DEFAULT 0,
  total_failures        INTEGER NOT NULL DEFAULT 0,
  last_delivery_id      TEXT,
  last_success_at       TEXT,
  disabled_at           TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX subscriptions_status ON subscriptions (status);

-- One row per (event, subscription). The Queue message carries only the delivery id.
CREATE TABLE deliveries (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  subscription_id   TEXT NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'skipped')),
  enqueued          INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_status_code  INTEGER,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX deliveries_event ON deliveries (event_id);
CREATE INDEX deliveries_subscription ON deliveries (subscription_id, created_at DESC);
CREATE INDEX deliveries_unenqueued ON deliveries (enqueued) WHERE enqueued = 0;

-- Registration abuse limit, per hashed client IP per UTC day.
CREATE TABLE registration_limits (
  ip_hash   TEXT NOT NULL,
  day       TEXT NOT NULL,                   -- 'YYYY-MM-DD' UTC
  attempts  INTEGER NOT NULL DEFAULT 0,
  created   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);
