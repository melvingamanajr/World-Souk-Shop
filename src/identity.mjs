import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './http-error.mjs';
import { transaction } from './database.mjs';

const derive = promisify(scrypt);
const tokenLifetime = 60 * 60 * 12;
const cookieName = 'wss_session';
const currentHash = 'scrypt-v2';
const minPasswordLength = 15;
const maxPasswordLength = 128;
const loginWindowMs = 5 * 60 * 1000;
const loginAttempts = 5;
const fallbackSalt = Buffer.from('65ae9e57529069ca7736c93249610c59', 'hex');
const absentDigest = Buffer.alloc(64);
const hashToken = token => createHash('sha256').update(token).digest('hex');

async function deriveKey(password, salt, legacy = false) {
  return derive(password, salt, 64, { N: 2 ** 15, r: 8, p: legacy ? 1 : 3, maxmem: 64 * 1024 * 1024 });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  return `${currentHash}:${salt.toString('hex')}:${(await deriveKey(password, salt)).toString('hex')}`;
}

export const demoAccounts = new Map([
  ['CONSUMER', 'demo-consumer'],
  ['MANUFACTURER', 'demo-manufacturer'],
  ['FREIGHT_PARTNER', 'demo-freight'],
  ['ADMIN', 'demo-admin']
]);
const isDemoAccount = id => Array.from(demoAccounts.values()).includes(id);

const publicUser = ({ id, name, email, role, manufacturer_id, freight_partner_id }) => ({
  id, name, email, role, manufacturerId: manufacturer_id, freightPartnerId: freight_partner_id
});

function emailAddress(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(422, 'Enter a valid email address.');
  }
  return email;
}

function label(value, min, max, message) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min || text.length > max) throw new HttpError(422, message);
  return text;
}

function passwordInput(password) {
  if (typeof password !== 'string' || password.length < minPasswordLength || password.length > maxPasswordLength) {
    throw new HttpError(422, `Use a password between ${minPasswordLength} and ${maxPasswordLength} characters.`);
  }
  return password;
}

async function passwordMatches(password, storedHash) {
  const parts = /^(?:(scrypt-v2):)?([0-9a-f]{32}):([0-9a-f]{128})$/.exec(storedHash ?? '');
  const legacy = Boolean(parts && !parts[1]);
  const salt = parts ? Buffer.from(parts[2], 'hex') : fallbackSalt;
  const actual = await deriveKey(password, salt, legacy);
  const same = timingSafeEqual(actual, parts ? Buffer.from(parts[3], 'hex') : absentDigest);
  return { valid: Boolean(parts && same), legacy };
}

function audit(db, userId, action) {
  db.prepare('INSERT INTO auth_audit(id,user_id,action) VALUES (?,?,?)').run(randomUUID(), userId, action);
}

export async function bootstrapAdministrator(db, body) {
  const email = emailAddress(body.email);
  const name = label(body.name, 2, 100, 'Enter an operator name using 2 to 100 characters.');
  const hash = await hashPassword(passwordInput(body.password));
  return transaction(db, () => {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'demo_seed'").get()) {
      throw new HttpError(409, 'Choose the non-demo database.', 'DEMO_DATABASE');
    }
    if (db.prepare("SELECT 1 FROM users WHERE role = 'ADMIN'").get()) {
      throw new HttpError(409, 'The initial administrator already exists.', 'ADMIN_EXISTS');
    }
    const id = randomUUID();
    const inserted = db.prepare(`INSERT INTO users(id,email,name,password_hash,role) VALUES (?,?,?,?,'ADMIN')
      ON CONFLICT(email) DO NOTHING`).run(id, email, name, hash);
    if (!inserted.changes) throw new HttpError(409, 'Choose an email address without an existing account.', 'EMAIL_IN_USE');
    audit(db, id, 'ADMIN_BOOTSTRAPPED');
    return { id, role: 'ADMIN' };
  });
}

export function createIdentity(db, { secureCookies, demo, clock = Date.now }) {
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const findSession = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`);
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const deleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const clearLoginWindow = db.prepare('DELETE FROM auth_login_windows WHERE subject_hash = ?');
  const removeExpiredWindows = db.prepare('DELETE FROM auth_login_windows WHERE expires_at_ms <= ?');
  const reserveLoginAttempt = db.prepare(`INSERT INTO auth_login_windows(subject_hash,attempts,expires_at_ms)
    VALUES (?,1,?) ON CONFLICT(subject_hash) DO UPDATE SET attempts = attempts + 1
    WHERE attempts < ? RETURNING attempts`);
  const getLoginWindow = db.prepare('SELECT expires_at_ms FROM auth_login_windows WHERE subject_hash = ?');
  const cookie = (value, seconds) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secureCookies ? '; Secure' : ''}`;
  function sessionToken(req) {
    const match = (req.headers.cookie ?? '').match(/(?:^|;\s*)wss_session=([a-f\d]{64})(?:;|$)/);
    return match?.[1];
  }

  function newSession(req, id) {
    const token = randomBytes(32).toString('hex');
    const now = clock();
    const previous = sessionToken(req);
    if (previous) deleteSession.run(hashToken(previous));
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), id, now + 1000 * tokenLifetime);
    return { user: publicUser(userById.get(id)), cookie: cookie(token, tokenLifetime) };
  }

  function claimAttempt(email) {
    const key = hashToken(email);
    return transaction(db, () => {
      const now = clock();
      removeExpiredWindows.run(now);
      if (!reserveLoginAttempt.get(key, now + loginWindowMs, loginAttempts)) {
        const error = new HttpError(429, 'Too many sign-in attempts. Try again shortly.', 'LOGIN_THROTTLED');
        error.retryAfter = Math.max(1, Math.ceil((getLoginWindow.get(key).expires_at_ms - now) / 1000));
        throw error;
      }
      return key;
    });
  }

  function invalidCredentials() { return new HttpError(401, 'Email or password is incorrect.', 'INVALID_CREDENTIALS'); }

  return {
    user(req) {
      const token = sessionToken(req);
      const row = token ? findSession.get(hashToken(token), clock()) : undefined;
      if (row && (demo || !isDemoAccount(row.id))) return publicUser(row);
      return null;
    },
    async register(req, body) {
      const email = emailAddress(body.email);
      const name = label(body.name, 2, 100, 'Enter your name using 2 to 100 characters.');
      const password = passwordInput(body.password);
      if (body.acceptPrivacy !== true) throw new HttpError(422, 'Review the privacy notice before creating your account.');
      const id = randomUUID();
      const hash = await hashPassword(password);
      return transaction(db, () => {
        const inserted = db.prepare(`INSERT INTO users(id,email,name,password_hash) VALUES (?,?,?,?)
          ON CONFLICT(email) DO NOTHING`).run(id, email, name, hash);
        if (!inserted.changes) throw new HttpError(409, 'An account already uses this email address.');
        audit(db, id, 'REGISTERED');
        return newSession(req, id);
      });
    },
    async login(req, body) {
      const email = emailAddress(body.email);
      if (typeof body.password !== 'string' || body.password.length > maxPasswordLength) throw invalidCredentials();
      const key = claimAttempt(email);
      const row = userByEmail.get(email);
      const account = row && !isDemoAccount(row.id) ? row : null;
      const checked = await passwordMatches(body.password, account?.password_hash);
      if (!checked.valid || !account) {
        if (account) audit(db, account.id, 'SIGN_IN_FAILED');
        throw invalidCredentials();
      }
      const upgradedHash = checked.legacy ? await hashPassword(body.password) : null;
      return transaction(db, () => {
        if (userById.get(account.id)?.password_hash !== account.password_hash) throw invalidCredentials();
        if (upgradedHash) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(upgradedHash, account.id);
        clearLoginWindow.run(key);
        audit(db, account.id, 'SIGNED_IN');
        return newSession(req, account.id);
      });
    },
    demoLogin(req, role) {
      if (!demo) throw new HttpError(404, 'Demo access is disabled.');
      const id = demoAccounts.get(role);
      if (!id) throw new HttpError(422, 'Choose a demo role.');
      return transaction(db, () => newSession(req, id));
    },
    logout(req) {
      const token = sessionToken(req);
      if (token) deleteSession.run(hashToken(token));
      return cookie('', 0);
    },
    logoutAll(user) {
      return transaction(db, () => {
        deleteUserSessions.run(user.id);
        audit(db, user.id, 'SESSIONS_REVOKED');
        return cookie('', 0);
      });
    },
    async changePassword(req, user, body) {
      if (isDemoAccount(user.id)) throw new HttpError(403, 'Create your own account to change a password.');
      const next = passwordInput(body.newPassword);
      if (typeof body.currentPassword !== 'string' || body.currentPassword.length > maxPasswordLength) throw invalidCredentials();
      if (next === body.currentPassword) throw new HttpError(422, 'Choose a different password.');
      const row = userById.get(user.id);
      if (!row) throw invalidCredentials();
      const key = claimAttempt(row.email);
      const verified = await passwordMatches(body.currentPassword, row.password_hash);
      if (!verified.valid) {
        audit(db, user.id, 'SIGN_IN_FAILED');
        throw invalidCredentials();
      }
      const hash = await hashPassword(next);
      return transaction(db, () => {
        const token = sessionToken(req);
        const live = token ? findSession.get(hashToken(token), clock()) : null;
        if (live?.id !== user.id || live.password_hash !== row.password_hash) throw invalidCredentials();
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
        deleteUserSessions.run(user.id);
        clearLoginWindow.run(key);
        audit(db, user.id, 'PASSWORD_CHANGED');
        return newSession(req, user.id);
      });
    },
    createPrivacyRequest(user, body) {
      if (!['ERASURE', 'CORRECTION'].includes(body.kind)) throw new HttpError(422, 'Choose a request type.');
      const detail = label(body.detail, 0, 1000, 'Use at most 1,000 characters.');
      const id = randomUUID();
      const row = db.prepare(`INSERT INTO privacy_requests(id,user_id,kind,detail) VALUES (?,?,?,?)
        ON CONFLICT DO NOTHING RETURNING id,kind,status`).get(id, user.id, body.kind, detail);
      if (!row) throw new HttpError(409, 'A request of this type is already open.');
      return row;
    },
    privacyRequests(user) {
      return db.prepare(`SELECT id,kind,detail,status,created_at AS createdAt FROM privacy_requests
        WHERE user_id = ? ORDER BY created_at DESC`).all(user.id);
    }
  };
}
