CREATE TABLE IF NOT EXISTS product_reorder_settings (
    product_id TEXT PRIMARY KEY REFERENCES products(id),
    reorder_point INTEGER NOT NULL CHECK (reorder_point BETWEEN 0 AND 100000000),
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS production_batches (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    recorded_by TEXT NOT NULL REFERENCES users(id),
    lot_code TEXT NOT NULL,
    material_input TEXT NOT NULL,
    quantity_produced INTEGER NOT NULL CHECK (quantity_produced BETWEEN 1 AND 100000000),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (product_id, lot_code)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_production_batches_product ON production_batches(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS freight_partners (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX IF NOT EXISTS ix_freight_partners_verified ON freight_partners(verified);

CREATE TABLE IF NOT EXISTS membership_applications (
    id TEXT PRIMARY KEY,
    applicant_id TEXT NOT NULL REFERENCES users(id),
    requested_role TEXT NOT NULL CHECK (requested_role IN ('MANUFACTURER', 'CONSUMER', 'FREIGHT_PARTNER')),
    company_name TEXT NOT NULL,
    country_code TEXT NOT NULL CHECK (length(country_code) = 2),
    business_summary TEXT NOT NULL,
    production_capacity INTEGER CHECK (production_capacity > 0),
    quality_controls TEXT NOT NULL DEFAULT '',
    compliance_reference TEXT NOT NULL DEFAULT '',
    transport_regions TEXT NOT NULL DEFAULT '',
    cold_chain INTEGER CHECK (cold_chain IN (0, 1)),
    warehousing TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    reviewer_id TEXT REFERENCES users(id),
    review_note TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    CHECK ((status = 'PENDING') = (reviewed_at IS NULL)),
    CHECK (status = 'PENDING' OR reviewer_id IS NOT NULL OR requested_role = 'CONSUMER')
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_membership_applicant
    ON membership_applications(applicant_id) WHERE status = 'PENDING';
CREATE UNIQUE INDEX IF NOT EXISTS ux_consumer_membership_applicant
    ON membership_applications(applicant_id) WHERE requested_role = 'CONSUMER' AND status = 'APPROVED';
CREATE INDEX IF NOT EXISTS ix_membership_applicant ON membership_applications(applicant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS shipment_events (
    id TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL REFERENCES shipments(id),
    recorded_by TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'IN_TRANSIT', 'DELIVERED')),
    location TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_shipment_events_shipment ON shipment_events(shipment_id, occurred_at);

CREATE TABLE IF NOT EXISTS freight_remittances (
    id TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL REFERENCES shipments(id),
    manufacturer_id TEXT NOT NULL REFERENCES manufacturers(id),
    recorded_by TEXT NOT NULL REFERENCES users(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000),
    defect_allowance_cents INTEGER NOT NULL CHECK (defect_allowance_cents BETWEEN 0 AND amount_cents),
    currency TEXT NOT NULL CHECK (length(currency) = 3),
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'SETTLED')),
    created_at TEXT NOT NULL,
    settled_by TEXT REFERENCES users(id),
    settled_at TEXT,
    UNIQUE (shipment_id, manufacturer_id),
    CHECK ((status = 'SETTLED') = (settled_at IS NOT NULL AND settled_by IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS ix_freight_remittance_manufacturer
    ON freight_remittances(manufacturer_id, status);
