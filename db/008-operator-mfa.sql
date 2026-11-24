ALTER TABLE sessions ADD COLUMN operator_mfa_verified INTEGER NOT NULL DEFAULT 0
    CHECK (operator_mfa_verified IN (0, 1));

CREATE TABLE operator_mfa (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_envelope BLOB NOT NULL CHECK (length(secret_envelope) = 49),
    last_used_step INTEGER NOT NULL CHECK (last_used_step >= 0),
    enrolled_at_ms INTEGER NOT NULL CHECK (enrolled_at_ms >= 0)
) STRICT;

CREATE TABLE operator_mfa_recovery (
    user_id TEXT NOT NULL REFERENCES operator_mfa(user_id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
    consumed_at_ms INTEGER CHECK (consumed_at_ms >= 0),
    PRIMARY KEY (user_id, code_hash)
) STRICT;

CREATE TABLE operator_mfa_audit (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('ENROLLED', 'ROTATED', 'RECOVERY_USED')),
    occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;

CREATE INDEX operator_mfa_audit_by_user ON operator_mfa_audit(user_id, occurred_at_ms DESC);
