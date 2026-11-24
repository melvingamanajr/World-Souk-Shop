SET search_path TO wss, public;

CREATE TABLE auth_login_windows (
    subject_hash text PRIMARY KEY,
    attempts integer NOT NULL CHECK (attempts > 0),
    expires_at_ms bigint NOT NULL
);

CREATE INDEX auth_login_windows_expiry ON auth_login_windows(expires_at_ms);

CREATE TABLE auth_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    action text NOT NULL CHECK (action IN ('REGISTERED', 'ADMIN_BOOTSTRAPPED', 'SIGNED_IN', 'SIGN_IN_FAILED',
        'PASSWORD_CHANGED', 'SESSIONS_REVOKED')),
    occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX auth_audit_by_user ON auth_audit(user_id, occurred_at DESC);
