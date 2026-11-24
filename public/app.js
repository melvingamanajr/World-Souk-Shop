import { $, api, button, date, empty, esc, field, formMessage, image, money, runForm, status, submit, table, txt } from './ui.js';
import { locale, localizeShell, t } from './locale.js';
import { createPortals } from './portals.js';

const catalog = $('#product-grid');
const poolGrid = $('#pool-grid');
const search = $('#catalog-search');
const category = $('#category-filter');
const sort = $('#sort-filter');
const dialog = $('#shop-dialog');
const dialogTitle = $('#shop-dialog-title');
const dialogBody = $('#shop-dialog-body');
const portal = $('#portal');
const products = new Map();
let visibleProducts = [];
let pools = [];
let categories = [];
let config = {};
let user = null;
let cart = loadCart();
let compared = new Set();
let dialogView;
let view;
let catalogRequest;
let noticeTimer;
let searchTimer;
let afterSignIn;
let groupSelection;
let retryDetails;
const referral = new URLSearchParams(location.search).get('ref')?.toUpperCase() ?? '';
const referralPrefill = /^WSS-[A-F0-9]{16}$/.test(referral) ? referral : '';

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem('wss-cart') ?? '[]');
    return Array.isArray(saved) ? saved.filter(item => /^[\w-]+$/.test(item?.productId) && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 10000).slice(0, 50) : [];
  } catch { return []; }
}

function saveCart() {
  try { localStorage.setItem('wss-cart', JSON.stringify(cart)); } catch { /* Available for this page session. */ }
  $('#cart-count').textContent = cart.reduce((quantity, line) => quantity + line.quantity, 0);
}

function notify(message) {
  const node = $('#toast-status');
  clearTimeout(noticeTimer);
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = t(message); });
  noticeTimer = setTimeout(() => { node.textContent = ''; }, 5000);
}

function modal(name, title, markup) {
  dialogView = name;
  dialogTitle.textContent = t(title);
  dialogBody.innerHTML = markup;
  if (!dialog.open) dialog.showModal();
  else $('#dialog-close').focus();
}

function syncAccount() {
  $('#signin-button').textContent = t(user ? 'Your account' : 'Sign in');
}

function renderCategories() {
  const selected = category.value;
  category.innerHTML = `<option value="">${txt('All categories')}</option>${categories.map(name => `<option value="${esc(name)}">${txt(name)}</option>`).join('')}`;
  category.value = categories.includes(selected) ? selected : '';
}

const comparison = document.createElement('div');
comparison.className = 'toolbar comparison-tools';
catalog.before(comparison);

function renderCatalog() {
  $('#catalog-status').textContent = `${visibleProducts.length} ${t('Product results')}`;
  comparison.hidden = !compared.size;
  comparison.innerHTML = compared.size ? `${button('Compare products', 'compare-view', '', 'secondary', compared.size < 2)}<span>${compared.size}/4</span>${button('Clear selection', 'compare-clear')}` : '';
  catalog.innerHTML = visibleProducts.length ? visibleProducts.map(product => `<article class="product-card">
    ${image(product.image, '', 'loading="lazy"')}
    <div class="product-meta">
      <p class="product-category">${txt(product.category)}</p>
      <h3><button class="title-button" type="button" data-action="product" data-id="${esc(product.id)}">${txt(product.title)}</button></h3>
      <p class="product-origin">${esc(product.manufacturer)} · ${txt(product.country)}</p>
      <p class="product-price">${money(product.priceCents)}</p>
      <p class="product-origin">${money(product.wholesaleCents)} ${txt('wholesale')} · ${product.wholesaleMin}+ ${txt('units')}</p>
    </div>
    <div class="product-actions">
      ${button(product.stock ? 'Add to cart' : 'Sold out', 'add', product.id, 'primary', !product.stock)}
      <label class="compare-control"><input type="checkbox" data-compare="${esc(product.id)}" ${compared.has(product.id) ? 'checked' : ''}>${txt('Compare')}<span class="visually-hidden"> ${txt(product.title)}</span></label>
    </div>
  </article>`).join('') : empty('No products match your filters.');
}

async function fetchCatalog() {
  catalogRequest?.abort();
  const controller = new AbortController();
  catalogRequest = controller;
  const term = search.value.trim();
  const localizedSearch = locale() === 'zh-CN' && /\p{Script=Han}/u.test(term);
  const params = new URLSearchParams({ q: localizedSearch ? '' : term, category: category.value, sort: sort.value });
  try {
    visibleProducts = await api(`/api/catalog?${params}`, { signal: controller.signal });
    if (localizedSearch) visibleProducts = visibleProducts.filter(product =>
      [product.title, product.description, product.manufacturer, product.country, product.category].some(value => t(value).includes(term)));
    for (const product of visibleProducts) products.set(product.id, product);
    renderCatalog();
  } catch (error) {
    if (error.name !== 'AbortError') $('#catalog-status').textContent = t(error.message);
  }
}

function renderPools() {
  poolGrid.innerHTML = pools.length ? pools.map(pool => `<article class="pool-card">
    <div class="pool-heading">${image(pool.image, '', 'loading="lazy"')}<div><p class="pool-meta">${esc(pool.manufacturer)} · ${txt(pool.country)}</p>
    <h3>${txt(pool.title)}</h3></div></div>
    <p>${txt(pool.description)}</p><p class="pool-price">${money(pool.priceCents)} <span class="pool-meta">${txt('per unit')}</span></p>
    <progress value="${pool.current}" max="${pool.target}" aria-label="${esc(`${pool.current} / ${pool.target} ${t('units reserved')}`)}"></progress>
    <p class="pool-meta">${pool.current} / ${pool.target} ${txt('units reserved')} · ${txt('Closes')} ${date(pool.endsAt)}</p>
    ${button(pool.status === 'FUNDED' ? 'Pool funded' : pool.status === 'EXPIRED' ? 'Pool expired' : 'Join pool', 'join', pool.id, 'primary', pool.status !== 'OPEN' || pool.stock < 1)}
  </article>`).join('') : empty('No community pools are available.');
}

async function refreshPools() {
  try {
    pools = await api('/api/pools');
    renderPools();
  } catch (error) { poolGrid.innerHTML = empty(error.message); }
}

async function getProduct(id) {
  if (!products.has(id)) products.set(id, await api(`/api/catalog/${encodeURIComponent(id)}`));
  return products.get(id);
}

function addProduct(id) {
  const product = products.get(id);
  if (!product) return;
  const line = cart.find(item => item.productId === id);
  if ((line?.quantity ?? 0) >= product.stock || (!line && cart.length >= 50)) return notify('No more units can be added.');
  if (line) line.quantity += 1;
  else cart.push({ productId: id, quantity: 1 });
  saveCart();
  notify('Added to your cart.');
}

async function showProduct(id) {
  const product = await getProduct(id);
  modal('product', product.title, `<div class="product-detail-layout">${image(product.image, product.title)}<div>
    <p class="product-origin">${esc(product.manufacturer)} · ${txt(product.country)}${product.verified ? ` · ${txt('Verified manufacturer')}` : ''}</p>
    <p>${txt(product.description)}</p><p class="product-price">${money(product.priceCents)}</p>
    <p>${money(product.wholesaleCents)} ${txt('per unit for orders of')} ${product.wholesaleMin}+</p>
    <p>${product.stock} ${txt('units in stock')}</p>
    <div class="toolbar">${button('Add to cart', 'add', id, 'primary', !product.stock)}${button('View cart', 'cart')}</div>
  </div></div>`);
}

function showComparison() {
  const selection = [...compared].map(id => products.get(id)).filter(Boolean);
  const rows = [
    ['Manufacturer', product => `${esc(product.manufacturer)} · ${txt(product.country)}`],
    ['Retail price', product => money(product.priceCents)],
    ['Wholesale price', product => `${money(product.wholesaleCents)} (${product.wholesaleMin}+)`],
    ['Group price', product => money(product.groupCents)],
    ['Stock', product => product.stock],
    ['Actions', product => button('Add to cart', 'add', product.id, 'primary', !product.stock)]
  ];
  modal('compare', 'Compare products', table(['Product', ...selection.map(product => product.title)], rows.map(([title, show]) => [txt(title), ...selection.map(show)])));
}

function unitPrice(product, quantity) {
  return quantity >= product.wholesaleMin ? product.wholesaleCents : product.priceCents;
}

async function showCart() {
  modal('cart', 'Your cart', `<p role="status">${txt('Loading…')}</p>`);
  const lines = await Promise.all(cart.map(async line => ({ ...line, product: await getProduct(line.productId).catch(() => null) })));
  if (dialogView !== 'cart' || !dialog.open) return;
  let total = 0;
  let valid = true;
  const content = lines.map(({ product, productId, quantity }) => {
    const exhausted = !product || product.stock < quantity;
    if (exhausted) valid = false;
    if (product) total += unitPrice(product, quantity) * quantity;
    return `<div class="cart-row"><div class="cart-product"><strong>${product ? txt(product.title) : txt('Unavailable product')}</strong>
      ${product ? `<div class="product-origin">${money(unitPrice(product, quantity))} ${txt('per unit')}${quantity >= product.wholesaleMin ? ` · ${txt('wholesale')}` : ''}</div>` : ''}</div>
      <label>${txt('Quantity')}<input type="number" min="1" max="${Math.max(1, product?.stock ?? 1)}" step="1" value="${quantity}" data-quantity="${esc(productId)}"></label>
      ${button('Remove', 'remove', productId)}${exhausted ? `<p class="form-error">${txt('Quantity exceeds current stock.')}</p>` : ''}</div>`;
  }).join('');
  dialogBody.innerHTML = lines.length ? `${content}<div class="cart-total"><strong>${txt('Total')} ${money(total)}</strong>
    ${button('Checkout', 'checkout', '', 'primary', !valid || !config.checkoutEnabled)}</div>${config.checkoutEnabled ? '' : empty('Checkout is currently unavailable.')}` : empty('Your cart is empty.');
}

function authenticate(next) {
  if (user) return true;
  afterSignIn = next;
  showSignIn();
  return false;
}

const roleNames = { CONSUMER: 'Shopper', MANUFACTURER: 'Manufacturer', FREIGHT_PARTNER: 'Freight partner', ADMIN: 'Administrator' };

function showSignIn(register = false) {
  modal('sign-in', register ? 'Create an account' : 'Sign in', `<form class="form-grid" data-form="${register ? 'register' : 'login'}">
    ${register ? field('name', 'Full name', 'required minlength="2" maxlength="100" autocomplete="name"') : ''}
    ${field('email', 'Email', 'required type="email" maxlength="254" autocomplete="email"')}
    ${field('password', 'Password', `required type="password" maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}" ${register ? 'minlength="12"' : ''}`)}
    ${register ? `<label class="check-label"><input type="checkbox" name="acceptPrivacy" required> ${txt('I have read the privacy notice.')}</label>` : ''}
    ${formMessage}<div class="form-actions">${submit(register ? 'Create an account' : 'Sign in')}${button(register ? 'Sign in' : 'Create an account', register ? 'login' : 'register')}${button('Privacy notice', 'privacy-notice')}</div>
  </form>${config.demo ? `<div class="dialog-section"><h3>${txt('Demo roles')}</h3><p>${txt('Try a seeded account with sample data.')}</p><div class="toolbar">${Object.entries(roleNames).map(([role, title]) => button(title, 'demo-role', role)).join('')}</div></div>` : ''}`);
}

function showAccount() {
  if (!authenticate(showAccount)) return;
  modal('account', 'Your account', `<p><strong>${esc(user.name)}</strong><br>${esc(user.email)} · ${txt(roleNames[user.role] ?? user.role)}</p>
    <div class="toolbar">${user.role === 'CONSUMER' ? '' : button('Open workspace', 'workspace', ({ MANUFACTURER: 'manufacturer', FREIGHT_PARTNER: 'freight', ADMIN: 'admin' })[user.role], 'primary')}
    ${button('Orders & rewards', 'workspace', 'orders', user.role === 'CONSUMER' ? 'primary' : 'secondary')}
    ${button('Membership', 'workspace', 'memberships')}${button('Referrals', 'workspace', 'referrals')}${button('Data & privacy', 'workspace', 'privacy')}
    ${button('Sign out', 'logout')}${config.demo ? button('Switch demo role', 'switch-role') : ''}</div>`);
}

function showJoin(id) {
  const pool = pools.find(row => row.id === id);
  if (!pool || pool.status !== 'OPEN') return notify('This pool is no longer open.');
  const max = Math.min(pool.target - pool.current, pool.stock);
  modal('join', pool.title, `<p>${txt(pool.description)}</p><p><strong>${money(pool.priceCents)} ${txt('per unit')}</strong></p>
    <p>${txt('Your units are reserved until the pool reaches its target or closes.')}</p>
    <form data-form="join" data-id="${esc(id)}">${field('quantity', 'Quantity', `required type="number" min="1" max="${max}" value="1"`)}${formMessage}${submit('Continue')}</form>`);
}

function showCheckout(poolLine = null) {
  if (!authenticate(() => showCheckout(poolLine))) return;
  if (user.role !== 'CONSUMER') return notify('Switch to a shopper account to check out.');
  if (!config.checkoutEnabled) return notify('Checkout is currently unavailable.');
  const pool = poolLine ? pools.find(row => row.id === poolLine.poolId) : null;
  groupSelection = poolLine;
  const lines = poolLine ? [poolLine] : cart;
  if (!lines.length || (poolLine && !pool)) return;
  const subtotal = lines.reduce((cents, line) => {
    const product = products.get(line.productId);
    return cents + line.quantity * (pool ? pool.priceCents : product ? unitPrice(product, line.quantity) : 0);
  }, 0);
  modal('checkout', 'Checkout', `<p>${txt(pool ? 'Demo reservation. Cashback becomes available when the pool funds.' : 'Demo checkout. No payment method is collected.')}</p>
    <p><strong>${txt('Total')} ${money(subtotal)}</strong></p>
    <form class="form-grid" data-form="checkout">${field('name', 'Full name', `required maxlength="120" autocomplete="shipping name" value="${esc(user.name)}"`)}
    ${field('address', 'Street address', 'required maxlength="200" autocomplete="shipping street-address"')}
    ${field('city', 'City', 'required maxlength="100" autocomplete="shipping address-level2"')}
    ${field('postalCode', 'Postal code', 'required maxlength="30" autocomplete="shipping postal-code"')}
    ${field('country', 'Country', 'required maxlength="100" autocomplete="shipping country-name"')}
    ${field('referralCode', 'Referral code (optional)', `maxlength="80" value="${esc(referralPrefill)}"`)}${formMessage}
    <div class="form-actions">${submit('Place demo order')}${button(pool ? 'Back to pool' : 'Back to cart', pool ? 'join' : 'cart', pool?.id)}</div></form>`);
}

function privacyNotice() {
  modal('privacy-notice', 'Privacy notice', `<p>${txt('World Souk & Shop stores account details, orders, delivery information, and membership applications to operate this marketplace. The current demo stores these records in its local database.')}</p>
    <p>${txt('Your cart and language preference are stored in this browser. Signed-in shoppers can download their records or submit a correction or erasure request.')}</p>
    <div class="toolbar">${button('Sign in', 'login')}${button('Create an account', 'register')}</div>`);
}

async function signedIn(result) {
  user = result.user;
  retryDetails = undefined;
  syncAccount();
  dialog.close();
  const continuation = afterSignIn;
  afterSignIn = undefined;
  if (continuation) return continuation();
  const destination = ({ CONSUMER: 'orders', MANUFACTURER: 'manufacturer', FREIGHT_PARTNER: 'freight', ADMIN: 'admin' })[user.role];
  return openPortal(destination);
}

const portals = createPortals({ portal, notify, modal, account: () => user });

async function openPortal(destination, focus = true) {
  if (!authenticate(() => openPortal(destination, focus))) return;
  view = destination;
  if (dialog.open) dialog.close();
  portal.hidden = false;
  await portals.open(destination);
  if (view === destination && focus) {
    $('h2', portal)?.focus({ preventScroll: true });
    portal.scrollIntoView({ block: 'start' });
  }
}

const actions = {
  add: addProduct, product: showProduct, cart: showCart, join: showJoin,
  'compare-view': showComparison, 'compare-clear': () => { compared.clear(); renderCatalog(); },
  remove: id => { cart = cart.filter(line => line.productId !== id); saveCart(); return showCart(); },
  checkout: () => showCheckout(), login: () => showSignIn(), register: () => showSignIn(true),
  'privacy-notice': privacyNotice, workspace: openPortal, 'switch-role': () => showSignIn(),
  'demo-role': async role => signedIn(await api('/api/session/demo', { method: 'POST', body: { role } })),
  logout: async () => {
    await api('/api/session/logout', { method: 'POST' });
    user = null; view = undefined; afterSignIn = undefined; retryDetails = undefined;
    portal.hidden = true; portal.replaceChildren(); syncAccount(); dialog.close(); notify('Signed out.');
  }
};

const forms = {
  login: async (_form, values) => signedIn(await api('/api/session/login', { method: 'POST', body: values })),
  register: async (_form, values) => signedIn(await api('/api/session/register', { method: 'POST', body: { ...values, acceptPrivacy: values.acceptPrivacy === 'on' } })),
  join: (form, values) => {
    const pool = pools.find(row => row.id === form.dataset.id);
    if (!pool) return;
    showCheckout({ productId: pool.productId, poolId: pool.id, quantity: Number(values.quantity) });
  },
  checkout: async (_form, values) => {
    const { referralCode, ...shipping } = values;
    const items = groupSelection ? [groupSelection] : cart;
    const payload = { items, shipping, referralCode };
    const serialized = JSON.stringify(payload);
    if (retryDetails?.serialized !== serialized) retryDetails = { serialized, key: crypto.randomUUID() };
    const order = await api('/api/orders', { method: 'POST', body: { ...payload, idempotencyKey: retryDetails.key } });
    if (!groupSelection) { cart = []; saveCart(); }
    retryDetails = undefined;
    dialog.close();
    notify(order.status === 'PENDING' ? 'Your units are reserved.' : 'Your demo order was placed.');
    await Promise.all([openPortal('orders'), fetchCatalog(), refreshPools()]);
  }
};

search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(fetchCatalog, 200); });
category.addEventListener('change', fetchCatalog);
sort.addEventListener('change', fetchCatalog);
$('#cart-button').addEventListener('click', () => showCart().catch(error => notify(error.message)));
$('#signin-button').addEventListener('click', showAccount);
document.addEventListener('click', async event => {
  const trigger = event.target.closest('[data-action], [data-view]');
  if (!trigger) return;
  event.preventDefault();
  try {
    if (trigger.dataset.view) await openPortal(trigger.dataset.view);
    else if (Object.hasOwn(actions, trigger.dataset.action)) await actions[trigger.dataset.action](trigger.dataset.id);
    else await portals.action(trigger.dataset.action, trigger.dataset.id);
  } catch (error) { notify(error.message); }
});
document.addEventListener('change', event => {
  const input = event.target;
  if (input.dataset.compare) {
    if (input.checked && compared.size >= 4) { input.checked = false; notify('Compare up to four products.'); return; }
    if (input.checked) compared.add(input.dataset.compare);
    else compared.delete(input.dataset.compare);
    renderCatalog();
    [...catalog.querySelectorAll('[data-compare]')].find(node => node.dataset.compare === input.dataset.compare)?.focus({ preventScroll: true });
  }
  if (input.dataset.quantity) {
    if (!input.reportValidity()) return;
    const line = cart.find(item => item.productId === input.dataset.quantity);
    if (line) line.quantity = Number(input.value);
    saveCart();
    void showCart();
  }
  portals.change(input);
});
document.addEventListener('submit', event => {
  const form = event.target;
  const name = form.dataset.form;
  if (!name) return;
  event.preventDefault();
  void runForm(form, values => Object.hasOwn(forms, name) ? forms[name](form, values) : portals.submit(name, form, values))
    .catch(error => notify(error.message));
});
dialog.addEventListener('cancel', () => { afterSignIn = undefined; });
$('#dialog-close').addEventListener('click', () => { afterSignIn = undefined; });
window.addEventListener('wss-language', () => {
  syncAccount(); renderCategories(); renderCatalog(); renderPools();
  if (search.value.trim()) void fetchCatalog();
  if (view && !portal.hidden) void openPortal(view, false);
});
window.addEventListener('wss-catalog-update', async () => {
  try { categories = await api('/api/categories'); renderCategories(); }
  catch (error) { notify(error.message); }
  await Promise.all([fetchCatalog(), refreshPools()]);
});

localizeShell();
saveCart();
const initial = await Promise.allSettled([api('/api/config'), api('/api/session'), api('/api/categories')]);
if (initial[0].status === 'fulfilled') config = initial[0].value;
if (initial[1].status === 'fulfilled') user = initial[1].value.user;
if (initial[2].status === 'fulfilled') categories = initial[2].value;
syncAccount();
renderCategories();
await Promise.all([fetchCatalog(), refreshPools()]);
