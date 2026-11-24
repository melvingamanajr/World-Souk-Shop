CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'CONSUMER'
      CHECK (role IN ('CONSUMER', 'MANUFACTURER', 'FREIGHT_PARTNER', 'ADMIN')),
    manufacturer_id TEXT REFERENCES manufacturers(id),
    freight_partner_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (role <> 'MANUFACTURER' OR manufacturer_id IS NOT NULL),
    CHECK (role <> 'FREIGHT_PARTNER' OR freight_partner_id IS NOT NULL)
) STRICT;

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_by_expiry ON sessions(expires_at);
CREATE INDEX sessions_by_user ON sessions(user_id);

CREATE TABLE privacy_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('ERASURE', 'CORRECTION')),
    detail TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'CLOSED')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE UNIQUE INDEX privacy_one_open_per_kind ON privacy_requests(user_id, kind) WHERE status = 'RECEIVED';
