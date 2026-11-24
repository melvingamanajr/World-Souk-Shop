import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../src/application.mjs';
import { allocateCommission } from '../src/commerce.mjs';

const logger = { info() {}, error(event) { console.error(event.error); } };
const address = { name: 'Sample Buyer', address: '10 Demo Street', city: 'Cebu', postalCode: '6000', country: 'Philippines' };

async function fixture(testContext, demo = true) {
  const app = createApplication({ demo, logger });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  testContext.after(() => new Promise(resolve => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', data, cookie, headers = {} } = {}) {
    const changes = method !== 'GET';
    const response = await fetch(origin + path, {
      method,
      headers: { ...(changes ? { 'Content-Type': 'application/json', 'X-WSS-Request': '1', Origin: origin } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: changes ? JSON.stringify(data ?? {}) : undefined
    });
    const json = response.headers.get('content-type')?.includes('application/json');
    return { response, body: json ? await response.json() : await response.text(),
      cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const demoSignIn = role => request('/api/session/demo', { method: 'POST', data: { role } });
  return { ...app, request, demoSignIn };
}

test('commission allocation reconciles the proposal example and odd cent amounts', () => {
  assert.deepEqual(allocateCommission(50000, 1000), {
    commissionCents: 5000, platformCents: 2500, cashbackCents: 1500, affiliateCents: 500, communityCents: 500
  });
  for (let price = 1; price < 100; price++) {
    const { commissionCents, ...parts } = allocateCommission(price);
    assert.equal(Object.values(parts).reduce((sum, cents) => sum + cents, 0), commissionCents);
  }
});

test('storefront, catalogue, guarded roles and per-user records work over HTTP', async context => {
  const { request, demoSignIn } = await fixture(context);
  const storefront = await request('/');
  assert.equal(storefront.response.status, 200);
  assert.match(storefront.body, /World Souk/);
  assert.match(storefront.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const asset of ['styles.css', 'app.js', 'ui.js', 'locale.js', 'portals.js', 'images/souk.jpg']) {
    const response = await fetch(new URL(asset, storefront.response.url));
    assert.equal(response.status, 200, asset);
    await response.arrayBuffer();
  }
  assert.equal((await request('/healthz')).body.status, 'ok');
  assert.equal((await request('/api/categories')).body.length, 4);
  assert.equal((await request('/api/catalog?q=shenzhen')).body[0].id, 'orbit-speaker');
  assert.deepEqual((await request('/api/catalog?q=%25')).body, []);
  assert.equal((await request('/api/orders')).response.status, 401);
  const shopper = await demoSignIn('CONSUMER');
  assert.equal(shopper.response.status, 200);
  assert.match(shopper.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await request('/api/admin/overview', { cookie: shopper.cookie })).response.status, 403);
  assert.equal((await request('/api/session/logout', { method: 'POST', cookie: shopper.cookie,
    headers: { Origin: 'https://unrelated.invalid' } })).response.status, 403);
  const seller = await demoSignIn('MANUFACTURER');
  assert.equal((await request('/api/manufacturer', { cookie: seller.cookie })).body.manufacturer.id, 'loom-form');
  const admin = await demoSignIn('ADMIN');
  assert.equal((await request('/api/admin/overview', { cookie: admin.cookie })).body.orders, 0);
});

test('checkout is idempotent, uses canonical tier prices and protects guest records', async context => {
  const { request, demoSignIn, db } = await fixture(context);
  const { cookie } = await demoSignIn('CONSUMER');
  const body = { items: [{ productId: 'linen-throw', quantity: 5, unitPriceCents: 1 }], shipping: address, idempotencyKey: 'direct-1' };
  const submit = data => request('/api/orders', { method: 'POST', cookie, data });
  const [first, retry] = await Promise.all([submit(body), submit(body)]);
  assert.equal(first.response.status, 201);
  assert.equal(first.body.id, retry.body.id);
  assert.equal(first.body.subtotalCents, 18000);
  assert.equal(first.body.cashbackCents, 432);
  assert.equal(first.body.items[0].priceTier, 'WHOLESALE');
  assert.equal((await request('/api/catalog/linen-throw')).body.stock, 77);
  assert.equal((await submit({ ...body, shipping: { ...address, city: 'Da Nang' } })).response.status, 409);
  assert.equal((await submit({ ...body, items: [{ productId: 'linen-throw', quantity: 100 }], idempotencyKey: 'oversell' })).response.status, 409);
  assert.equal((await request('/api/wallet', { cookie })).body.availableCents, 432);
  const tracking = await request(`/api/orders/${first.body.id}/tracking`, { cookie });
  assert.deepEqual(tracking.body, { shipment: null });
  const other = await demoSignIn('ADMIN');
  assert.equal((await request(`/api/orders/${first.body.id}`, { cookie: other.cookie })).response.status, 404);
  const exportData = await request('/api/privacy/export', { cookie });
  assert.equal(exportData.body.orders[0].id, first.body.id);
  assert.ok(!Object.hasOwn(exportData.body.user, 'password_hash'));
  assert.match(exportData.response.headers.get('content-disposition'), /attachment/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE payload LIKE '%Demo Street%'").get().n, 0);
});

test('community pool reservations fund together and expire with stock restoration', async context => {
  const { request, demoSignIn, db } = await fixture(context);
  const { cookie } = await demoSignIn('CONSUMER');
  const join = (productId, poolId, quantity, key) => request('/api/orders', { method: 'POST', cookie, data: {
    items: [{ productId, poolId, quantity }], shipping: address, idempotencyKey: key
  } });
  const first = await join('linen-throw', 'linen-circle', 4, 'join-1');
  assert.equal(first.body.status, 'PENDING');
  assert.ok((await request('/api/wallet', { cookie })).body.pendingCents > 0);
  assert.equal((await join('linen-throw', 'linen-circle', 8, 'join-2')).body.status, 'PAID');
  assert.equal((await request(`/api/orders/${first.body.id}`, { cookie })).body.status, 'PAID');
  assert.equal((await request('/api/wallet', { cookie })).body.pendingCents, 0);
  const reservation = await join('orbit-speaker', 'orbit-circle', 1, 'expires');
  db.prepare('UPDATE pools SET ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), 'orbit-circle');
  assert.equal((await request(`/api/orders/${reservation.body.id}`, { cookie })).body.status, 'CANCELLED');
  assert.equal((await request('/api/catalog/orbit-speaker')).body.stock, 61);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('demo impersonation and simulated payment are unavailable outside demo mode', async context => {
  const { request, demoSignIn } = await fixture(context, false);
  assert.equal((await demoSignIn('ADMIN')).response.status, 404);
  const account = await request('/api/session/register', { method: 'POST', data: {
    name: 'Local Buyer', email: 'local@example.invalid', password: 'a-sufficiently-long-test-password', acceptPrivacy: true
  } });
  assert.equal(account.response.status, 201);
  assert.equal((await request('/api/orders', { method: 'POST', cookie: account.cookie })).response.status, 503);
  const previousCookie = account.cookie;
  assert.equal((await request('/api/session/logout', { method: 'POST', cookie: previousCookie })).response.status, 200);
  assert.equal((await request('/api/session', { cookie: previousCookie })).body.user, null);
});

test('manufacturers open pools and valid cross-account referrals earn demo credits', async context => {
  const { request, demoSignIn } = await fixture(context);
  const admin = await demoSignIn('ADMIN');
  const shopper = await demoSignIn('CONSUMER');
  const manufacturer = await demoSignIn('MANUFACTURER');
  const pool = { productId: 'linen-throw', title: 'Next linen circle', description: 'Demo community sale', targetQuantity: 3,
    endsAt: new Date(Date.now() + 86400000).toISOString() };
  assert.equal((await request('/api/pools', { method: 'POST', cookie: shopper.cookie, data: pool })).response.status, 403);
  assert.equal((await request('/api/pools', { method: 'POST', cookie: manufacturer.cookie, data: pool })).response.status, 409);
  const listing = await request('/api/manufacturer/products', { method: 'POST', cookie: manufacturer.cookie, data: {
    sku: 'LF-TEST', title: 'Pool product', category: 'Home & Living', retailPriceCents: 2000, wholesalePriceCents: 1500,
    groupPriceCents: 1250, quantityAvailable: 12
  } });
  assert.equal(listing.response.status, 201);
  const opened = await request('/api/pools', { method: 'POST', cookie: manufacturer.cookie, data: { ...pool, productId: listing.body.id } });
  assert.equal(opened.response.status, 201);
  assert.equal(opened.body.target, 3);
  const referral = await request('/api/referrals', { method: 'POST', cookie: admin.cookie });
  const self = await request('/api/referrals', { method: 'POST', cookie: shopper.cookie });
  const order = { shipping: address, idempotencyKey: 'referral-1', items: [{ productId: 'orbit-speaker', quantity: 1 }] };
  assert.equal((await request('/api/orders', { method: 'POST', cookie: shopper.cookie, data: { ...order, referralCode: self.body.code } })).response.status, 422);
  assert.equal((await request('/api/orders', { method: 'POST', cookie: shopper.cookie, data: { ...order, referralCode: referral.body.code } })).response.status, 201);
  const earnings = await request('/api/referrals', { cookie: admin.cookie });
  assert.equal(earnings.body.orderCount, 1);
  assert.equal(earnings.body.creditedCents, 55);
  const privacy = await request('/api/privacy', { method: 'POST', cookie: shopper.cookie, data: { kind: 'CORRECTION', detail: 'Test request' } });
  assert.equal(privacy.response.status, 201);
  assert.equal((await request('/api/admin/privacy', { cookie: admin.cookie })).body[0].id, privacy.body.id);
});
