SET search_path TO wss, public;

ALTER TABLE sessions ADD COLUMN operator_mfa_verified boolean NOT NULL DEFAULT false;

CREATE TABLE operator_mfa (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_envelope bytea NOT NULL CHECK (octet_length(secret_envelope) = 49),
    last_used_step bigint NOT NULL CHECK (last_used_step >= 0),
    enrolled_at_ms bigint NOT NULL CHECK (enrolled_at_ms >= 0)
);

CREATE TABLE operator_mfa_recovery (
    user_id uuid NOT NULL REFERENCES operator_mfa(user_id) ON DELETE CASCADE,
    code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    consumed_at_ms bigint CHECK (consumed_at_ms >= 0),
    PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE operator_mfa_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action text NOT NULL CHECK (action IN ('ENROLLED', 'ROTATED', 'RECOVERY_USED')),
    occurred_at_ms bigint NOT NULL CHECK (occurred_at_ms >= 0)
);

CREATE INDEX operator_mfa_audit_by_user ON operator_mfa_audit(user_id, occurred_at_ms DESC);
