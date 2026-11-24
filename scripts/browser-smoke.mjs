import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createApplication } from '../src/application.mjs';

const executable = process.env.WSS_BROWSER;
if (!executable) throw new Error('Set WSS_BROWSER to a Chrome or Chromium executable.');

async function until(check, label) {
  const deadline = Date.now() + 12000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await pause(65);
  }
  throw new Error(`Timed out waiting for ${label}.`, { cause: lastError });
}

const { server } = createApplication({ demo: true, logger: { info() {}, error: console.error } });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'wss-browser-'));
const browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
  '--disable-default-apps', '--disable-background-networking', '--disable-crash-reporter', '--disable-extensions',
  '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let processError;
browser.on('error', error => { processError = error; });
let socket;

try {
  const port = await until(async () => {
    if (processError) throw processError;
    if (browser.exitCode !== null) throw new Error(`Chromium exited with code ${browser.exitCode}.`);
    return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  }, 'Chromium');
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  const errors = [];
  const requests = new Map();
  let messageId = 0;
  socket.addEventListener('message', message => {
    const data = JSON.parse(message.data);
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
    if (!data.id) return;
    const request = requests.get(data.id);
    if (!request) return;
    clearTimeout(request.timer);
    requests.delete(data.id);
    if (data.error) request.reject(new Error(data.error.message));
    else request.resolve(data.result);
  });
  await once(socket, 'open');
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++messageId;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`${method} timed out.`)); }, 5000);
    requests.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evalPage = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const click = selector => evalPage(`${q(selector)}.click()`);
  const wait = (expression, label) => until(() => evalPage(expression), label);
  const change = (selector, value) => evalPage(`(() => { const item = ${q(selector)}; item.value = ${JSON.stringify(value)}; item.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  async function fill(form, fields) {
    for (const [name, value] of Object.entries(fields)) {
      await evalPage(`${q(`${form} [name=${name}]`)}.value = ${JSON.stringify(value)}`);
    }
  }
  const viewport = width => command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });

  await command('Page.enable');
  await command('Runtime.enable');
  await viewport(1440);
  await command('Page.navigate', { url: base });
  await wait(`document.querySelectorAll('.product-card').length === 4 && ${q('.hero-image')}.naturalWidth > 0`, 'catalog and hero image');
  assert.equal(await evalPage(`document.querySelectorAll('.pool-card').length`), 3);

  if (process.env.WSS_SCREENSHOT) {
    const image = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.WSS_SCREENSHOT, Buffer.from(image.data, 'base64'));
  }
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await evalPage(`document.activeElement.className`), 'skip-link');
  await change('#category-filter', 'Electronics');
  await wait(`document.querySelectorAll('.product-card').length === 1`, 'category filter');
  await click('#language-toggle');
  assert.equal(await evalPage('document.documentElement.lang'), 'zh-CN');
  assert.match(await evalPage(`${q('.product-card h3')}.textContent`), /Orbit 便携音箱/);
  await click('#language-toggle');
  assert.equal(await evalPage('document.documentElement.lang'), 'en');
  await click('[data-action=add]');
  assert.equal(await evalPage(`${q('#cart-count')}.textContent`), '1');
  await click('#cart-button');
  await wait(q('[data-action=checkout]') + ' !== null', 'cart');
  await click('[data-action=checkout]');
  await click('[data-id=CONSUMER][data-action=demo-role]');
  await wait(q('form[data-form=checkout]') + ' !== null', 'shipping form');
  await fill('form[data-form=checkout]', { address: '10 Test Lane', city: 'Cebu', postalCode: '6000', country: 'Philippines' });
  await click('form[data-form=checkout] button[type=submit]');
  await wait(q('[data-action=order-detail]') + ' !== null', 'order history');
  await click('[data-action=order-detail]');
  await wait(`${q('#shop-dialog-title')}.textContent.startsWith('Order ')`, 'order detail');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(`!${q('#shop-dialog')}.open`, 'Escape closes order dialog');
  await click('#signin-button');
  await click('[data-action=switch-role]');
  await click('[data-id=ADMIN][data-action=demo-role]');
  await wait(q('form[data-form=create-shipment]') + ' !== null', 'operations freight workspace');
  await evalPage(`${q('[name=waybill]')}.value = 'WSS-SMOKE-1'; ${q('[name=regionCode]')}.value = 'APAC'`);
  await click('form[data-form=create-shipment] button[type=submit]');
  await wait(q('[data-action=shipment-detail]') + ' !== null', 'shipment assignment');
  await click('#signin-button');
  await click('[data-action=switch-role]');
  await click('[data-id=FREIGHT_PARTNER][data-action=demo-role]');
  await wait(`${q('#portal h2')}?.textContent === 'Freight hub'`, 'freight member workspace');
  await click('[data-action=shipment-detail]');
  await change('form[data-form=shipment-event] [name=status]', 'IN_TRANSIT');
  await click('form[data-form=shipment-event] button[type=submit]');
  await wait(`${q('#portal')}.textContent.includes('In transit')`, 'freight tracking milestone');
  await click('#signin-button');
  await click('[data-action=switch-role]');
  await click('[data-id=CONSUMER][data-action=demo-role]');
  await wait(q('[data-action=order-detail]') + ' !== null', 'shopper order history');
  await click('[data-action=order-detail]');
  await wait(`${q('#shop-dialog-body')}.textContent.includes('WSS-SMOKE-1')`, 'shopper shipment timeline');
  await click('#dialog-close');

  const applicantEmail = 'smoke-applicant@example.test';
  const initialPassword = 'a synthetic browser test password';
  const updatedPassword = 'a synthetic replacement browser password';
  await click('#signin-button');
  await click('[data-action=switch-role]');
  await click('[data-action=register]');
  await fill('form[data-form=register]', { name: 'Smoke Applicant', email: applicantEmail, password: initialPassword });
  await click('[name=acceptPrivacy]');
  await click('form[data-form=register] button[type=submit]');
  await wait(`${q('#portal h2')}?.textContent === 'Orders & rewards' && !${q('#shop-dialog')}.open`, 'registered shopper session');
  await click('#signin-button');
  await click('[data-action=change-password]');
  await fill('form[data-form=change-password]', { currentPassword: initialPassword, newPassword: updatedPassword, confirmPassword: updatedPassword });
  await click('form[data-form=change-password] button[type=submit]');
  await wait(`${q('#toast-status')}.textContent === 'Password updated.'`, 'password change');
  await click('#signin-button');
  await click('[data-action=workspace][data-id=memberships]');
  await wait(q('form[data-form=apply-membership]') + ' !== null', 'applicant pre-survey');
  await change('form[data-form=apply-membership] [name=requestedRole]', 'MANUFACTURER');
  await fill('form[data-form=apply-membership]', { companyName: 'Smoke Manufacturing', countryCode: 'PH',
    businessSummary: 'Small-batch manufacturing', productionCapacity: '250', qualityControls: 'Lot-level inspections', complianceReference: 'Demo registry reference' });
  await click('form[data-form=apply-membership] button[type=submit]');
  await wait(`${q('#portal')}.textContent.includes('Passed form checks')`, 'recorded pre-screening');
  await click('#signin-button');
  await click('[data-action=switch-role]');
  await click('[data-id=ADMIN][data-action=demo-role]');
  await wait(q('[data-action=review-membership]') + ' !== null', 'admin review queue');
  await click('[data-action=review-membership]');
  assert.equal(await evalPage(`${q('[name=verificationConfirmed]')}.required`), true);
  assert.equal(await evalPage(`${q('[name=verificationConfirmed]')}.checked`), false);
  await click('[name=verificationConfirmed]');
  await click('form[data-form=review-membership] button[type=submit]');
  await wait(`${q('#portal')}.textContent.includes('Supporting records confirmed')`, 'confirmed review');
  await click('#signin-button');
  await click('[data-action=switch-role]');
  await fill('form[data-form=login]', { email: applicantEmail, password: updatedPassword });
  await click('form[data-form=login] button[type=submit]');
  await wait(`${q('#portal h2')}?.textContent === 'Manufacturer hub'`, 'newly approved manufacturer sign-in');
  await click('#signin-button');
  await click('[data-action=logout-all]');
  await click('[data-action=confirm-logout-all]');
  await wait(`${q('#signin-button')}.textContent === 'Sign in'`, 'revoked sessions');
  for (const width of [390, 320]) {
    await viewport(width);
    await wait(`innerWidth === ${width}`, 'mobile viewport');
    assert.ok(await evalPage('document.documentElement.scrollWidth <= innerWidth'), `page overflow at ${width}px`);
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('Chromium smoke passed: shopping, shipment tracking, account controls, membership review, keyboard focus and desktop and mobile layout.');
} finally {
  socket?.close();
  if (browser.exitCode === null && browser.pid) {
    const stopped = once(browser, 'exit');
    browser.kill();
    await Promise.race([stopped, pause(1500)]);
  }
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 4 }).catch(error => console.warn(`Browser profile cleanup: ${error.code}`));
}
