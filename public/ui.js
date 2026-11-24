import { locale, t } from './locale.js';

export const $ = (selector, node = document) => node.querySelector(selector);
export const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
export const txt = key => esc(t(key));
export const money = cents => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD' }).format((cents ?? 0) / 100);
export const date = value => value ? new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(new Date(value)) : '—';
export const status = value => t(String(value ?? '').toLowerCase().replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase()));
export const image = (url, alt = '', settings = '') => /^\/images\/[a-z-]+\.jpg$/.test(url ?? '')
  ? `<img class="product-image" src="${esc(url)}" alt="${esc(alt)}" width="500" height="500" ${settings}>`
  : '<div class="product-image product-placeholder" aria-hidden="true">✳</div>';
export const empty = copy => `<p class="empty-state">${txt(copy)}</p>`;
export const button = (copy, action, id = '', style = 'secondary', disabled = false) =>
  `<button type="button" class="button button-${style}" data-action="${esc(action)}" data-id="${esc(id)}"${disabled ? ' disabled' : ''}>${txt(copy)}</button>`;
export const submit = text => `<button type="submit" class="button button-primary">${txt(text)}</button>`;
export const field = (name, label, attributes = '') => `<label>${txt(label)}<input name="${esc(name)}" ${attributes}></label>`;
export const select = (name, label, options, required = true) => `<label>${txt(label)}<select name="${esc(name)}" ${required ? 'required' : ''}>
  ${options.map(([value, text]) => `<option value="${esc(value)}">${txt(text)}</option>`).join('')}</select></label>`;
export const formMessage = '<p class="form-error" role="alert" hidden></p>';
export const table = (columns, rows) => `<div class="table-wrap" tabindex="0" role="region" aria-label="${esc(columns.join(', '))}"><table><thead><tr>${columns.map(column => `<th scope="col">${txt(column)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

export async function api(path, options = {}) {
  const init = { method: options.method ?? 'GET', headers: { Accept: 'application/json' }, signal: options.signal };
  if (init.method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.headers['X-WSS-Request'] = '1';
    init.body = JSON.stringify(options.body ?? {});
  }
  const response = await fetch(path, init);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message ?? 'Request failed. Try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function runForm(form, action) {
  const message = $('.form-error', form);
  if (message) message.hidden = true;
  const buttons = [...form.querySelectorAll('button[type=submit]')];
  for (const control of buttons) control.disabled = true;
  try {
    await action(Object.fromEntries(new FormData(form)));
  } catch (error) {
    if (!message) throw error;
    message.textContent = t(error.message);
    message.hidden = false;
  } finally {
    for (const control of buttons) control.disabled = false;
  }
}
