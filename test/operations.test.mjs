import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerce } from '../src/commerce.mjs';
import { openDatabase } from '../src/database.mjs';
import { createOperations, seedOperations } from '../src/operations.mjs';
import { seedDemo } from '../src/seed.mjs';

const admin = { id: 'demo-admin', role: 'ADMIN' };
const shopper = { id: 'demo-consumer', role: 'CONSUMER', name: 'Demo Shopper' };
const manufacturer = { id: 'demo-manufacturer', role: 'MANUFACTURER', manufacturerId: 'loom-form' };
const carrier = { id: 'demo-freight', role: 'FREIGHT_PARTNER', freightPartnerId: 'demo-carrier' };
const shipping = {
  name: 'Sample Buyer',
  address: '1 Fixture Street',
  city: 'Manila',
  postalCode: '0120',
  country: 'PH'
};

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  seedDemo(db);
  seedOperations(db);
  return { db, commerce: createCommerce(db), operations: createOperations(db) };
}

function checkout(commerce, idempotencyKey, items) {
  return commerce.checkout(shopper.id, { items, shipping, idempotencyKey });
}

function status(expected) {
  return error => error.status === expected;
}

function applicant(db, id) {
  const user = { id, name: id, role: 'CONSUMER' };
  db.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)')
    .run(id, user.name, `${id}@qa.invalid`, 'test-fixture');
  return user;
}

function freightApplication(operations, user) {
  return operations.submitMembership(user, {
    requestedRole: 'FREIGHT_PARTNER',
    companyName: 'Another Carrier',
    countryCode: 'SG',
    businessSummary: 'Regional final-mile delivery',
    transportRegions: 'SG-MY',
    coldChain: false,
    warehousing: 'Cage storage'
  });
}

test('manufacturer operations use paid sales snapshots and enforce inventory ownership', t => {
  const { commerce, operations } = fixture(t);
  const firstReport = operations.manufacturerDashboard(manufacturer);
  assert.equal(firstReport.roi.totalOrders, 0);
  assert.equal(firstReport.roi.roiPercent, null);
  const order = checkout(commerce, 'operations-order', [
    { productId: 'linen-throw', quantity: 2 },
    { productId: 'orbit-speaker', quantity: 1 }
  ]);
  const pooled = checkout(commerce, 'operations-pool', [{ productId: 'linen-throw', quantity: 1, poolId: 'linen-circle' }]);
  assert.equal(order.status, 'PAID');
  assert.equal(pooled.status, 'PENDING');

  const product = operations.updateProduct(manufacturer, 'linen-throw', {
    unitCostCents: 999, quantityAvailable: 11, reorderPoint: 12
  });
  assert.equal(product.hasReorderAlert, true);
  const { roi, reorderAlerts } = operations.manufacturerDashboard(manufacturer);
  assert.equal(roi.totalOrders, 1);
  assert.equal(roi.unitsSold, 2);
  assert.equal(roi.grossRevenueCents, 8_800);
  assert.equal(roi.costOfGoodsCents, 3_600);
  assert.equal(roi.commissionCents, 704);
  assert.equal(roi.netMarginCents, 4_496);
  assert.deepEqual(reorderAlerts.map(alert => alert.id), ['linen-throw']);
  assert.throws(() => operations.updateProduct(manufacturer, 'orbit-speaker', { quantityAvailable: 1 }), status(404));
  assert.throws(() => operations.updateProduct(manufacturer, 'linen-throw', {
    expectedQuantityAvailable: 20, quantityAvailable: 1
  }), status(409));
  assert.throws(() => operations.updateProduct(manufacturer, 'linen-throw', { retailPriceCents: 200 }), status(422));

  const batch = { productId: 'linen-throw', lotCode: 'QA-001', materialInput: 'Flax linen', quantityProduced: 5 };
  assert.equal(operations.createBatch(manufacturer, batch).quantityProduced, 5);
  assert.throws(() => operations.createBatch(manufacturer, batch), status(409));
  const current = operations.manufacturerDashboard(manufacturer);
  assert.equal(current.batches.length, 1);
  assert.equal(current.products[0].quantityAvailable, 16);
  assert.equal(current.reorderAlerts.length, 0);
});

test('group prices stay fixed for all participants while a pool with commitments is open', t => {
  const { commerce, operations } = fixture(t);
  operations.updateProduct(manufacturer, 'linen-throw', { groupPriceCents: 3_100 });
  const first = checkout(commerce, 'pool-first', [{ productId: 'linen-throw', quantity: 1, poolId: 'linen-circle' }]);
  assert.throws(() => operations.updateProduct(manufacturer, 'linen-throw', { groupPriceCents: 3_000 }), status(409));
  const last = checkout(commerce, 'pool-last', [{ productId: 'linen-throw', quantity: 11, poolId: 'linen-circle' }]);
  assert.equal(last.status, 'PAID');
  assert.equal(last.items[0].unitPriceCents, 3_100);
  operations.updateProduct(manufacturer, 'linen-throw', { groupPriceCents: 3_000 });
  const funded = commerce.order(shopper.id, first.id);
  assert.equal(funded.status, 'PAID');
  assert.equal(funded.items[0].unitPriceCents, 3_100);
});

test('membership approval provisions verified roles and limits access to applicants and reviewers', t => {
  const { db, commerce, operations } = fixture(t);
  const consumer = operations.submitMembership(shopper, { requestedRole: 'CONSUMER', countryCode: 'PH' });
  assert.equal(consumer.status, 'APPROVED');
  assert.equal(operations.submitMembership(shopper, { requestedRole: 'CONSUMER', countryCode: 'PH' }).id, consumer.id);
  const user = applicant(db, 'manufacturing-applicant');
  const submission = {
    requestedRole: 'MANUFACTURER',
    companyName: 'Testing Factory',
    countryCode: 'VN',
    businessSummary: 'Textile manufacturer',
    productionCapacity: 1_000,
    qualityControls: 'Batch inspection',
    complianceReference: 'FACTORY-QA-001'
  };
  const application = operations.submitMembership(user, submission);
  assert.equal(application.status, 'PENDING');
  assert.throws(() => operations.submitMembership(user, submission), status(409));
  assert.throws(() => operations.reviewMembership(manufacturer, application.id, { decision: 'APPROVED' }), status(403));
  assert.throws(() => operations.reviewMembership(admin, application.id, { decision: 'REJECTED' }), status(422));
  assert.deepEqual(operations.listMemberships(shopper).map(record => record.id), [consumer.id]);
  assert.equal(operations.listMemberships(admin)[0].id, application.id);

  assert.equal(operations.reviewMembership(admin, application.id, { decision: 'APPROVED', verificationConfirmed: true }).status, 'APPROVED');
  assert.throws(() => operations.reviewMembership(admin, application.id, { decision: 'APPROVED' }), status(409));
  const supplier = db.prepare('SELECT id, role, manufacturer_id AS manufacturerId FROM users WHERE id = ?').get(user.id);
  assert.equal(supplier.role, 'MANUFACTURER');
  const product = operations.createProduct(supplier, {
    sku: 'QA-WOVEN-BAG',
    title: 'Handwoven shoulder bag',
    category: 'Bags & Travel',
    retailPriceCents: 5_000,
    wholesalePriceCents: 4_000,
    groupPriceCents: 3_500,
    quantityAvailable: 10
  });
  assert.equal(commerce.product(product.id).id, product.id);
  assert.equal(operations.manufacturerDashboard(supplier).manufacturer.verified, true);
  assert.equal(operations.manufacturerDashboard(supplier).products.length, 1);

  const partner = applicant(db, 'freight-applicant');
  const rejected = freightApplication(operations, partner);
  assert.equal(operations.reviewMembership(admin, rejected.id, {
    decision: 'REJECTED', note: 'Submit warehouse inspection records.'
  }).status, 'REJECTED');
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(partner.id).role, 'CONSUMER');
  const approved = freightApplication(operations, partner);
  operations.reviewMembership(admin, approved.id, { decision: 'APPROVED', verificationConfirmed: true });
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(partner.id).role, 'FREIGHT_PARTNER');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('freight operations protect addresses and reconcile allowances after delivery', t => {
  const { db, commerce, operations } = fixture(t);
  const order = checkout(commerce, 'freight-order', [{ productId: 'linen-throw', quantity: 2 }]);
  const unconfirmed = checkout(commerce, 'freight-pool', [{ productId: 'linen-throw', quantity: 1, poolId: 'linen-circle' }]);
  const booking = { orderId: order.id, freightPartnerId: carrier.freightPartnerId, waybill: 'qa-010', regionCode: 'APAC' };
  assert.equal(operations.listTracking(shopper, order.id), null);
  assert.throws(() => operations.createShipment(carrier, booking), status(403));
  assert.throws(() => operations.createShipment(admin, { ...booking, orderId: unconfirmed.id }), status(409));
  const shipment = operations.createShipment(admin, booking);
  assert.equal(shipment.status, 'PROCESSING');
  assert.equal(shipment.waybill, 'QA-010');
  assert.equal(operations.freightDashboard(carrier).shipments[0].shippingAddress, shipping.address);
  const publicTracking = operations.listTracking(shopper, order.id);
  assert.equal(publicTracking.regionCode, 'APAC');
  assert.equal(publicTracking.shippingAddress, undefined);
  assert.throws(() => operations.listTracking(manufacturer, order.id), status(404));
  assert.throws(() => operations.addShipmentEvent(carrier, shipment.id, { status: 'DELIVERED' }), status(409));

  const outsider = applicant(db, 'other-carrier');
  const application = freightApplication(operations, outsider);
  operations.reviewMembership(admin, application.id, { decision: 'APPROVED', verificationConfirmed: true });
  const otherCarrier = db.prepare('SELECT id, role, freight_partner_id AS freightPartnerId FROM users WHERE id = ?')
    .get(outsider.id);
  assert.equal(operations.freightDashboard(otherCarrier).shipments.length, 0);
  assert.throws(() => operations.addShipmentEvent(otherCarrier, shipment.id, { status: 'IN_TRANSIT' }), status(404));

  const ledgerEntry = { shipmentId: shipment.id, manufacturerId: 'loom-form', amountCents: 1_250, defectAllowanceCents: 250 };
  assert.throws(() => operations.createRemittance(admin, { ...ledgerEntry, manufacturerId: 'fieldwork-canvas' }), status(404));
  assert.throws(() => operations.createRemittance(admin, { ...ledgerEntry, defectAllowanceCents: 1_251 }), status(422));
  const remittance = operations.createRemittance(admin, ledgerEntry);
  assert.equal(remittance.netAmountCents, 1_000);
  assert.throws(() => operations.createRemittance(admin, ledgerEntry), status(409));
  assert.throws(() => operations.settleRemittance(admin, remittance.id), status(409));
  assert.equal(operations.manufacturerDashboard(manufacturer).roi.netFreightCents, 0);
  operations.addShipmentEvent(carrier, shipment.id, { status: 'IN_TRANSIT', location: 'Regional sorting centre' });
  const delivered = operations.addShipmentEvent(carrier, shipment.id, { status: 'DELIVERED' });
  assert.deepEqual(delivered.events.map(event => event.status), ['PROCESSING', 'IN_TRANSIT', 'DELIVERED']);
  assert.equal(commerce.order(shopper.id, order.id).status, 'DELIVERED');

  assert.equal(operations.settleRemittance(admin, remittance.id).status, 'SETTLED');
  assert.equal(operations.settleRemittance(admin, remittance.id).status, 'SETTLED');
  const { roi } = operations.manufacturerDashboard(manufacturer);
  assert.equal(roi.netMarginCents, 3_496);
  assert.equal(roi.freightAmountCents, 1_250);
  assert.equal(roi.defectAllowanceCents, 250);
  assert.equal(roi.netFreightCents, 1_000);
  assert.equal(db.prepare("SELECT count(*) AS count FROM event_outbox WHERE event_type = 'FreightRemittanceSettled'").get().count, 1);
});
