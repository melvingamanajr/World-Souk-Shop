import { createHash, randomUUID } from 'node:crypto';
import { recordEvent } from './commerce.mjs';
import { transaction } from './database.mjs';
import { HttpError } from './http-error.mjs';

const membershipRoles = ['CONSUMER', 'MANUFACTURER', 'FREIGHT_PARTNER'];
const shipmentStatuses = ['PROCESSING', 'IN_TRANSIT', 'DELIVERED'];
const maxStock = 100_000_000;
const maxUnitPrice = 100_000_000;
const defaultReorderPoint = 10;
const countryNames = new Intl.DisplayNames('en', { type: 'region', fallback: 'none' });
const now = () => new Date().toISOString();
const membershipScreeningVersion = 1;

function requireRole(actor, ...roles) {
  if (!actor) throw new HttpError(401, 'Sign in to continue.');
  if (!roles.includes(actor.role)) throw new HttpError(403, 'Your role does not have access to this operation.');
}

function text(value, label, max, { required = true } = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new HttpError(422, `Enter ${label}.`);
  const result = value.trim();
  if ((required && !result) || result.length > max || result.includes('\0')) {
    throw new HttpError(422, `Enter ${label} using at most ${max} characters.`);
  }
  return result;
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(422, `Enter ${label} as a whole number from ${min} to ${max}.`);
  }
  return value;
}

function identifier(value, label) {
  return text(value, label, 100);
}

function pick(value, choices, message) {
  if (!choices.includes(value)) throw new HttpError(422, message);
  return value;
}

function code(value, label, pattern, max) {
  const result = text(value, label, max).toUpperCase();
  if (!pattern.test(result)) throw new HttpError(422, `Enter a valid ${label}.`);
  return result;
}

function screenMembership(body, defaultName) {
  const requestedRole = pick(body.requestedRole, membershipRoles, 'Choose a membership tier.');
  const consumer = requestedRole === 'CONSUMER';
  const manufacturer = requestedRole === 'MANUFACTURER';
  const freight = requestedRole === 'FREIGHT_PARTNER';
  const countryCode = code(body.countryCode, 'two-letter country code', /^[A-Z]{2}$/u, 2);
  if (!countryNames.of(countryCode) || countryCode === 'ZZ') throw new HttpError(422, 'Enter a recognized country or territory code.');
  const companyName = text(body.companyName ?? (consumer ? defaultName : undefined), 'the member or company name', 150);
  const businessSummary = text(body.businessSummary, 'the business summary', 1500, { required: !consumer });
  const productionCapacity = manufacturer ? integer(body.productionCapacity, 'monthly production capacity', 1, maxStock) : null;
  const qualityControls = manufacturer ? text(body.qualityControls, 'the quality controls', 1000) : '';
  const complianceReference = manufacturer ? text(body.complianceReference, 'the compliance reference', 500) : '';
  const transportRegions = freight ? text(body.transportRegions, 'the operating regions', 500) : '';
  const warehousing = freight ? text(body.warehousing, 'the warehousing capacity', 500) : '';
  if (freight && typeof body.coldChain !== 'boolean') throw new HttpError(422, 'Specify whether cold chain service is available.');
  const coldChain = freight ? body.coldChain : null;
  const checks = ['MEMBER_NAME_PROVIDED', 'COUNTRY_CODE_RECOGNIZED'];
  if (!consumer) checks.push('BUSINESS_SUMMARY_PROVIDED');
  if (manufacturer) checks.push('PRODUCTION_CAPACITY_VALID', 'QUALITY_CONTROLS_PROVIDED', 'COMPLIANCE_REFERENCE_PROVIDED');
  if (freight) checks.push('TRANSPORT_REGIONS_PROVIDED', 'WAREHOUSING_PROVIDED', 'COLD_CHAIN_DECLARED');
  return { requestedRole, companyName, countryCode, businessSummary, productionCapacity, qualityControls,
    complianceReference, transportRegions, coldChain, warehousing, checks };
}

function productFields(body, current = {}) {
  const use = (key, label, min, max) => body[key] === undefined && current[key] !== undefined
    ? current[key]
    : integer(body[key], label, min, max);
  const retailPriceCents = use('retailPriceCents', 'the retail price in cents', 1, maxUnitPrice);
  return {
    retailPriceCents,
    wholesalePriceCents: use('wholesalePriceCents', 'the wholesale price in cents', 1, retailPriceCents),
    groupPriceCents: use('groupPriceCents', 'the group price in cents', 1, retailPriceCents),
    unitCostCents: use('unitCostCents', 'the unit cost in cents', 0, maxUnitPrice),
    wholesaleMin: use('wholesaleMin', 'the wholesale minimum quantity', 2, 10_000),
    quantityAvailable: use('quantityAvailable', 'the available quantity', 0, maxStock),
    reorderPoint: use('reorderPoint', 'the reorder point', 0, maxStock)
  };
}

const readProduct = `
  SELECT p.id, p.sku, p.title, p.description, p.category, p.image_url AS imageUrl,
         p.unit_cost_cents AS unitCostCents, p.retail_price_cents AS retailPriceCents,
         p.wholesale_price_cents AS wholesalePriceCents, p.wholesale_min AS wholesaleMin,
         p.group_price_cents AS groupPriceCents, p.quantity_available AS quantityAvailable,
         COALESCE(r.reorder_point, ${defaultReorderPoint}) AS reorderPoint, p.active
  FROM products p
  LEFT JOIN product_reorder_settings r ON r.product_id = p.id`;

const mapProduct = row => ({
  ...row,
  active: Boolean(row.active),
  hasReorderAlert: Boolean(row.active) && row.quantityAvailable <= row.reorderPoint
});

const readBatch = `
  SELECT b.id, b.product_id AS productId, p.title AS productTitle, b.lot_code AS lotCode,
         b.material_input AS materialInput, b.quantity_produced AS quantityProduced,
         b.note, b.created_at AS createdAt
  FROM production_batches b
  JOIN products p ON p.id = b.product_id`;

const readMembership = `
  SELECT ma.id, ma.applicant_id AS applicantId, u.name AS applicantName, u.email AS applicantEmail,
         ma.requested_role AS requestedRole, ma.company_name AS companyName, ma.country_code AS countryCode,
         ma.business_summary AS businessSummary, ma.production_capacity AS productionCapacity,
         ma.quality_controls AS qualityControls, ma.compliance_reference AS complianceReference,
         ma.transport_regions AS transportRegions, ma.cold_chain AS coldChain, ma.warehousing,
         ma.status, ma.review_note AS reviewNote, ma.reviewed_at AS reviewedAt, ma.created_at AS createdAt,
         ma.screened_at AS screenedAt, ma.screening_version AS screeningVersion, ma.screening_checks AS screeningChecks,
         ma.verification_confirmed AS verificationConfirmed
  FROM membership_applications ma
  JOIN users u ON u.id = ma.applicant_id`;

function mapMembership({ screenedAt, screeningVersion, screeningChecks, verificationConfirmed, ...row }) {
  return {
    ...row,
    coldChain: row.coldChain === null ? null : Boolean(row.coldChain),
    verificationConfirmed: verificationConfirmed === 1,
    screening: screenedAt ? { version: screeningVersion, screenedAt, checks: JSON.parse(screeningChecks) } : null
  };
}

const readShipment = `
  SELECT s.id, s.order_id AS orderId, s.freight_partner_id AS freightPartnerId,
         s.carrier, s.tracking_number AS waybill, s.tracking_number AS trackingNumber,
         s.region_code AS regionCode, s.status, s.estimated_delivery AS estimatedDelivery, s.updated_at AS updatedAt,
         o.shipping_name AS shippingName, o.shipping_address AS shippingAddress,
         o.shipping_city AS shippingCity, o.shipping_postal_code AS shippingPostalCode,
         o.shipping_country AS shippingCountry
  FROM shipments s
  JOIN orders o ON o.id = s.order_id`;

const readRemittance = `
  SELECT r.id, r.shipment_id AS shipmentId, r.manufacturer_id AS manufacturerId,
         m.name AS manufacturerName, s.freight_partner_id AS freightPartnerId, s.carrier,
         s.tracking_number AS waybill, s.region_code AS regionCode, r.amount_cents AS amountCents,
         r.defect_allowance_cents AS defectAllowanceCents, r.amount_cents - r.defect_allowance_cents AS netAmountCents,
         r.currency, r.status, r.created_at AS createdAt, r.settled_at AS settledAt
  FROM freight_remittances r
  JOIN shipments s ON s.id = r.shipment_id
  JOIN manufacturers m ON m.id = r.manufacturer_id`;

function safeNumber(amount) {
  const value = Number(amount);
  if (!Number.isSafeInteger(value)) throw new HttpError(500, 'The report exceeds the supported monetary range.');
  return value;
}

export function createOperations(db) {
  const productByOwner = db.prepare(`${readProduct} WHERE p.id = ? AND p.manufacturer_id = ?`);
  const batchById = db.prepare(`${readBatch} WHERE b.id = ?`);
  const membershipById = db.prepare(`${readMembership} WHERE ma.id = ?`);
  const shipmentById = db.prepare(`${readShipment} WHERE s.id = ?`);
  const remittanceById = db.prepare(`${readRemittance} WHERE r.id = ?`);
  const eventHistory = db.prepare(`
    SELECT id, status, location, note, occurred_at AS occurredAt
    FROM shipment_events
    WHERE shipment_id = ?
    ORDER BY occurred_at, rowid`);
  const productReorder = db.prepare(`
    INSERT INTO product_reorder_settings (product_id, reorder_point, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (product_id) DO UPDATE SET reorder_point = excluded.reorder_point, updated_at = excluded.updated_at`);
  const orderLines = db.prepare(`
    SELECT oi.order_id, oi.product_id, oi.manufacturer_id, oi.quantity, oi.subtotal_cents,
           oi.unit_cost_cents, o.subtotal_cents AS order_subtotal, o.commission_cents
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('PAID', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED')
      AND EXISTS (SELECT 1 FROM order_items owned WHERE owned.order_id = o.id AND owned.manufacturer_id = ?)
    ORDER BY oi.order_id, oi.product_id`);
  orderLines.setReadBigInts(true);
  const settledFreight = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS gross, COALESCE(SUM(defect_allowance_cents), 0) AS defects
    FROM freight_remittances WHERE manufacturer_id = ? AND status = 'SETTLED'`);
  settledFreight.setReadBigInts(true);

  function myManufacturer(actor) {
    requireRole(actor, 'MANUFACTURER');
    const manufacturer = db.prepare('SELECT id, name, country, verified FROM manufacturers WHERE id = ?')
      .get(actor.manufacturerId);
    if (!manufacturer?.verified) throw new HttpError(403, 'A verified manufacturer profile is required.');
    return { ...manufacturer, verified: true };
  }

  function myFreight(actor) {
    const freight = db.prepare('SELECT id FROM freight_partners WHERE id = ? AND user_id = ? AND verified = 1')
      .get(actor.freightPartnerId, actor.id);
    if (!freight) throw new HttpError(403, 'A verified freight profile is required.');
    return freight.id;
  }

  function shipmentRecord(shipment, showAddress) {
    const { shippingName, shippingAddress, shippingCity, shippingPostalCode, shippingCountry, ...summary } = shipment;
    return {
      ...summary,
      ...(showAddress ? { shippingName, shippingAddress, shippingCity, shippingPostalCode, shippingCountry } : {}),
      events: eventHistory.all(shipment.id)
    };
  }

  function manufacturerRoi(manufacturerId) {
    const orders = new Set();
    let orderId;
    let cumulative = 0n;
    let allocated = 0n;
    let units = 0n;
    let revenue = 0n;
    let cost = 0n;
    let commission = 0n;
    for (const line of orderLines.iterate(manufacturerId)) {
      if (line.order_id !== orderId) {
        orderId = line.order_id;
        cumulative = 0n;
        allocated = 0n;
      }
      cumulative += line.subtotal_cents;
      // Allocate in product ID order so the cents reconcile exactly to the order commission.
      const cumulativeCommission = cumulative * line.commission_cents / line.order_subtotal;
      if (line.manufacturer_id === manufacturerId) {
        orders.add(line.order_id);
        units += line.quantity;
        revenue += line.subtotal_cents;
        cost += line.quantity * line.unit_cost_cents;
        commission += cumulativeCommission - allocated;
      }
      allocated = cumulativeCommission;
    }
    const freight = settledFreight.get(manufacturerId);
    const netFreight = freight.gross - freight.defects;
    const spend = cost + commission + netFreight;
    const margin = revenue - spend;
    return {
      totalOrders: orders.size,
      unitsSold: safeNumber(units),
      grossRevenueCents: safeNumber(revenue),
      costOfGoodsCents: safeNumber(cost),
      commissionCents: safeNumber(commission),
      freightAmountCents: safeNumber(freight.gross),
      defectAllowanceCents: safeNumber(freight.defects),
      netFreightCents: safeNumber(netFreight),
      netMarginCents: safeNumber(margin),
      marginPercent: revenue ? Math.round(safeNumber(margin) / safeNumber(revenue) * 10_000) / 100 : null,
      roiPercent: spend ? Math.round(safeNumber(margin) / safeNumber(spend) * 10_000) / 100 : null
    };
  }

  function activateProfile(application) {
    const applicant = db.prepare('SELECT role, manufacturer_id, freight_partner_id FROM users WHERE id = ?')
      .get(application.applicantId);
    if (applicant.role !== 'CONSUMER' && applicant.role !== application.requestedRole) {
      throw new HttpError(409, 'The applicant already has a different operating role.');
    }
    const country = countryNames.of(application.countryCode);
    if (application.requestedRole === 'MANUFACTURER') {
      const profileId = applicant.manufacturer_id ?? randomUUID();
      db.prepare(`INSERT INTO manufacturers (id, name, country, verified) VALUES (?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, country = excluded.country, verified = 1`)
        .run(profileId, application.companyName, country);
      db.prepare("UPDATE users SET role = 'MANUFACTURER', manufacturer_id = ? WHERE id = ?")
        .run(profileId, application.applicantId);
    }
    if (application.requestedRole === 'FREIGHT_PARTNER') {
      const profileId = applicant.freight_partner_id ?? randomUUID();
      db.prepare(`INSERT INTO freight_partners (id, user_id, name, country, verified) VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, country = excluded.country, verified = 1`)
        .run(profileId, application.applicantId, application.companyName, country);
      db.prepare("UPDATE users SET role = 'FREIGHT_PARTNER', freight_partner_id = ? WHERE id = ?")
        .run(profileId, application.applicantId);
    }
    if (applicant.role !== application.requestedRole) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(application.applicantId);
    }
  }

  return {
    manufacturerDashboard(actor) {
      const manufacturer = myManufacturer(actor);
      const products = db.prepare(`${readProduct} WHERE p.manufacturer_id = ? ORDER BY p.title, p.id`)
        .all(manufacturer.id).map(mapProduct);
      const batches = db.prepare(`${readBatch} WHERE p.manufacturer_id = ? ORDER BY b.created_at DESC, b.id LIMIT 100`)
        .all(manufacturer.id);
      return {
        manufacturer,
        products,
        batches,
        roi: manufacturerRoi(manufacturer.id),
        reorderAlerts: products.filter(product => product.hasReorderAlert)
      };
    },

    createProduct(actor, body) {
      const manufacturer = myManufacturer(actor);
      const fields = productFields(body, { unitCostCents: 0, quantityAvailable: 0, wholesaleMin: 5, reorderPoint: defaultReorderPoint });
      const sku = code(body.sku, 'SKU', /^[A-Z0-9][A-Z0-9._-]*$/u, 100);
      const title = text(body.title, 'the product title', 150);
      const category = text(body.category, 'the product category', 80);
      const description = text(body.description, 'the product description', 1500, { required: false });
      const id = randomUUID();
      return transaction(db, () => {
        const inserted = db.prepare(`
          INSERT INTO products (id, manufacturer_id, sku, title, category, description, unit_cost_cents,
            retail_price_cents, wholesale_price_cents, wholesale_min, group_price_cents, quantity_available)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sku) DO NOTHING`)
          .run(id, manufacturer.id, sku, title, category, description, fields.unitCostCents,
            fields.retailPriceCents, fields.wholesalePriceCents, fields.wholesaleMin, fields.groupPriceCents,
            fields.quantityAvailable);
        if (!inserted.changes) throw new HttpError(409, 'A product already uses this SKU.');
        const timestamp = now();
        productReorder.run(id, fields.reorderPoint, timestamp);
        recordEvent(db, 'ProductListed', id, { productId: id, manufacturerId: manufacturer.id }, timestamp);
        return mapProduct(productByOwner.get(id, manufacturer.id));
      });
    },

    updateProduct(actor, id, body) {
      const manufacturer = myManufacturer(actor);
      return transaction(db, () => {
        const previous = productByOwner.get(id, manufacturer.id);
        if (!previous) throw new HttpError(404, 'This product could not be found.');
        if (body.expectedQuantityAvailable !== undefined
          && integer(body.expectedQuantityAvailable, 'the previous available quantity', 0, maxStock) !== previous.quantityAvailable) {
          throw new HttpError(409, 'Stock has changed. Refresh the product before updating it.');
        }
        const fields = productFields(body, previous);
        if (fields.wholesalePriceCents > fields.retailPriceCents || fields.groupPriceCents > fields.retailPriceCents) {
          throw new HttpError(422, 'Wholesale and group prices must be at or below the retail price.');
        }
        const timestamp = now();
        if (fields.groupPriceCents !== previous.groupPriceCents
          && db.prepare(`SELECT 1 FROM pools WHERE product_id = ? AND status = 'OPEN'
             AND committed_quantity > 0 AND ends_at > ? LIMIT 1`).get(id, timestamp)) {
          throw new HttpError(409, 'The group price is fixed while an active community pool has commitments.');
        }
        db.prepare(`UPDATE products SET retail_price_cents = ?, wholesale_price_cents = ?, wholesale_min = ?,
          group_price_cents = ?, unit_cost_cents = ?, quantity_available = ? WHERE id = ? AND manufacturer_id = ?`)
          .run(fields.retailPriceCents, fields.wholesalePriceCents, fields.wholesaleMin, fields.groupPriceCents,
            fields.unitCostCents, fields.quantityAvailable, id, manufacturer.id);
        productReorder.run(id, fields.reorderPoint, timestamp);
        recordEvent(db, 'ProductOperationsUpdated', id, {
          productId: id,
          manufacturerId: manufacturer.id,
          ...fields,
          previousQuantityAvailable: previous.quantityAvailable
        }, timestamp);
        return mapProduct(productByOwner.get(id, manufacturer.id));
      });
    },

    createBatch(actor, body) {
      const manufacturer = myManufacturer(actor);
      const productId = identifier(body.productId, 'a product');
      const lotCode = code(body.lotCode, 'lot code', /^[A-Z0-9][A-Z0-9._/-]*$/u, 80);
      const materialInput = text(body.materialInput, 'the raw material inputs', 1000);
      const quantity = integer(body.quantityProduced, 'the amount produced', 1, maxStock);
      const note = text(body.note, 'the batch note', 500, { required: false });
      return transaction(db, () => {
        const product = productByOwner.get(productId, manufacturer.id);
        if (!product) throw new HttpError(404, 'This product could not be found.');
        if (product.quantityAvailable > maxStock - quantity) throw new HttpError(422, 'The batch exceeds the stock limit.');
        const id = randomUUID();
        const timestamp = now();
        const inserted = db.prepare(`INSERT INTO production_batches
          (id, product_id, recorded_by, lot_code, material_input, quantity_produced, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(product_id, lot_code) DO NOTHING`)
          .run(id, productId, actor.id, lotCode, materialInput, quantity, note, timestamp);
        if (!inserted.changes) throw new HttpError(409, 'A batch with this lot code already exists for the product.');
        db.prepare('UPDATE products SET quantity_available = quantity_available + ? WHERE id = ?').run(quantity, productId);
        recordEvent(db, 'ProductionBatchRecorded', id, {
          batchId: id, productId, manufacturerId: manufacturer.id, quantityProduced: quantity
        }, timestamp);
        return batchById.get(id);
      });
    },

    listMemberships(actor) {
      requireRole(actor, 'ADMIN', ...membershipRoles);
      if (actor.role === 'ADMIN') {
        return db.prepare(`${readMembership}
          ORDER BY CASE WHEN ma.status = 'PENDING' THEN 0 ELSE 1 END, ma.created_at DESC, ma.id LIMIT 200`)
          .all().map(mapMembership);
      }
      return db.prepare(`${readMembership} WHERE ma.applicant_id = ? ORDER BY ma.created_at DESC, ma.id`)
        .all(actor.id).map(mapMembership);
    },

    submitMembership(actor, body) {
      requireRole(actor, ...membershipRoles);
      const { checks, ...application } = screenMembership(body, actor.name);
      const { requestedRole, companyName, countryCode, businessSummary, productionCapacity, qualityControls,
        complianceReference, transportRegions, coldChain, warehousing } = application;
      const consumer = requestedRole === 'CONSUMER';
      const requestKey = body.idempotencyKey === undefined ? null : text(body.idempotencyKey, 'the submission key', 100);
      const requestHash = requestKey ? createHash('sha256').update(JSON.stringify(application)).digest('hex') : null;
      return transaction(db, () => {
        const previous = requestKey && db.prepare(`SELECT application_id, request_hash FROM membership_submission_keys
          WHERE applicant_id = ? AND request_key = ?`).get(actor.id, requestKey);
        if (previous) {
          if (previous.request_hash !== requestHash) throw new HttpError(409, 'This submission key belongs to a different application.');
          return mapMembership(membershipById.get(previous.application_id));
        }
        if (actor.role !== 'CONSUMER' && actor.role !== requestedRole) {
          throw new HttpError(409, 'The application must match your current operating role.');
        }
        const saveRequestKey = id => {
          if (!requestKey) return;
          db.prepare(`INSERT INTO membership_submission_keys (applicant_id, request_key, request_hash, application_id)
            VALUES (?, ?, ?, ?)`).run(actor.id, requestKey, requestHash, id);
        };
        if (consumer) {
          const existing = db.prepare(`${readMembership} WHERE ma.applicant_id = ?
            AND ma.requested_role = 'CONSUMER' AND ma.status = 'APPROVED'`).get(actor.id);
          if (existing) {
            saveRequestKey(existing.id);
            return mapMembership(existing);
          }
        } else if (db.prepare("SELECT 1 FROM membership_applications WHERE applicant_id = ? AND status = 'PENDING'").get(actor.id)) {
          throw new HttpError(409, 'You already have an application waiting for review.');
        }
        const status = consumer ? 'APPROVED' : 'PENDING';
        const id = randomUUID();
        const timestamp = now();
        db.prepare(`INSERT INTO membership_applications
          (id, applicant_id, requested_role, company_name, country_code, business_summary, production_capacity,
           quality_controls, compliance_reference, transport_regions, cold_chain, warehousing, status, reviewed_at, created_at,
           screened_at, screening_version, screening_checks)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, actor.id, requestedRole, companyName, countryCode, businessSummary, productionCapacity, qualityControls,
            complianceReference, transportRegions, coldChain === null ? null : Number(coldChain), warehousing, status,
            consumer ? timestamp : null, timestamp, timestamp, membershipScreeningVersion, JSON.stringify(checks));
        saveRequestKey(id);
        recordEvent(db, 'MembershipSubmitted', id, { applicationId: id, requestedRole, status }, timestamp);
        return mapMembership(membershipById.get(id));
      });
    },

    reviewMembership(actor, id, body) {
      requireRole(actor, 'ADMIN');
      const decision = pick(body.decision, ['APPROVED', 'REJECTED'], 'Choose approval or rejection.');
      const note = text(body.note, 'the review note', 1000, { required: decision === 'REJECTED' });
      return transaction(db, () => {
        const row = membershipById.get(id);
        if (!row) throw new HttpError(404, 'This application could not be found.');
        if (row.status !== 'PENDING') throw new HttpError(409, 'This application already has a decision.');
        const application = mapMembership(row);
        const timestamp = now();
        const approvedBusiness = decision === 'APPROVED' && application.requestedRole !== 'CONSUMER';
        if (approvedBusiness) {
          if (body.verificationConfirmed !== true) throw new HttpError(422, 'Confirm the supporting business records before approving.');
          if (!application.screening) {
            const { checks } = screenMembership(application, application.applicantName);
            db.prepare(`UPDATE membership_applications SET screened_at = ?, screening_version = ?, screening_checks = ?
              WHERE id = ?`).run(timestamp, membershipScreeningVersion, JSON.stringify(checks), id);
          }
          activateProfile(application);
        }
        db.prepare(`UPDATE membership_applications SET status = ?, reviewer_id = ?, review_note = ?, reviewed_at = ?,
          verification_confirmed = ? WHERE id = ?`).run(decision, actor.id, note, timestamp, approvedBusiness ? 1 : null, id);
        recordEvent(db, 'MembershipReviewed', id, {
          applicationId: id, requestedRole: application.requestedRole, status: decision
        }, timestamp);
        return mapMembership(membershipById.get(id));
      });
    },

    freightDashboard(actor) {
      requireRole(actor, 'FREIGHT_PARTNER', 'ADMIN');
      const admin = actor.role === 'ADMIN';
      const partner = admin ? null : myFreight(actor);
      const scoped = admin ? '' : ' WHERE s.freight_partner_id = ?';
      const args = admin ? [] : [partner];
      const shipments = db.prepare(`${readShipment}${scoped} ORDER BY s.updated_at DESC, s.id LIMIT 100`)
        .all(...args).map(shipment => shipmentRecord(shipment, true));
      const remittances = db.prepare(`${readRemittance}${scoped} ORDER BY r.created_at DESC, r.id LIMIT 100`).all(...args);
      const assignableOrders = admin ? db.prepare(`
        SELECT o.id, o.shipping_country AS shippingCountry, o.shipping_city AS shippingCity,
               o.subtotal_cents AS subtotalCents, o.currency, o.created_at AS createdAt
        FROM orders o
        WHERE o.status = 'PAID' AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id)
        ORDER BY o.created_at DESC, o.id LIMIT 100`).all() : [];
      const freightPartners = admin ? db.prepare(`
        SELECT f.id, f.name, f.country FROM freight_partners f
        JOIN users u ON u.freight_partner_id = f.id AND u.id = f.user_id
        WHERE f.verified = 1 AND u.role = 'FREIGHT_PARTNER' ORDER BY f.name, f.id`).all() : [];
      return { shipments, remittances, assignableOrders, freightPartners };
    },

    listTracking(actor, orderId) {
      requireRole(actor, 'ADMIN', ...membershipRoles);
      const order = db.prepare('SELECT user_id FROM orders WHERE id = ?').get(orderId);
      if (!order) throw new HttpError(404, 'This order could not be found.');
      const shipment = db.prepare(`${readShipment} WHERE s.order_id = ?`).get(orderId);
      const owner = order.user_id === actor.id;
      const staff = actor.role === 'ADMIN'
        || (actor.role === 'FREIGHT_PARTNER' && shipment && shipment.freightPartnerId === myFreight(actor));
      if (!owner && !staff) throw new HttpError(404, 'This order could not be found.');
      if (!shipment) return null;
      return shipmentRecord(shipment, staff);
    },

    createShipment(actor, body) {
      requireRole(actor, 'ADMIN');
      const orderId = identifier(body.orderId, 'an order');
      const partnerId = identifier(body.freightPartnerId, 'a freight partner');
      const waybill = code(body.waybill, 'waybill number', /^[A-Z0-9][A-Z0-9._/-]*$/u, 80);
      const regionCode = code(body.regionCode, 'region code', /^[A-Z0-9][A-Z0-9-]*$/u, 20);
      const note = text(body.note, 'the tracking note', 500, { required: false });
      const location = text(body.location, 'the shipment location', 150, { required: false });
      const estimatedDelivery = text(body.estimatedDelivery, 'the estimated delivery date', 10, { required: false });
      if (estimatedDelivery) {
        const parsed = new Date(estimatedDelivery);
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(estimatedDelivery) || !Number.isFinite(parsed.valueOf())
          || parsed.toISOString().slice(0, 10) !== estimatedDelivery) {
          throw new HttpError(422, 'Use an estimated delivery date in YYYY-MM-DD format.');
        }
      }
      return transaction(db, () => {
        const partner = db.prepare(`SELECT f.id, f.name FROM freight_partners f
          JOIN users u ON u.freight_partner_id = f.id AND u.id = f.user_id
          WHERE f.id = ? AND f.verified = 1 AND u.role = 'FREIGHT_PARTNER'`).get(partnerId);
        if (!partner) throw new HttpError(404, 'This freight partner could not be found.');
        const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
        if (!order) throw new HttpError(404, 'This order could not be found.');
        if (order.status !== 'PAID') throw new HttpError(409, 'Only paid orders awaiting assignment can be shipped.');
        const id = randomUUID();
        const timestamp = now();
        const inserted = db.prepare(`INSERT INTO shipments
          (id, order_id, freight_partner_id, carrier, tracking_number, region_code, status, estimated_delivery, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING', ?, ?) ON CONFLICT DO NOTHING`)
          .run(id, orderId, partnerId, partner.name, waybill, regionCode, estimatedDelivery || null, timestamp);
        if (!inserted.changes) throw new HttpError(409, 'The order already has a shipment or the waybill is in use.');
        db.prepare("UPDATE orders SET status = 'PROCESSING', updated_at = ? WHERE id = ?").run(timestamp, orderId);
        db.prepare(`INSERT INTO shipment_events (id, shipment_id, recorded_by, status, location, note, occurred_at)
          VALUES (?, ?, ?, 'PROCESSING', ?, ?, ?)`)
          .run(randomUUID(), id, actor.id, location, note, timestamp);
        recordEvent(db, 'ShipmentAssigned', id, { shipmentId: id, orderId, freightPartnerId: partnerId, regionCode }, timestamp);
        return shipmentRecord(shipmentById.get(id), true);
      });
    },

    addShipmentEvent(actor, id, body) {
      requireRole(actor, 'ADMIN', 'FREIGHT_PARTNER');
      const partnerId = actor.role === 'ADMIN' ? null : myFreight(actor);
      const status = pick(body.status, shipmentStatuses, 'Choose a shipment status.');
      const location = text(body.location, 'the shipment location', 150, { required: false });
      const note = text(body.note, 'the tracking note', 500, { required: false });
      return transaction(db, () => {
        const shipment = shipmentById.get(id);
        if (!shipment || (partnerId && shipment.freightPartnerId !== partnerId)) {
          throw new HttpError(404, 'This shipment could not be found.');
        }
        const previousStep = shipmentStatuses.indexOf(shipment.status);
        const nextStep = shipmentStatuses.indexOf(status);
        if (shipment.status === 'DELIVERED' || nextStep < previousStep || nextStep > previousStep + 1) {
          throw new HttpError(409, 'Choose the current or next available shipment status.');
        }
        if (nextStep === previousStep && !location && !note) {
          throw new HttpError(422, 'Enter a location or note for a shipment update.');
        }
        const timestamp = now();
        db.prepare('UPDATE shipments SET status = ?, updated_at = ? WHERE id = ?').run(status, timestamp, id);
        db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, timestamp, shipment.orderId);
        const eventId = randomUUID();
        db.prepare(`INSERT INTO shipment_events (id, shipment_id, recorded_by, status, location, note, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(eventId, id, actor.id, status, location, note, timestamp);
        recordEvent(db, 'ShipmentUpdated', id, {
          shipmentId: id, orderId: shipment.orderId, shipmentEventId: eventId, status
        }, timestamp);
        return shipmentRecord(shipmentById.get(id), true);
      });
    },

    createRemittance(actor, body) {
      requireRole(actor, 'ADMIN');
      const shipmentId = identifier(body.shipmentId, 'a shipment');
      const manufacturerId = identifier(body.manufacturerId, 'a manufacturer');
      const amount = integer(body.amountCents, 'the freight amount in cents', 1, 1_000_000_000);
      const allowance = integer(body.defectAllowanceCents ?? 0, 'the defect allowance in cents', 0, amount);
      return transaction(db, () => {
        const supplier = db.prepare(`SELECT o.currency FROM shipments s JOIN orders o ON o.id = s.order_id
          WHERE s.id = ? AND EXISTS (
            SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.manufacturer_id = ?
          )`).get(shipmentId, manufacturerId);
        if (!supplier) throw new HttpError(404, 'This shipment and manufacturer combination could not be found.');
        const timestamp = now();
        const id = randomUUID();
        const inserted = db.prepare(`INSERT INTO freight_remittances
          (id, shipment_id, manufacturer_id, recorded_by, amount_cents, defect_allowance_cents, currency, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?) ON CONFLICT(shipment_id, manufacturer_id) DO NOTHING`)
          .run(id, shipmentId, manufacturerId, actor.id, amount, allowance, supplier.currency, timestamp);
        if (!inserted.changes) throw new HttpError(409, 'This manufacturer already has a ledger entry for the shipment.');
        recordEvent(db, 'FreightRemittanceRecorded', id, {
          remittanceId: id, shipmentId, manufacturerId, amountCents: amount, defectAllowanceCents: allowance,
          currency: supplier.currency
        }, timestamp);
        return remittanceById.get(id);
      });
    },

    settleRemittance(actor, id) {
      requireRole(actor, 'ADMIN');
      return transaction(db, () => {
        const remittance = remittanceById.get(id);
        if (!remittance) throw new HttpError(404, 'This remittance could not be found.');
        if (remittance.status === 'SETTLED') return remittance;
        const shipment = shipmentById.get(remittance.shipmentId);
        if (shipment.status !== 'DELIVERED') throw new HttpError(409, 'Record the delivery before settling this remittance.');
        const timestamp = now();
        db.prepare(`UPDATE freight_remittances SET status = 'SETTLED', settled_at = ?, settled_by = ?
          WHERE id = ?`).run(timestamp, actor.id, id);
        recordEvent(db, 'FreightRemittanceSettled', id, {
          remittanceId: id, shipmentId: remittance.shipmentId, netAmountCents: remittance.netAmountCents,
          currency: remittance.currency
        }, timestamp);
        return remittanceById.get(id);
      });
    }
  };
}

export function seedOperations(db) {
  db.prepare(`INSERT INTO freight_partners (id, user_id, name, country, verified)
    SELECT 'demo-carrier', id, 'Meridian Freight Co.', 'Philippines', 1
    FROM users WHERE id = 'demo-freight' ON CONFLICT(id) DO NOTHING`).run();
}
