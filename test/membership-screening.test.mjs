import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase } from '../src/database.mjs';
import { createOperations } from '../src/operations.mjs';

const manufacturer = {
  requestedRole: 'MANUFACTURER',
  companyName: 'Accreditation fixture',
  countryCode: 'vn',
  businessSummary: 'Regional textile factory',
  productionCapacity: 1_000,
  qualityControls: 'Batch sampling',
  complianceReference: 'FIXTURE-COMPLIANCE-123'
};
const freight = {
  requestedRole: 'FREIGHT_PARTNER',
  companyName: 'Carrier fixture',
  countryCode: 'SG',
  businessSummary: 'Warehousing and container freight',
  transportRegions: 'Singapore and Malaysia',
  warehousing: 'Dry storage at regional port',
  coldChain: false
};
const verifiedApproval = { decision: 'APPROVED', verificationConfirmed: true };
const status = expected => error => error.status === expected;

function user(db, id, role = 'CONSUMER') {
  const actor = { id, name: id, role };
  db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(id, actor.name, `${id}@example.invalid`, 'test-fixture', role);
  return actor;
}

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return { db, operations: createOperations(db), reviewer: user(db, 'reviewer', 'ADMIN') };
}

test('the three tiers persist relevant screening checks without recording a manual verification', t => {
  const { db, operations, reviewer } = fixture(t);
  const customer = user(db, 'customer');
  const supplier = user(db, 'supplier');
  const carrier = user(db, 'carrier');
  for (const countryCode of ['ZZ', 'AA', 'UN']) {
    assert.throws(() => operations.submitMembership(customer, { requestedRole: 'CONSUMER', countryCode }), status(422));
  }
  assert.throws(() => operations.submitMembership(supplier, { ...manufacturer, productionCapacity: 0 }), status(422));
  assert.throws(() => operations.submitMembership(carrier, { ...freight, coldChain: 'false' }), status(422));
  const consumerApplication = operations.submitMembership(customer, { requestedRole: 'CONSUMER', countryCode: 'PH' });
  const factoryApplication = operations.submitMembership(supplier, manufacturer);
  const carrierApplication = operations.submitMembership(carrier, freight);
  assert.equal(consumerApplication.status, 'APPROVED');
  assert.equal(factoryApplication.status, 'PENDING');
  assert.equal(carrierApplication.status, 'PENDING');
  assert.equal(carrierApplication.coldChain, false);
  assert.equal(factoryApplication.countryCode, 'VN');
  assert.ok(factoryApplication.screening.screenedAt);
  assert.equal(factoryApplication.screening.version, 1);
  assert.deepEqual(consumerApplication.screening.checks, ['MEMBER_NAME_PROVIDED', 'COUNTRY_CODE_RECOGNIZED']);
  assert.deepEqual(factoryApplication.screening.checks.slice(-3),
    ['PRODUCTION_CAPACITY_VALID', 'QUALITY_CONTROLS_PROVIDED', 'COMPLIANCE_REFERENCE_PROVIDED']);
  assert.deepEqual(carrierApplication.screening.checks.slice(-3),
    ['TRANSPORT_REGIONS_PROVIDED', 'WAREHOUSING_PROVIDED', 'COLD_CHAIN_DECLARED']);
  assert.ok(operations.listMemberships(reviewer).every(record => record.verificationConfirmed === false));
  assert.deepEqual(operations.listMemberships(carrier), [carrierApplication]);
  assert.equal(db.prepare("SELECT count(*) AS count FROM event_outbox WHERE event_type = 'MembershipSubmitted'").get().count, 3);
});

test('submission replays are scoped to the applicant and rejected applications can be resubmitted', t => {
  const { db, operations, reviewer } = fixture(t);
  const applicant = user(db, 'applicant');
  const other = user(db, 'other-applicant');
  const body = { ...manufacturer, idempotencyKey: 'apply-001' };
  const original = operations.submitMembership(applicant, body);
  assert.deepEqual(operations.submitMembership(applicant, { ...body, countryCode: 'VN' }), original);
  assert.throws(() => operations.submitMembership(applicant, { ...body, productionCapacity: 9 }), status(409));
  assert.notEqual(operations.submitMembership(other, body).id, original.id);
  assert.throws(() => db.prepare(`INSERT INTO membership_submission_keys (applicant_id, request_key, request_hash, application_id)
    VALUES (?, ?, ?, ?)`).run(other.id, 'cross-owner', 'a'.repeat(64), original.id), /FOREIGN KEY constraint failed/);
  const rejection = operations.reviewMembership(reviewer, original.id, { decision: 'REJECTED', note: 'Clarify capacity.' });
  assert.deepEqual(operations.submitMembership(applicant, body), rejection);
  const corrected = operations.submitMembership(applicant, { ...body, idempotencyKey: 'apply-002', productionCapacity: 9 });
  assert.notEqual(corrected.id, original.id);
  assert.equal(corrected.productionCapacity, 9);
  assert.equal(operations.listMemberships(applicant).length, 2);
});

test('business approval requires reviewer attestation and revokes only sessions shifting roles', t => {
  const { db, operations, reviewer } = fixture(t);
  const applicant = user(db, 'applicant');
  const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
  insertSession.run('before-approval', applicant.id, Date.now() + 60_000);
  insertSession.run('reviewer-session', reviewer.id, Date.now() + 60_000);
  const countSessions = id => db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(id).count;
  const application = operations.submitMembership(applicant, manufacturer);
  assert.throws(() => operations.reviewMembership(applicant, application.id, verifiedApproval), status(403));
  for (const verificationConfirmed of [undefined, 'true', false]) {
    assert.throws(() => operations.reviewMembership(reviewer, application.id, { decision: 'APPROVED', verificationConfirmed }), status(422));
  }
  assert.equal(operations.listMemberships(applicant)[0].status, 'PENDING');
  assert.equal(countSessions(applicant.id), 1);
  const approval = operations.reviewMembership(reviewer, application.id, verifiedApproval);
  assert.equal(approval.verificationConfirmed, true);
  const audit = db.prepare('SELECT reviewer_id, reviewed_at, status FROM membership_applications WHERE id = ?').get(application.id);
  assert.equal(audit.reviewer_id, reviewer.id);
  assert.ok(audit.reviewed_at);
  assert.equal(audit.status, 'APPROVED');
  assert.equal(countSessions(applicant.id), 0);
  assert.equal(countSessions(reviewer.id), 1);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(applicant.id).role, 'MANUFACTURER');
  insertSession.run('after-approval', applicant.id, Date.now() + 60_000);
  const renewal = operations.submitMembership({ ...applicant, role: 'MANUFACTURER' }, manufacturer);
  operations.reviewMembership(reviewer, renewal.id, verifiedApproval);
  assert.equal(countSessions(applicant.id), 1);
  const events = db.prepare("SELECT payload FROM event_outbox WHERE event_type = 'MembershipSubmitted'").all();
  assert.ok(events.every(({ payload }) => !payload.includes(manufacturer.complianceReference)));
});

test('the screening migration preserves recorded decisions and checks older pending applications at approval', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const apply = filename => db.exec(readFileSync(new URL(`../db/${filename}`, import.meta.url), 'utf8'));
  for (const filename of ['000-identity.sql', '001-commerce.sql', '003-operations.sql', '004-referrals.sql']) apply(filename);
  const reviewer = user(db, 'reviewer', 'ADMIN');
  const customer = user(db, 'customer');
  const carrier = user(db, 'carrier');
  const insert = db.prepare(`INSERT INTO membership_applications (id, applicant_id, requested_role, company_name, country_code,
    business_summary, transport_regions, cold_chain, warehousing, status, reviewed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const createdAt = '2026-10-31T12:00:00.000Z';
  insert.run('legacy-consumer', customer.id, 'CONSUMER', 'Legacy Customer', 'PH', '', '', null, '', 'APPROVED', createdAt, createdAt);
  insert.run('legacy-freight', carrier.id, freight.requestedRole, freight.companyName, freight.countryCode, freight.businessSummary,
    freight.transportRegions, 0, freight.warehousing, 'PENDING', null, createdAt);
  apply('005-membership-screening.sql');
  const operations = createOperations(db);
  const legacy = operations.listMemberships(customer)[0];
  assert.equal(legacy.status, 'APPROVED');
  assert.equal(legacy.screening, null);
  assert.equal(operations.listMemberships(carrier)[0].screening, null);
  const approved = operations.reviewMembership(reviewer, 'legacy-freight', verifiedApproval);
  assert.equal(approved.verificationConfirmed, true);
  assert.equal(approved.screening.version, 1);
  assert.ok(approved.screening.checks.includes('COLD_CHAIN_DECLARED'));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
