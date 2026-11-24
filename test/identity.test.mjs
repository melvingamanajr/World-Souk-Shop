import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { test } from 'node:test';
import { openDatabase } from '../src/database.mjs';
import { bootstrapAdministrator, createIdentity } from '../src/identity.mjs';
import { seedDemo } from '../src/seed.mjs';

const basePassword = 'a synthetic password for tests';
const nextPassword = 'the synthetic replacement password';
const email = 'operator@example.test';
const request = cookie => ({ headers: { cookie: cookie?.split(';')[0] } });

function fixture(context, options = {}) {
  const db = openDatabase(':memory:');
  context.after(() => db.close());
  return { db, identity: createIdentity(db, { secureCookies: true, demo: false, ...options }) };
}

test('bootstrapping provisions the first operator without elevating an existing identity', async context => {
  const { db, identity } = fixture(context);
  await identity.register(request(), { name: 'A shopper', email, password: basePassword, acceptPrivacy: true });
  const details = { name: 'The operator', email, password: basePassword };
  await assert.rejects(bootstrapAdministrator(db, details), { code: 'EMAIL_IN_USE' });
  assert.equal(db.prepare('SELECT role FROM users WHERE email = ?').get(email).role, 'CONSUMER');
  const initial = await bootstrapAdministrator(db, { ...details, email: ' ADMIN@EXAMPLE.TEST ' });
  await assert.rejects(bootstrapAdministrator(db, { ...details, email: 'extra@example.test' }), { code: 'ADMIN_EXISTS' });
  const { user, cookie } = await identity.login(request(), { email: 'admin@example.test', password: basePassword });
  assert.equal(user.id, initial.id);
  assert.equal(user.role, 'ADMIN');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
  assert.deepEqual(db.prepare('SELECT action FROM auth_audit WHERE user_id = ? ORDER BY rowid').all(user.id).map(row => row.action),
    ['ADMIN_BOOTSTRAPPED', 'SIGNED_IN']);
});

test('the operator bootstrap refuses demo data', async context => {
  const { db } = fixture(context);
  seedDemo(db);
  await assert.rejects(bootstrapAdministrator(db, { name: 'Operator', email, password: basePassword }), { code: 'DEMO_DATABASE' });
});

test('login checks persist across identity instances and allow retries after the window', async context => {
  let now = Date.parse('2026-10-12T00:00:00.000Z');
  const { db, identity } = fixture(context, { clock: () => now });
  await identity.register(request(), { name: 'Consumer', email, password: basePassword, acceptPrivacy: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(identity.login(request(), { email, password: 'incorrect password' }), { code: 'INVALID_CREDENTIALS' });
  }
  const restarted = createIdentity(db, { secureCookies: true, demo: false, clock: () => now });
  await assert.rejects(restarted.login(request(), { email: ` ${email.toUpperCase()} `, password: basePassword }),
    { code: 'LOGIN_THROTTLED', retryAfter: 300 });
  now += 300_000;
  assert.equal((await restarted.login(request(), { email, password: basePassword })).user.email, email);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_login_windows').get().count, 0);
});

test('legacy hashes migrate at sign-in and password changes invalidate other devices', async context => {
  const { db, identity } = fixture(context);
  const salt = Buffer.alloc(16, 23);
  const digest = scryptSync(basePassword, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES (?,?,?,?)').run('old-account', email, 'Legacy user',
    `${salt.toString('hex')}:${digest.toString('hex')}`);
  const first = await identity.login(request(), { email, password: basePassword });
  assert.match(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(first.user.id).password_hash, /^scrypt-v2:/);
  const second = await identity.login(request(), { email, password: basePassword });
  await assert.rejects(identity.changePassword(request(second.cookie), second.user, { newPassword: nextPassword, currentPassword: 'wrong' }),
    { code: 'INVALID_CREDENTIALS' });
  const changed = await identity.changePassword(request(second.cookie), second.user, { newPassword: nextPassword, currentPassword: basePassword });
  assert.equal(identity.user(request(first.cookie)), null);
  assert.equal(identity.user(request(second.cookie)), null);
  assert.equal(identity.user(request(changed.cookie)).id, second.user.id);
  await assert.rejects(identity.login(request(), { email, password: basePassword }), { code: 'INVALID_CREDENTIALS' });
  const newDevice = await identity.login(request(), { email, password: nextPassword });
  assert.match(identity.logoutAll(newDevice.user), /Max-Age=0/);
  assert.equal(identity.user(request(changed.cookie)), null);
  assert.equal(identity.user(request(newDevice.cookie)), null);
});
