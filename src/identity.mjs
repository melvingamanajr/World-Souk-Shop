import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './http-error.mjs';
import { transaction } from './database.mjs';

const derive = promisify(scrypt);
const tokenLifetime = 60 * 60 * 12;
const cookieName = 'wss_session';
const fallbackSalt = Buffer.from('65ae9e57529069ca7736c93249610c59', 'hex');
const blockedHash = `${fallbackSalt.toString('hex')}:${'0'.repeat(128)}`;
const hashToken = token => createHash('sha256').update(token).digest('hex');

async function deriveKey(password, salt) {
  return derive(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${(await deriveKey(password, salt)).toString('hex')}`;
}

export const demoAccounts = new Map([
  ['CONSUMER', 'demo-consumer'],
  ['MANUFACTURER', 'demo-manufacturer'],
  ['FREIGHT_PARTNER', 'demo-freight'],
  ['ADMIN', 'demo-admin']
]);

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

export function createIdentity(db, { secureCookies, demo }) {
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const findSession = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`);
  const cookie = (value, seconds) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secureCookies ? '; Secure' : ''}`;
  function sessionToken(req) {
    const match = (req.headers.cookie ?? '').match(/(?:^|;\s*)wss_session=([a-f\d]{64})(?:;|$)/);
    return match?.[1];
  }

  function newSession(req, id) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    transaction(db, () => {
      const previous = sessionToken(req);
      if (previous) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(previous));
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(hashToken(token), id, now + 1000 * tokenLifetime);
    });
    return { user: publicUser(userById.get(id)), cookie: cookie(token, tokenLifetime) };
  }

  return {
    user(req) {
      const token = sessionToken(req);
      const row = token ? findSession.get(hashToken(token), Date.now()) : undefined;
      if (row && (demo || !Array.from(demoAccounts.values()).includes(row.id))) return publicUser(row);
      return null;
    },
    async register(req, body) {
      const email = emailAddress(body.email);
      const name = label(body.name, 2, 100, 'Enter your name using 2 to 100 characters.');
      if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) {
        throw new HttpError(422, 'Use a password between 12 and 128 characters.');
      }
      if (body.acceptPrivacy !== true) throw new HttpError(422, 'Review the privacy notice before creating your account.');
      const id = randomUUID();
      const hash = await hashPassword(body.password);
      const inserted = db.prepare(`INSERT INTO users(id,email,name,password_hash) VALUES (?,?,?,?)
        ON CONFLICT(email) DO NOTHING`).run(id, email, name, hash);
      if (!inserted.changes) throw new HttpError(409, 'An account already uses this email address.');
      return newSession(req, id);
    },
    async login(req, body) {
      const email = emailAddress(body.email);
      if (typeof body.password !== 'string' || body.password.length > 128) throw new HttpError(401, 'Email or password is incorrect.');
      const row = userByEmail.get(email);
      const [salt, expected] = (row?.password_hash || blockedHash).split(':');
      const actual = await deriveKey(body.password, Buffer.from(salt, 'hex'));
      if (!row || !timingSafeEqual(actual, Buffer.from(expected, 'hex'))) throw new HttpError(401, 'Email or password is incorrect.');
      return newSession(req, row.id);
    },
    demoLogin(req, role) {
      if (!demo) throw new HttpError(404, 'Demo access is disabled.');
      const id = demoAccounts.get(role);
      if (!id) throw new HttpError(422, 'Choose a demo role.');
      return newSession(req, id);
    },
    logout(req) {
      const token = sessionToken(req);
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      return cookie('', 0);
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
