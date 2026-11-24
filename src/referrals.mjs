import { randomBytes } from 'node:crypto';

export function createReferrals(db) {
  function account(userId) {
    const row = db.prepare('SELECT code FROM affiliate_codes WHERE referrer_id = ?').get(userId);
    if (!row) return { code: null, orderCount: 0, creditedCents: 0, pendingCents: 0 };
    return db.prepare(`SELECT ? AS code,
      COUNT(CASE WHEN status IN ('PAID','PROCESSING','IN_TRANSIT','DELIVERED') THEN 1 END) AS orderCount,
      COALESCE(SUM(CASE WHEN status IN ('PAID','PROCESSING','IN_TRANSIT','DELIVERED') THEN affiliate_cents END), 0) AS creditedCents,
      COALESCE(SUM(CASE WHEN status = 'PENDING' THEN affiliate_cents END), 0) AS pendingCents
      FROM orders WHERE referral_code = ?`).get(row.code, row.code);
  }

  return {
    account,
    activate(userId) {
      const code = `WSS-${randomBytes(8).toString('hex').toUpperCase()}`;
      db.prepare('INSERT INTO affiliate_codes(code,referrer_id) VALUES (?,?) ON CONFLICT(referrer_id) DO NOTHING').run(code, userId);
      return account(userId);
    }
  };
}
