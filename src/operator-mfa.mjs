import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { transaction } from './database.mjs';
import { HttpError } from './http-error.mjs';

const issuer = 'World Souk & Shop';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const seedBytes = 20;
const stepMs = 30_000;
const envelopeVersion = 1;
const nonceBytes = 12;
const tagBytes = 16;
const ciphertextOffset = 1 + nonceBytes + tagBytes;
const unavailable = () => new HttpError(503, 'Operator authentication is temporarily unavailable.', 'MFA_UNAVAILABLE');

export function parseOperatorMfaKey(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && /^[a-zA-Z0-9+/]{43}=$/.test(value)) {
    const key = Buffer.from(value, 'base64');
    if (key.length === 32 && key.toString('base64') === value) return key;
  }
  throw new Error('WSS_OPERATOR_MFA_KEY must be a base64-encoded 32-byte key.');
}

function encodeSeed(seed) {
  let buffered = 0;
  let bits = 0;
  let encoded = '';
  for (const byte of seed) {
    buffered = (buffered << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(buffered >>> bits) & 31];
    }
  }
  return encoded;
}

function decodeSeed(encoded) {
  if (typeof encoded !== 'string' || !/^[A-Z2-7]{32}$/.test(encoded)) {
    throw new HttpError(422, 'Use the authenticator secret generated for this enrollment.', 'INVALID_MFA_SECRET');
  }
  const seed = Buffer.alloc(seedBytes);
  let buffered = 0;
  let bits = 0;
  let offset = 0;
  for (const character of encoded) {
    buffered = (buffered << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      seed[offset++] = (buffered >>> bits) & 255;
    }
  }
  return seed;
}

function matchingStep(seed, code, now) {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const candidate = Buffer.from(code, 'ascii');
  const current = Math.floor(now / stepMs);
  const counter = Buffer.alloc(8);
  let match = null;
  for (let step = Math.max(0, current - 1); step <= current + 1; step++) {
    counter.writeBigUInt64BE(BigInt(step));
    const digest = createHmac('sha1', seed).update(counter).digest();
    const offset = digest.at(-1) & 15;
    const truncated = digest.readUInt32BE(offset) & 0x7fffffff;
    const expected = String(truncated % 1_000_000).padStart(6, '0');
    if (timingSafeEqual(candidate, Buffer.from(expected, 'ascii'))) match = step;
  }
  return match;
}

const associatedData = userId => Buffer.from(`wss:operator-totp:v1\0${userId}`);

function sealSeed(key, seed, userId) {
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associatedData(userId));
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  return Buffer.concat([Buffer.from([envelopeVersion]), nonce, cipher.getAuthTag(), ciphertext]);
}

function openSeed(key, envelope, userId) {
  if (envelope.length !== ciphertextOffset + seedBytes || envelope[0] !== envelopeVersion) throw unavailable();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(1, 1 + nonceBytes));
    decipher.setAAD(associatedData(userId));
    decipher.setAuthTag(envelope.subarray(1 + nonceBytes, ciphertextOffset));
    const decrypted = decipher.update(envelope.subarray(ciphertextOffset));
    try {
      return Buffer.concat([decrypted, decipher.final()]);
    } finally {
      decrypted.fill(0);
    }
  } catch {
    throw unavailable();
  }
}

function randomRecoveryCode() {
  return randomBytes(16).toString('hex').toUpperCase().match(/.{8}/g).join('-');
}

function recoveryHash(userId, code) {
  if (!/^(?:[a-f0-9]{32}|(?:[a-f0-9]{8}-){3}[a-f0-9]{8})$/i.test(code)) return null;
  return createHash('sha256').update(`wss:operator-recovery:v1\0${userId}\0`)
    .update(code.replaceAll('-', '').toUpperCase()).digest('hex');
}

const codeInput = value => typeof value === 'string' && value.length <= 64 ? value.trim() : '';

export function createOperatorMfa(db, { key, clock = Date.now } = {}) {
  if (key !== undefined && (!Buffer.isBuffer(key) || key.length !== 32)) throw new TypeError('Pass a 32-byte operator MFA key.');
  const encryptionKey = key ? Buffer.from(key) : null;
  const administrator = db.prepare("SELECT email FROM users WHERE id = ? AND role = 'ADMIN' AND id <> 'demo-admin'");
  const factorByUser = db.prepare(`SELECT m.secret_envelope, m.last_used_step FROM operator_mfa m
    JOIN users u ON u.id = m.user_id WHERE m.user_id = ? AND u.role = 'ADMIN' AND u.id <> 'demo-admin'`);
  const saveFactor = db.prepare(`INSERT INTO operator_mfa(user_id,secret_envelope,last_used_step,enrolled_at_ms) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET secret_envelope = excluded.secret_envelope,
      last_used_step = excluded.last_used_step, enrolled_at_ms = excluded.enrolled_at_ms`);
  const deleteRecoveryCodes = db.prepare('DELETE FROM operator_mfa_recovery WHERE user_id = ?');
  const saveRecoveryCode = db.prepare('INSERT INTO operator_mfa_recovery(user_id,code_hash) VALUES (?,?)');
  const advanceStep = db.prepare('UPDATE operator_mfa SET last_used_step = ? WHERE user_id = ? AND last_used_step < ?');
  const consumeRecovery = db.prepare(`UPDATE operator_mfa_recovery SET consumed_at_ms = ?
    WHERE user_id = ? AND code_hash = ? AND consumed_at_ms IS NULL`);
  const revokeSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const audit = db.prepare('INSERT INTO operator_mfa_audit(user_id,action,occurred_at_ms) VALUES (?,?,?)');

  function requireAdministrator(userId) {
    const operator = administrator.get(userId);
    if (!operator) throw new HttpError(404, 'Operator account not found.', 'OPERATOR_NOT_FOUND');
    return operator;
  }

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
    return value;
  }

  return {
    isEnrolled(userId) { return Boolean(factorByUser.get(userId)); },
    prepareEnrollment(userId) {
      if (!encryptionKey) throw unavailable();
      const { email } = requireAdministrator(userId);
      const seed = randomBytes(seedBytes);
      const secret = encodeSeed(seed);
      seed.fill(0);
      const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
      const parameters = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
      return { secret, uri: `otpauth://totp/${label}?${parameters}` };
    },
    enroll(userId, { secret, code }) {
      if (!encryptionKey) throw unavailable();
      const seed = decodeSeed(secret);
      try {
        return transaction(db, () => {
          requireAdministrator(userId);
          const timestamp = now();
          const step = matchingStep(seed, codeInput(code), timestamp);
          if (step === null) throw new HttpError(422, 'Enter a current code from the authenticator.', 'INVALID_MFA_CODE');
          const replacing = Boolean(factorByUser.get(userId));
          const recoveryCodes = Array.from({ length: 10 }, randomRecoveryCode);
          saveFactor.run(userId, sealSeed(encryptionKey, seed, userId), step, timestamp);
          deleteRecoveryCodes.run(userId);
          for (const recoveryCode of recoveryCodes) saveRecoveryCode.run(userId, recoveryHash(userId, recoveryCode));
          revokeSessions.run(userId);
          audit.run(userId, replacing ? 'ROTATED' : 'ENROLLED', timestamp);
          return { recoveryCodes };
        });
      } finally {
        seed.fill(0);
      }
    },
    consume(userId, value) {
      const code = codeInput(value);
      const verify = () => {
        const factor = factorByUser.get(userId);
        if (!factor) return false;
        if (!encryptionKey) throw unavailable();
        const hash = recoveryHash(userId, code);
        if (!hash && !/^[0-9]{6}$/.test(code)) return false;
        const seed = openSeed(encryptionKey, factor.secret_envelope, userId);
        try {
          const timestamp = now();
          if (hash) {
            if (!consumeRecovery.run(timestamp, userId, hash).changes) return false;
            revokeSessions.run(userId);
            audit.run(userId, 'RECOVERY_USED', timestamp);
            return 'recovery';
          }
          const step = matchingStep(seed, code, timestamp);
          if (step === null || step <= factor.last_used_step) return false;
          return advanceStep.run(step, userId, step).changes ? 'totp' : false;
        } finally {
          seed.fill(0);
        }
      };
      // Participate in the sign-in transaction so the proof and new session commit together.
      return db.isTransaction ? verify() : transaction(db, verify);
    }
  };
}
