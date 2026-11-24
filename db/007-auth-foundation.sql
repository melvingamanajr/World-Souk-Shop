CREATE TABLE auth_login_windows (
    subject_hash TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL CHECK (attempts > 0),
    expires_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX auth_login_windows_expiry ON auth_login_windows(expires_at_ms);

CREATE TABLE auth_audit (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL CHECK (action IN ('REGISTERED', 'ADMIN_BOOTSTRAPPED', 'SIGNED_IN', 'SIGN_IN_FAILED',
        'PASSWORD_CHANGED', 'SESSIONS_REVOKED')),
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX auth_audit_by_user ON auth_audit(user_id, occurred_at DESC);
