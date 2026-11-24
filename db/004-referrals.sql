CREATE TABLE affiliate_codes (
    code TEXT PRIMARY KEY CHECK (length(code) BETWEEN 8 AND 24),
    referrer_id TEXT NOT NULL UNIQUE REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX orders_by_referral ON orders(referral_code, status) WHERE referral_code IS NOT NULL;
