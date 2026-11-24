import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { openDatabase, transaction } from '../src/database.mjs';
import { createOperatorMfa, parseOperatorMfaKey } from '../src/operator-mfa.mjs';

const administratorId = 'operator-test';
const key = Buffer.alloc(32, 42);
const rfcSeed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function fixture(context) {
  const db = openDatabase(':memory:');
  context.after(() => db.close());
  const insert = db.prepare('INSERT INTO users(id,email,name,password_hash,role) VALUES (?,?,?,?,?)');
  insert.run(administratorId, 'operator+test@example.test', 'Operator Test', 'fixture', 'ADMIN');
  insert.run('another-operator', 'other@example.test', 'Other Operator', 'fixture', 'ADMIN');
  insert.run('buyer', 'buyer@example.test', 'Buyer', 'fixture', 'CONSUMER');
  insert.run('demo-admin', 'demo@example.test', 'Demo', 'fixture', 'ADMIN');
  let time = 59_000;
  const clock = () => time;
  return {
    db, clock, setTime: value => { time = value; },
    mfa: createOperatorMfa(db, { key, clock }),
    addSession: (id, owner = administratorId) => db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)')
      .run(id, owner, time + 60_000),
    sessionIds: () => db.prepare('SELECT token_hash FROM sessions ORDER BY token_hash').all().map(row => row.token_hash)
  };
}

function authenticatorCode(secret, time) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const binary = [...secret].map(character => alphabet.indexOf(character).toString(2).padStart(5, '0')).join('');
  const seed = Buffer.from(binary.match(/.{8}/g).map(byte => parseInt(byte, 2)));
  const counter = Buffer.from(Math.floor(time / 30_000).toString(16).padStart(16, '0'), 'hex');
  const digest = createHmac('sha1', seed).update(counter).digest();
  return String((digest.readUInt32BE(digest[19] % 16) % 0x80000000) % 1_000_000).padStart(6, '0');
}

test('operator MFA requires a canonical base64 key encoding exactly 32 bytes', () => {
  assert.equal(parseOperatorMfaKey(undefined), undefined);
  assert.deepEqual(parseOperatorMfaKey(key.toString('base64')), key);
  for (const invalid of ['', 'A'.repeat(44), Buffer.alloc(16).toString('base64'), `${key.toString('base64')}\n`]) {
    assert.throws(() => parseOperatorMfaKey(invalid), /base64-encoded 32-byte/);
  }
  assert.throws(() => parseOperatorMfaKey(`${'A'.repeat(42)}B=`), /base64-encoded 32-byte/);
});

test('RFC 6238 SHA-1 vectors match the six-digit authenticator profile', context => {
  const { mfa, setTime } = fixture(context);
  const vectors = [
    [59, '287082'], [1_111_111_109, '081804'], [1_111_111_111, '050471'],
    [1_234_567_890, '005924'], [2_000_000_000, '279037'], [20_000_000_000, '353130']
  ];
  for (const [seconds, code] of vectors) {
    setTime(seconds * 1000);
    const result = mfa.enroll(administratorId, { secret: rfcSeed, code });
    assert.equal(result.recoveryCodes.length, 10);
    assert.equal(mfa.consume(administratorId, code), false);
  }
});

test('preparation provisions an authenticator URI and rejects non-operator accounts', context => {
  const { mfa, clock } = fixture(context);
  for (const userId of ['buyer', 'demo-admin', 'unknown-account']) {
    assert.throws(() => mfa.prepareEnrollment(userId), { code: 'OPERATOR_NOT_FOUND' });
    assert.throws(() => mfa.enroll(userId, { secret: rfcSeed, code: '287082' }), { code: 'OPERATOR_NOT_FOUND' });
  }
  const { secret, uri } = mfa.prepareEnrollment(administratorId);
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(mfa.isEnrolled(administratorId), false);
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'otpauth:');
  assert.equal(parsed.hostname, 'totp');
  assert.equal(decodeURIComponent(parsed.pathname), '/World Souk & Shop:operator+test@example.test');
  assert.deepEqual(Object.fromEntries(parsed.searchParams), { secret, issuer: 'World Souk & Shop', algorithm: 'SHA1', digits: '6', period: '30' });
  mfa.enroll(administratorId, { secret, code: authenticatorCode(secret, clock()) });
  assert.equal(mfa.isEnrolled(administratorId), true);
});

test('TOTP accepts one adjacent step and blocks all prior steps after use', context => {
  const { db, mfa, setTime, clock, addSession, sessionIds } = fixture(context);
  addSession('unverified');
  assert.deepEqual(db.prepare('SELECT operator_mfa_verified AS verified FROM sessions').get().verified, 0);
  mfa.enroll(administratorId, { secret: rfcSeed, code: '287082' });
  assert.deepEqual(sessionIds(), []);
  addSession('existing');
  assert.equal(mfa.consume(administratorId, '969429'), false); // Two steps ahead.
  assert.equal(mfa.consume(administratorId, '359152'), 'totp');
  assert.equal(mfa.consume(administratorId, '287082'), false);
  setTime(60_000);
  assert.equal(createOperatorMfa(db, { key, clock }).consume(administratorId, '359152'), false);
  setTime(120_000);
  assert.equal(mfa.consume(administratorId, '969429'), 'totp'); // One step behind.
  assert.deepEqual(sessionIds(), ['existing']);
});

test('proof consumption rolls back with the session and recovery codes revoke old sessions once', context => {
  const { db, mfa, setTime, addSession, sessionIds } = fixture(context);
  const { recoveryCodes } = mfa.enroll(administratorId, { secret: rfcSeed, code: '287082' });
  assert.equal(new Set(recoveryCodes).size, 10);
  assert.ok(recoveryCodes.every(code => /^(?:[A-F0-9]{8}-){3}[A-F0-9]{8}$/.test(code)));
  const rows = db.prepare('SELECT code_hash FROM operator_mfa_recovery').all();
  assert.equal(rows.length, 10);
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.code_hash) && !recoveryCodes.includes(row.code_hash)));
  addSession('owner');
  addSession('unrelated', 'buyer');
  setTime(60_000);
  assert.throws(() => transaction(db, () => {
    assert.equal(mfa.consume(administratorId, '359152'), 'totp');
    throw new Error('session creation failed');
  }), /session creation failed/);
  assert.equal(mfa.consume(administratorId, '359152'), 'totp');

  const normalized = recoveryCodes[0].toLowerCase().replaceAll('-', '');
  assert.throws(() => transaction(db, () => {
    assert.equal(mfa.consume(administratorId, normalized), 'recovery');
    throw new Error('session creation failed');
  }), /session creation failed/);
  assert.deepEqual(sessionIds(), ['owner', 'unrelated']);
  assert.equal(mfa.consume(administratorId, normalized), 'recovery');
  assert.deepEqual(sessionIds(), ['unrelated']);
  assert.equal(mfa.consume(administratorId, recoveryCodes[0]), false);
  assert.deepEqual(db.prepare('SELECT action FROM operator_mfa_audit ORDER BY id').all().map(row => row.action), ['ENROLLED', 'RECOVERY_USED']);
});

test('ciphertext is authenticated and secure against key loss, corruption, and copying across accounts', context => {
  const { db, mfa, clock, setTime } = fixture(context);
  const { recoveryCodes } = mfa.enroll(administratorId, { secret: rfcSeed, code: '287082' });
  const row = db.prepare('SELECT secret_envelope, last_used_step, enrolled_at_ms FROM operator_mfa WHERE user_id = ?').get(administratorId);
  const original = Buffer.from(row.secret_envelope);
  assert.equal(original.length, 49);
  assert.equal(original.includes(Buffer.from('12345678901234567890')), false);
  assert.equal(original.includes(Buffer.from(rfcSeed)), false);
  setTime(60_000);
  const missingKey = createOperatorMfa(db, { clock });
  assert.equal(missingKey.isEnrolled(administratorId), true);
  assert.throws(() => missingKey.consume(administratorId, '359152'), { code: 'MFA_UNAVAILABLE' });
  assert.throws(() => createOperatorMfa(db, { key: Buffer.alloc(32, 25), clock }).consume(administratorId, recoveryCodes[0]), { code: 'MFA_UNAVAILABLE' });

  const tampered = Buffer.from(original);
  tampered[13] ^= 1;
  const replaceEnvelope = db.prepare('UPDATE operator_mfa SET secret_envelope = ? WHERE user_id = ?');
  replaceEnvelope.run(tampered, administratorId);
  assert.throws(() => mfa.consume(administratorId, '359152'), { code: 'MFA_UNAVAILABLE' });
  replaceEnvelope.run(original, administratorId);
  db.prepare('INSERT INTO operator_mfa (user_id,secret_envelope,last_used_step,enrolled_at_ms) VALUES (?,?,?,?)')
    .run('another-operator', original, row.last_used_step, row.enrolled_at_ms);
  assert.throws(() => mfa.consume('another-operator', '359152'), { code: 'MFA_UNAVAILABLE' });
  assert.equal(mfa.consume(administratorId, '359152'), 'totp');
});

test('rotation replaces old recovery codes and revokes sessions only after valid confirmation', context => {
  const { db, mfa, clock, setTime, addSession, sessionIds } = fixture(context);
  const { recoveryCodes: previousCodes } = mfa.enroll(administratorId, { secret: rfcSeed, code: '287082' });
  addSession('established');
  setTime(120_000);
  const { secret } = mfa.prepareEnrollment(administratorId);
  assert.throws(() => mfa.enroll(administratorId, { secret, code: 'invalid' }), { code: 'INVALID_MFA_CODE' });
  assert.throws(() => mfa.enroll(administratorId, { secret: `${secret}\n`, code: '123456' }), { code: 'INVALID_MFA_SECRET' });
  assert.deepEqual(sessionIds(), ['established']);
  assert.equal(db.prepare('SELECT count(*) AS count FROM operator_mfa_audit').get().count, 1);
  const { recoveryCodes } = mfa.enroll(administratorId, { secret, code: authenticatorCode(secret, clock()) });
  assert.deepEqual(sessionIds(), []);
  assert.equal(mfa.consume(administratorId, previousCodes[0]), false);
  assert.equal(mfa.consume(administratorId, recoveryCodes[0]), 'recovery');
  assert.deepEqual(db.prepare('SELECT action FROM operator_mfa_audit ORDER BY id').all().map(row => row.action), ['ENROLLED', 'ROTATED', 'RECOVERY_USED']);
});
