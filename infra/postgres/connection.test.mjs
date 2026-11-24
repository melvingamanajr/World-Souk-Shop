import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postgresConnectionOptions } from './connection.mjs';

test('PostgreSQL verifies certificates by default and decodes connection fields', () => {
  const config = postgresConnectionOptions({ WSS_POSTGRES_URL: 'postgresql://wss%2Drelay:secret%3Ftest@postgres.internal:5433/wss' });
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  assert.equal(config.password, 'secret?test');
  assert.equal(config.user, 'wss-relay');
  assert.equal(config.port, 5433);
});

test('plaintext PostgreSQL is restricted to literal loopback and TLS URL overrides are rejected', () => {
  const local = postgresConnectionOptions({ WSS_POSTGRES_URL: 'postgresql://test@[::1]/test', WSS_POSTGRES_TLS: 'local' });
  assert.equal(local.host, '::1');
  assert.equal(local.ssl, false);
  assert.throws(() => postgresConnectionOptions({ WSS_POSTGRES_URL: 'postgresql://test@postgres.internal/test', WSS_POSTGRES_TLS: 'local' }), /loopback/);
  assert.throws(() => postgresConnectionOptions({ WSS_POSTGRES_URL: 'postgresql://test@postgres.internal/test?sslmode=disable' }), /without query/);
});
