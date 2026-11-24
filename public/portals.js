import { $, api, button, date, empty, esc, field, formMessage, money, select, status, submit, table, txt } from './ui.js';

const heading = label => `<h2 tabindex="-1">${txt(label)}</h2>`;
const panel = (label, markup) => `<section class="panel"><h3>${txt(label)}</h3>${markup}</section>`;
const actionForm = (name, fields, label, id = '', attributes = '') => `<form class="form-grid" data-form="${name}" data-id="${esc(id)}" ${attributes}>${fields}${formMessage}<div class="form-actions">${submit(label)}</div></form>`;
const textarea = (name, label, attributes = '') => `<label>${txt(label)}<textarea name="${name}" rows="3" ${attributes}></textarea></label>`;
const number = (name, label, value = '', min = 0, max = 100000000) => field(name, label, `required type="number" min="${min}" max="${max}" step="1" value="${value}"`);
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const short = id => esc(id?.slice(0, 8).toUpperCase());
const endpointKey = id => encodeURIComponent(id);
const badge = value => `<span class="status-badge">${esc(status(value))}</span>`;
const stats = items => `<dl class="stat-grid">${items.map(([label, value]) => `<div><dt>${txt(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
const percent = value => value === null ? '—' : `${value}%`;
const role = value => ({ CONSUMER: 'Consumer', MANUFACTURER: 'Manufacturer', FREIGHT_PARTNER: 'Freight partner' })[value] ?? value;

function orderDetails(order, shipment) {
  const rows = order.items.map(line => [txt(line.title), line.quantity, esc(status(line.priceTier)), money(line.unitPriceCents), money(line.subtotalCents)]);
  return `<p>${badge(order.status)} · ${date(order.createdAt)}</p>${table(['Product', 'Quantity', 'Price tier', 'Unit price', 'Subtotal'], rows)}
    ${stats([['Order total', money(order.subtotalCents)], ['Cashback', money(order.cashbackCents)]])}
    <h3>${txt('Shipping address')}</h3><p>${esc(order.shipping.name)}<br>${esc(order.shipping.address)}<br>${esc(order.shipping.city)} ${esc(order.shipping.postalCode)}<br>${esc(order.shipping.country)}</p>
    <h3>${txt('Track shipment')}</h3>${tracking(shipment)}`;
}

function tracking(shipment) {
  if (!shipment) return empty('Shipment tracking will appear after a carrier is assigned.');
  return `<p><strong>${esc(shipment.waybill)}</strong> · ${esc(shipment.carrier)} · ${esc(shipment.regionCode)} · ${badge(shipment.status)}
    ${shipment.estimatedDelivery ? ` · ${txt('Estimated delivery')} ${date(shipment.estimatedDelivery)}` : ''}</p>
    ${shipment.events.length ? `<ol class="timeline">${shipment.events.map(event => `<li><strong>${esc(status(event.status))}</strong> <span>${date(event.occurredAt)}</span>
      ${event.location ? `<p>${esc(event.location)}</p>` : ''}${event.note ? `<p>${esc(event.note)}</p>` : ''}</li>`).join('')}</ol>` : ''}`;
}

function ordersWorkspace(orders, wallet) {
  return `${heading('Orders & rewards')}${panel('Cashback balance', stats([['Available', money(wallet.availableCents)], ['Pending', money(wallet.pendingCents)]]))}
    ${panel('Order history', orders.length ? table(['Order', 'Date', 'Status', 'Total', 'Cashback', 'Details'], orders.map(order => [
      short(order.id), date(order.createdAt), badge(order.status), money(order.subtotalCents), money(order.cashbackCents), button('View order', 'order-detail', order.id)
    ])) : empty('You do not have any orders yet.'))}`;
}

const productNumbers = product => number('retailPriceCents', 'Retail price (USD cents)', product?.retailPriceCents ?? '', 1) +
  number('wholesalePriceCents', 'Wholesale price (USD cents)', product?.wholesalePriceCents ?? '', 1) +
  number('groupPriceCents', 'Group price (USD cents)', product?.groupPriceCents ?? '', 1) +
  number('unitCostCents', 'Unit cost (USD cents)', product?.unitCostCents ?? 0) +
  number('wholesaleMin', 'Wholesale minimum', product?.wholesaleMin ?? 5, 2, 10000) +
  number('quantityAvailable', 'Available stock', product?.quantityAvailable ?? 0) +
  number('reorderPoint', 'Reorder threshold', product?.reorderPoint ?? 10);

function manufacturerWorkspace(data) {
  const { manufacturer, products, batches, roi, reorderAlerts } = data;
  return `${heading('Manufacturer hub')}<p>${esc(manufacturer.name)} · ${esc(manufacturer.country)} · ${txt('Verified manufacturer')}</p>
    ${panel('Sales and margins', stats([['Sales', money(roi.grossRevenueCents)], ['Net margin', money(roi.netMarginCents)], ['Margin rate', percent(roi.marginPercent)], ['Return on investment', percent(roi.roiPercent)], ['Orders', roi.totalOrders], ['Units sold', roi.unitsSold], ['Cost of goods', money(roi.costOfGoodsCents)], ['Commission', money(roi.commissionCents)], ['Net freight', money(roi.netFreightCents)], ['Defect allowances', money(roi.defectAllowanceCents)]]))}
    ${panel('Inventory & pricing', `${reorderAlerts.length ? `<p class="form-error">${txt('Reorder alert')} · ${reorderAlerts.map(product => txt(product.title)).join(', ')}</p>` : ''}
      ${products.length ? table(['Product', 'SKU', 'Available', 'Reorder point', 'Retail', 'Wholesale', 'Group', 'Actions'], products.map(product => [txt(product.title), esc(product.sku), product.quantityAvailable, product.reorderPoint,
    money(product.retailPriceCents), money(product.wholesalePriceCents), money(product.groupPriceCents), button('Edit', 'edit-product', product.id)])) : empty('List your first product to add it to the marketplace.')}
      <div class="toolbar workspace-toolbar">${button('List a product', 'create-product', '', 'primary')}</div>`)}
    ${panel('Production batches', `${products.length ? actionForm('batch', select('productId', 'Product', products.map(product => [product.id, product.title])) +
      field('lotCode', 'Lot code', 'required maxlength="80"') + field('materialInput', 'Raw materials', 'required maxlength="1000"') +
      number('quantityProduced', 'Units produced', '', 1) + textarea('note', 'Batch notes', 'maxlength="500"'), 'Record batch') : ''}
      ${batches.length ? table(['Lot', 'Product', 'Materials', 'Units', 'Date'], batches.map(batch => [esc(batch.lotCode), txt(batch.productTitle), esc(batch.materialInput), batch.quantityProduced, date(batch.createdAt)])) : empty('No production batches recorded.')}`)}`;
}

function membershipDetails(application) {
  return `<details class="review-details"><summary>${txt('Application details')}</summary>
    <p>${esc(application.applicantName)} · ${esc(application.applicantEmail)} · ${esc(application.countryCode)}</p>
    <p>${esc(application.businessSummary)}</p>
    ${application.productionCapacity ? `<p>${txt('Monthly production capacity')} ${application.productionCapacity}<br>${txt('Quality controls')} ${esc(application.qualityControls)}<br>${txt('Compliance reference')} ${esc(application.complianceReference)}</p>` : ''}
    ${application.transportRegions ? `<p>${txt('Operating regions')} ${esc(application.transportRegions)}<br>${txt('Warehousing')} ${esc(application.warehousing)}<br>${txt('Cold chain')} ${txt(application.coldChain ? 'Yes' : 'No')}</p>` : ''}
  </details>`;
}

function membershipTable(applications, admin = false) {
  if (!applications.length) return empty('No membership applications yet.');
  const columns = ['Member', 'Tier', 'Submitted', 'Status', 'Review'];
  if (admin) columns.push('Actions');
  return table(columns, applications.map(application => [
    esc(application.companyName), txt(role(application.requestedRole)), date(application.createdAt), badge(application.status),
    `${application.reviewNote ? esc(application.reviewNote) : '—'}${admin ? membershipDetails(application) : ''}`,
    ...(admin ? [application.status === 'PENDING' ? button('Review', 'review-membership', application.id) : '—'] : [])
  ]));
}

function membershipWorkspace(applications, user) {
  if (user.role === 'ADMIN') return `${heading('Membership')}${panel('Membership applications', membershipTable(applications, true))}`;
  const base = select('requestedRole', 'Membership tier', ['CONSUMER', 'MANUFACTURER', 'FREIGHT_PARTNER']
    .filter(item => user.role === 'CONSUMER' || user.role === item).map(item => [item, role(item)])) +
    field('companyName', 'Member or company name', `required maxlength="150" value="${esc(user.name)}"`) +
    field('countryCode', 'Two-letter country code', 'required minlength="2" maxlength="2" pattern="[A-Za-z]{2}" placeholder="PH"') +
    textarea('businessSummary', 'Business summary', 'maxlength="1500" data-business-summary');
  const manufacturer = `<fieldset class="form-grid role-fields" data-membership-fields="MANUFACTURER" hidden disabled><legend>${txt('Manufacturer details')}</legend>
    ${number('productionCapacity', 'Monthly production capacity', '', 1)}${field('qualityControls', 'Quality controls', 'required maxlength="1000"')}
    ${field('complianceReference', 'Compliance reference', 'required maxlength="500"')}</fieldset>`;
  const freight = `<fieldset class="form-grid role-fields" data-membership-fields="FREIGHT_PARTNER" hidden disabled><legend>${txt('Freight details')}</legend>
    ${field('transportRegions', 'Operating regions', 'required maxlength="500"')}${field('warehousing', 'Warehousing', 'required maxlength="500"')}
    ${select('coldChain', 'Cold chain service', [['false', 'No'], ['true', 'Yes']])}</fieldset>`;
  return `${heading('Membership')}${panel('Membership pre-survey', actionForm('apply-membership', base + manufacturer + freight, 'Submit application'))}
    ${panel('Application history', membershipTable(applications))}`;
}

function freightPanels(freight, manufacturers, admin) {
  const { shipments, remittances, assignableOrders, freightPartners } = freight;
  const shipmentForm = assignableOrders.length && freightPartners.length ? actionForm('create-shipment',
    select('orderId', 'Paid order', assignableOrders.map(order => [order.id, `${order.id.slice(0, 8)} · ${order.shippingCity}, ${order.shippingCountry} · ${money(order.subtotalCents)}`])) +
    select('freightPartnerId', 'Freight partner', freightPartners.map(partner => [partner.id, partner.name])) +
    field('waybill', 'Waybill', 'required maxlength="80"') + field('regionCode', 'Region code', 'required maxlength="20" placeholder="APAC"') +
    field('location', 'Initial location', 'maxlength="150"') + field('estimatedDelivery', 'Estimated delivery', 'type="date"') +
    textarea('note', 'Shipment note', 'maxlength="500"'), 'Assign shipment') : empty('Paid orders awaiting shipment will appear here.');
  const shipmentRows = shipments.map(shipment => [esc(shipment.waybill), short(shipment.orderId), esc(shipment.carrier), esc(shipment.regionCode), badge(shipment.status), button('View shipment', 'shipment-detail', shipment.id)]);
  const remittanceForm = shipments.length && manufacturers.length ? `<details><summary>${txt('Record a remittance')}</summary>${actionForm('create-remittance',
    select('shipmentId', 'Shipment', shipments.map(shipment => [shipment.id, shipment.waybill])) +
    select('manufacturerId', 'Manufacturer on the order', manufacturers.map(manufacturer => [manufacturer.id, manufacturer.name])) +
    number('amountCents', 'Freight amount (USD cents)', '', 1, 1000000000) + number('defectAllowanceCents', 'Defect allowance (USD cents)', 0, 0, 1000000000), 'Record remittance')}</details>` : '';
  const remittanceRows = remittances.map(row => [esc(row.waybill), esc(row.manufacturerName), esc(row.regionCode), money(row.amountCents), money(row.defectAllowanceCents), money(row.netAmountCents), badge(row.status),
    ...(admin ? [row.status === 'PENDING' ? button('Settle', 'settle-remittance', row.id, 'secondary', shipments.find(shipment => shipment.id === row.shipmentId)?.status !== 'DELIVERED') : '—'] : [])]);
  return `${admin ? panel('Assign freight', shipmentForm) : ''}
    ${panel('Shipment tracking', shipmentRows.length ? table(['Waybill', 'Order', 'Carrier', 'Region', 'Status', 'Actions'], shipmentRows) : empty('No shipments assigned.'))}
    ${panel('Freight remittances', `${remittanceForm}${remittanceRows.length ? table(['Waybill', 'Manufacturer', 'Region', 'Amount', 'Defect allowance', 'Net', 'Status', ...(admin ? ['Actions'] : [])], remittanceRows) : empty('No remittances recorded.')}`)}`;
}

function adminPanel(overview) {
  return panel('Marketplace summary', stats([['Paid orders', overview.orders], ['Gross merchandise value', money(overview.gmvCents)],
    ['Platform commission', money(overview.commissionCents)], ['Platform operations', money(overview.platformCents)],
    ['Consumer cashback', money(overview.cashbackCents)], ['Affiliate allocation', money(overview.affiliateCents)],
    ['Community reserve', money(overview.communityCents)]]));
}

function privacyWorkspace(requests) {
  return `${heading('Data & privacy')}${panel('Your data', `<p>${txt('Download account, order, wallet and membership records as a JSON file.')}</p>
    <a class="button button-secondary" href="/api/privacy/export" download>${txt('Download my data')}</a>`)}
    ${panel('Privacy request', `${actionForm('privacy', select('kind', 'Request type', [['ERASURE', 'Erase my data'], ['CORRECTION', 'Correct my data']]) +
      textarea('detail', 'Request details', 'maxlength="1000"'), 'Submit request')}
    ${requests.length ? table(['Type', 'Date', 'Status'], requests.map(request => [esc(status(request.kind)), date(request.createdAt), badge(request.status)])) : ''}`)}`;
}

export function createPortals({ portal, notify, modal, account }) {
  let active;
  let model;
  let revision = 0;

  const pages = {
    async orders() { return ordersWorkspace(...await Promise.all([api('/api/orders'), api('/api/wallet')])); },
    async memberships() { return membershipWorkspace(await api('/api/memberships'), account()); },
    async manufacturer() {
      const data = await api('/api/manufacturer');
      return { data, html: manufacturerWorkspace(data) };
    },
    async freight() {
      const data = await api('/api/freight');
      return { data, html: heading('Freight hub') + freightPanels(data, [], account().role === 'ADMIN') };
    },
    async admin() {
      const [freight, memberships, manufacturers, overview, privacy] = await Promise.all([
        api('/api/freight'), api('/api/memberships'), api('/api/admin/manufacturers'), api('/api/admin/overview'), api('/api/admin/privacy')
      ]);
      const privacyPanel = panel('Privacy requests', privacy.length ? table(['Account', 'Request', 'Details', 'Status'], privacy.map(request => [
        esc(request.email), esc(status(request.kind)), esc(request.detail), badge(request.status)
      ])) : empty('No privacy requests yet.'));
      return { data: { ...freight, memberships }, html: heading('Operations') + adminPanel(overview) +
        panel('Membership review', membershipTable(memberships, true)) + freightPanels(freight, manufacturers, true) + privacyPanel };
    },
    async privacy() { return privacyWorkspace(await api('/api/privacy')); }
  };

  async function open(name) {
    const current = ++revision;
    active = name;
    model = undefined;
    portal.innerHTML = `<p role="status">${txt('Loading…')}</p>`;
    try {
      if (!Object.hasOwn(pages, name)) throw new Error('This workspace could not be found.');
      const result = await pages[name]();
      if (current !== revision || !account()) return;
      model = result.data;
      portal.innerHTML = result.html ?? result;
      const choice = $('[name=requestedRole]', portal);
      if (choice) change(choice);
    } catch (error) {
      if (current !== revision || !account()) return;
      portal.innerHTML = `${heading('Workspace')}${empty(error.message)}${error.status === 403 ? button('Membership', 'workspace', 'memberships') : ''}`;
    }
  }

  function change(input) {
    if (input.name !== 'requestedRole') return;
    const parent = input.form;
    $('[data-business-summary]', parent).required = input.value !== 'CONSUMER';
    for (const group of parent.querySelectorAll('[data-membership-fields]')) {
      group.disabled = group.hidden = group.dataset.membershipFields !== input.value;
    }
  }

  const actions = {
    async 'order-detail'(id) {
      const [order, { shipment }] = await Promise.all([api(`/api/orders/${endpointKey(id)}`), api(`/api/orders/${endpointKey(id)}/tracking`)]);
      modal('order', `Order ${order.id.slice(0, 8).toUpperCase()}`, orderDetails(order, shipment));
    },
    'edit-product'(id) {
      const product = model.products.find(row => row.id === id);
      modal('edit-product', product.title, actionForm('edit-product', hidden('expectedQuantityAvailable', product.quantityAvailable) + productNumbers(product), 'Save', id));
    },
    'create-product'() {
      modal('create-product', 'List a product', actionForm('create-product', field('sku', 'SKU', 'required maxlength="100"') +
        field('title', 'Product name', 'required maxlength="150"') + field('category', 'Category', 'required maxlength="80"') +
        textarea('description', 'Description', 'maxlength="1500"') + productNumbers(), 'Publish listing'));
    },
    'review-membership'(id) {
      const application = model?.memberships?.find(row => row.id === id);
      modal('review-membership', 'Review membership', `${application ? membershipDetails(application) : ''}${actionForm('review-membership',
        select('decision', 'Decision', [['APPROVED', 'Approve'], ['REJECTED', 'Reject']]) + textarea('note', 'Review notes', 'maxlength="1000"'), 'Record decision', id)}`);
    },
    'shipment-detail'(id) {
      const shipment = model.shipments.find(row => row.id === id);
      const milestones = ['PROCESSING', 'IN_TRANSIT', 'DELIVERED'];
      const current = milestones.indexOf(shipment.status);
      modal('shipment-details', 'Shipment details', `${tracking(shipment)}
        <p>${esc(shipment.shippingName)} · ${esc(shipment.shippingAddress)} · ${esc(shipment.shippingCity)} ${esc(shipment.shippingPostalCode)} · ${esc(shipment.shippingCountry)}</p>
        ${current < 2 ? actionForm('shipment-event', select('status', 'Status', milestones.slice(current, current + 2).map(state => [state, status(state)])) +
          field('location', 'Location', 'maxlength="150"') + textarea('note', 'Tracking note', 'maxlength="500"'), 'Record update', id) : ''}`);
    },
    'settle-remittance'(id) {
      modal('settle-remittance', 'Settle remittance', `<p>${txt('Record this delivered shipment’s remittance as settled in the local ledger.')}</p>${actionForm('settle-remittance', '', 'Settle', id)}`);
    }
  };

  const mutations = {
    'edit-product': ['PATCH', id => `/api/manufacturer/products/${id}`, 'Product updated.'],
    'create-product': ['POST', () => '/api/manufacturer/products', 'Product listed.'],
    batch: ['POST', () => '/api/manufacturer/batches', 'Batch recorded.'],
    'apply-membership': ['POST', () => '/api/memberships', 'Membership submitted.'],
    'review-membership': ['PATCH', id => `/api/memberships/${id}`, 'Decision recorded.'],
    'create-shipment': ['POST', () => '/api/freight/shipments', 'Shipment assigned.'],
    'shipment-event': ['POST', id => `/api/freight/shipments/${id}/events`, 'Shipment updated.'],
    'create-remittance': ['POST', () => '/api/freight/remittances', 'Remittance recorded.'],
    'settle-remittance': ['PATCH', id => `/api/freight/remittances/${id}`, 'Remittance settled.'],
    privacy: ['POST', () => '/api/privacy', 'Privacy request received.']
  };
  const numeric = new Set(['retailPriceCents', 'wholesalePriceCents', 'groupPriceCents', 'unitCostCents', 'wholesaleMin', 'quantityAvailable',
    'expectedQuantityAvailable', 'reorderPoint', 'quantityProduced', 'productionCapacity', 'amountCents', 'defectAllowanceCents']);

  return {
    open, change,
    action(name, id) { if (Object.hasOwn(actions, name)) return actions[name](id); },
    async submit(name, form, values) {
      if (!Object.hasOwn(mutations, name)) return;
      const [method, path, message] = mutations[name];
      const body = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, numeric.has(key) ? Number(value) : key === 'coldChain' ? value === 'true' : value]));
      const destination = active;
      await api(path(endpointKey(form.dataset.id)), { method, body });
      const dialog = form.closest('dialog');
      if (dialog?.open) dialog.close();
      notify(message);
      if (['edit-product', 'create-product', 'batch'].includes(name)) window.dispatchEvent(new Event('wss-catalog-update'));
      if (destination === active && account()) await open(active);
    }
  };
}
