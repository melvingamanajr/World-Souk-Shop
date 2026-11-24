CREATE TABLE outbox_relay_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    lease_id TEXT,
    lease_until_ms INTEGER NOT NULL DEFAULT 0,
    retry_at_ms INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    last_success_at TEXT,
    CHECK ((lease_id IS NULL AND lease_until_ms = 0) OR (lease_id IS NOT NULL AND lease_until_ms > 0))
) STRICT;

INSERT INTO outbox_relay_state(singleton) VALUES (1);
