import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createApplication } from './application.mjs';

const { values } = parseArgs({ options: { demo: { type: 'boolean', default: false } } });
const host = process.env.WSS_HOST ?? '127.0.0.1';
const port = Number(process.env.WSS_PORT ?? 3000);
const commissionBps = Number(process.env.WSS_COMMISSION_BPS ?? 800);
const filename = resolve(process.env.WSS_DB ?? (values.demo ? 'data/demo.sqlite' : 'data/world-souk.sqlite'));
const publicOrigin = process.env.WSS_PUBLIC_ORIGIN ? new URL(process.env.WSS_PUBLIC_ORIGIN).origin : undefined;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WSS_PORT must be a valid TCP port.');
if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10000) throw new Error('WSS_COMMISSION_BPS must be 0–10000.');
if (values.demo && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Demo mode requires a loopback bind.');
if (!values.demo && !['127.0.0.1', '::1', 'localhost'].includes(host) && !publicOrigin?.startsWith('https:')) {
  throw new Error('An HTTPS WSS_PUBLIC_ORIGIN is required when serving beyond loopback.');
}
const { server } = createApplication({ filename, demo: values.demo, commissionBps, publicOrigin });
server.listen(port, host, () => console.info(`World Souk & Shop is listening at http://${host}:${port}${values.demo ? ' (local demo)' : ''}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
