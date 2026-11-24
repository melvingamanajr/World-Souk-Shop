import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openDatabase } from './database.mjs';
import { createIdentity } from './identity.mjs';
import { createCommerce } from './commerce.mjs';
import { createReferrals } from './referrals.mjs';
import * as operationsModule from './operations.mjs';
import { seedDemo } from './seed.mjs';
import { HttpError } from './http-error.mjs';

const publicDir = new URL('../public/', import.meta.url);
const maxBodyBytes = 32 * 1024;
const mimeTypes = new Map([
  ['html', 'text/html; charset=utf-8'], ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'], ['jpg', 'image/jpeg'],
  ['woff2', 'font/woff2']
]);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function requestObject(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Send an application/json request.');
  }
  if (Number(req.headers['content-length']) > maxBodyBytes) throw new HttpError(413, 'Request is too large.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      req.resume();
      throw new HttpError(413, 'Request is too large.');
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new TypeError();
    return value;
  } catch {
    throw new HttpError(400, 'Send a valid JSON object.');
  }
}

function browserOrigin(req, publicOrigin) {
  const origin = req.headers.origin;
  const expected = publicOrigin || `http://${req.headers.host}`;
  if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== expected)) {
    throw new HttpError(403, 'Request origin is not allowed.');
  }
  if (req.headers['x-wss-request'] !== '1') throw new HttpError(403, 'Request header is missing.');
}

function authorize(identity, req, roles) {
  const user = identity.user(req);
  if (!user) throw new HttpError(401, 'Sign in to continue.');
  if (roles && !roles.includes(user.role)) throw new HttpError(403, 'Your account cannot access this area.');
  return user;
}

function rateLimiter() {
  const counters = new Map();
  return (req, name, max, ttl) => {
    const now = Date.now();
    const key = `${name}:${req.socket.remoteAddress}`;
    for (const [id, value] of counters) if (value.expires <= now) counters.delete(id);
    const value = counters.get(key) ?? { expires: now + ttl, count: 0 };
    if (++value.count > max) throw new HttpError(429, 'Too many requests. Try again shortly.');
    if (counters.size < 10000) counters.set(key, value);
  };
}

async function staticFile(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method is not supported.');
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^(?:index\.html|styles\.css|[a-z-]+\.js|images\/[a-z-]+\.jpg|fonts\/[a-z-]+\.woff2)$/.test(name)) {
    throw new HttpError(404, 'Page not found.');
  }
  let content;
  try {
    content = await readFile(new URL(name, publicDir));
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, 'File not found.');
    throw error;
  }
  const etag = `"${createHash('sha256').update(content).digest('base64url')}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', name === 'index.html' ? 'no-cache' : 'public, max-age=3600');
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': mimeTypes.get(name.split('.').pop()), 'Content-Length': content.length });
  res.end(req.method === 'HEAD' ? undefined : content);
}

export function createApplication({ filename, demo = false, publicOrigin, commissionBps = 800, logger = console,
  operatorMfaKey, requireAdminMfa = false } = {}) {
  const db = openDatabase(filename ?? ':memory:');
  const identity = createIdentity(db, { secureCookies: publicOrigin?.startsWith('https:'), demo, operatorMfaKey, requireAdminMfa });
  const commerce = createCommerce(db, { commissionBps });
  const referrals = createReferrals(db);
  const operations = operationsModule.createOperations(db);
  if (demo) {
    seedDemo(db);
    operationsModule.seedOperations?.(db);
  }

  const limit = rateLimiter();
  const consumer = ['CONSUMER'];
  const admin = ['ADMIN'];
  const manufacturer = ['MANUFACTURER'];
  const freight = ['FREIGHT_PARTNER', 'ADMIN'];
  const readiness = db.prepare('SELECT name FROM schema_migrations LIMIT 1');

  const routes = [
    ['GET', /^\/healthz$/, () => ({ status: 'ok' })],
    ['GET', /^\/readyz$/, () => {
      if (!readiness.get()) throw new HttpError(503, 'Database is not ready.');
      return { status: 'ready' };
    }],
    ['GET', /^\/api\/config$/, () => ({ demo, checkoutEnabled: demo, commissionBps, currency: 'USD' })],
    ['GET', /^\/api\/catalog$/, ({ url }) => commerce.catalog(Object.fromEntries(url.searchParams))],
    ['GET', /^\/api\/categories$/, () => commerce.categories()],
    ['GET', /^\/api\/catalog\/([\w-]+)$/, ({ params }) => commerce.product(params[0])],
    ['GET', /^\/api\/pools$/, () => commerce.pools()],
    ['POST', /^\/api\/pools$/, ({ user, body }) => commerce.createPool(user, body), manufacturer, 201],
    ['GET', /^\/api\/session$/, ({ req }) => ({ user: identity.user(req) })],
    ['POST', /^\/api\/session\/register$/, async ({ req, res, body }) => session(res, await identity.register(req, body)), null, 201],
    ['POST', /^\/api\/session\/login$/, async ({ req, res, body }) => session(res, await identity.login(req, body))],
    ['POST', /^\/api\/session\/demo$/, ({ req, res, body }) => session(res, identity.demoLogin(req, body.role))],
    ['POST', /^\/api\/session\/logout$/, ({ req, res }) => {
      res.setHeader('Set-Cookie', identity.logout(req));
      return { user: null };
    }],
    ['POST', /^\/api\/session\/logout-all$/, ({ user, res }) => {
      res.setHeader('Set-Cookie', identity.logoutAll(user));
      return { user: null };
    }, []],
    ['PATCH', /^\/api\/session\/password$/, async ({ req, user, res, body }) =>
      session(res, await identity.changePassword(req, user, body)), []],
    ['POST', /^\/api\/orders$/, ({ user, body }) => {
      if (!demo) throw new HttpError(503, 'Checkout requires a configured payment provider.');
      return commerce.checkout(user.id, body);
    }, consumer, 201],
    ['GET', /^\/api\/orders$/, ({ user }) => commerce.orders(user.id), []],
    ['GET', /^\/api\/orders\/([\w-]+)$/, ({ user, params }) => commerce.order(user.id, params[0]), []],
    ['GET', /^\/api\/orders\/([\w-]+)\/tracking$/, ({ user, params }) => {
      commerce.order(user.id, params[0]);
      return { shipment: operations.listTracking(user, params[0]) };
    }, []],
    ['GET', /^\/api\/wallet$/, ({ user }) => commerce.wallet(user.id), []],
    ['GET', /^\/api\/referrals$/, ({ user }) => { commerce.expirePools(); return referrals.account(user.id); }, []],
    ['POST', /^\/api\/referrals$/, ({ user }) => referrals.activate(user.id), [], 201],
    ['GET', /^\/api\/memberships$/, ({ user }) => operations.listMemberships(user), []],
    ['POST', /^\/api\/memberships$/, ({ user, body }) => operations.submitMembership(user, body), [], 201],
    ['PATCH', /^\/api\/memberships\/([\w-]+)$/, ({ user, params, body }) => operations.reviewMembership(user, params[0], body), admin],
    ['GET', /^\/api\/manufacturer$/, ({ user }) => operations.manufacturerDashboard(user), manufacturer],
    ['POST', /^\/api\/manufacturer\/products$/, ({ user, body }) => operations.createProduct(user, body), manufacturer, 201],
    ['PATCH', /^\/api\/manufacturer\/products\/([\w-]+)$/, ({ user, params, body }) => operations.updateProduct(user, params[0], body), manufacturer],
    ['POST', /^\/api\/manufacturer\/batches$/, ({ user, body }) => operations.createBatch(user, body), manufacturer, 201],
    ['GET', /^\/api\/freight$/, ({ user }) => operations.freightDashboard(user), freight],
    ['POST', /^\/api\/freight\/shipments$/, ({ user, body }) => operations.createShipment(user, body), admin, 201],
    ['POST', /^\/api\/freight\/shipments\/([\w-]+)\/events$/, ({ user, params, body }) => operations.addShipmentEvent(user, params[0], body), freight, 201],
    ['POST', /^\/api\/freight\/remittances$/, ({ user, body }) => operations.createRemittance(user, body), admin, 201],
    ['PATCH', /^\/api\/freight\/remittances\/([\w-]+)$/, ({ user, params }) => operations.settleRemittance(user, params[0]), admin],
    ['GET', /^\/api\/admin\/manufacturers$/, () => db.prepare('SELECT id,name,country,verified FROM manufacturers ORDER BY name').all(), admin],
    ['GET', /^\/api\/admin\/overview$/, () => db.prepare(`SELECT COUNT(*) AS orders,
      COALESCE(SUM(subtotal_cents), 0) AS gmvCents, COALESCE(SUM(commission_cents), 0) AS commissionCents,
      COALESCE(SUM(platform_cents), 0) AS platformCents, COALESCE(SUM(cashback_cents), 0) AS cashbackCents,
      COALESCE(SUM(affiliate_cents), 0) AS affiliateCents, COALESCE(SUM(community_cents), 0) AS communityCents
      FROM orders WHERE status IN ('PAID', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED')`).get(), admin],
    ['GET', /^\/api\/admin\/privacy$/, () => db.prepare(`SELECT p.id,p.kind,p.detail,p.status,p.created_at AS createdAt,u.email
      FROM privacy_requests p JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC LIMIT 200`).all(), admin],
    ['GET', /^\/api\/privacy$/, ({ user }) => identity.privacyRequests(user), []],
    ['POST', /^\/api\/privacy$/, ({ user, body }) => identity.createPrivacyRequest(user, body), [], 201],
    ['GET', /^\/api\/privacy\/export$/, ({ user, res }) => {
      res.setHeader('Content-Disposition', 'attachment; filename="world-souk-data.json"');
      return { user, orders: commerce.orders(user.id), wallet: commerce.wallet(user.id),
        memberships: operations.listMemberships({ ...user, role: 'CONSUMER' }), referrals: referrals.account(user.id), requests: identity.privacyRequests(user) };
    }, []]
  ];

  function session(res, result) {
    res.setHeader('Set-Cookie', result.cookie);
    return { user: result.user };
  }

  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (req, res) => {
    const requestId = randomUUID();
    const start = performance.now();
    for (const [name, value] of Object.entries({
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'X-Request-Id': requestId
    })) res.setHeader(name, value);
    if (publicOrigin?.startsWith('https:')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    let routeName = 'unknown';
    try {
      let url;
      try { url = new URL(req.url ?? '/', 'http://wss.invalid'); }
      catch { throw new HttpError(400, 'Invalid request URL.'); }
      if (!url.pathname.startsWith('/api/') && !['/healthz', '/readyz'].includes(url.pathname)) {
        routeName = 'static';
        return await staticFile(req, res, url.pathname);
      }
      for (const [method, path, handler, roles, status = 200] of routes) {
        const params = url.pathname.match(path)?.slice(1);
        if (method !== req.method || !params) continue;
        routeName = path.source;
        let body;
        if (method !== 'GET') {
          browserOrigin(req, publicOrigin);
          const isLogin = url.pathname.startsWith('/api/session/');
          limit(req, isLogin ? 'session' : 'mutation', isLogin ? 30 : 100, 60000);
          body = await requestObject(req);
        }
        const user = roles ? authorize(identity, req, roles.length ? roles : undefined) : null;
        const value = await handler({ req, res, url, params, body, user });
        if (value === undefined || value === null) throw new HttpError(404, 'Record not found.');
        return json(res, status, value);
      }
      throw new HttpError(404, 'Route not found.');
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 499 ? error.status :
        error instanceof HttpError ? error.status : 500;
      if (status === 500) logger.error({ requestId, error });
      if (status === 429 && Number.isInteger(error.retryAfter)) res.setHeader('Retry-After', error.retryAfter);
      json(res, status, { error: { code: status === 500 ? 'INTERNAL_ERROR' : error.code || 'REQUEST_ERROR',
        message: status === 500 ? 'Unexpected server error.' : error.message }, requestId });
    } finally {
      logger.info({ requestId, method: req.method, route: routeName, status: res.statusCode, ms: Math.round(performance.now() - start) });
    }
  });
  server.once('close', () => db.close());
  return { server, db, commerce, operations };
}
