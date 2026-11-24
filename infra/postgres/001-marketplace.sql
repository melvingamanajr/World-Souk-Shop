-- Initial schema for a fresh PostgreSQL database. Apply this file in one transaction.
CREATE SCHEMA wss;
SET LOCAL search_path = wss, pg_catalog;

CREATE TYPE user_role AS ENUM ('CONSUMER', 'MANUFACTURER', 'FREIGHT_PARTNER', 'ADMIN');
CREATE TYPE order_status AS ENUM ('PENDING', 'PAID', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED');
CREATE TYPE shipment_status AS ENUM ('PROCESSING', 'IN_TRANSIT', 'DELIVERED');
CREATE TYPE pool_status AS ENUM ('OPEN', 'FUNDED', 'EXPIRED');
CREATE TYPE membership_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE remittance_status AS ENUM ('PENDING', 'SETTLED');
CREATE TYPE price_tier AS ENUM ('RETAIL', 'WHOLESALE', 'GROUP');
CREATE DOMAIN currency_code AS text CHECK (VALUE ~ '^[A-Z]{3}$');

CREATE TABLE manufacturers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    country text NOT NULL,
    verified boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    name text NOT NULL,
    password_hash text NOT NULL,
    role user_role NOT NULL DEFAULT 'CONSUMER',
    manufacturer_id uuid REFERENCES manufacturers(id),
    freight_partner_id uuid,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (role <> 'MANUFACTURER' OR manufacturer_id IS NOT NULL),
    CHECK (role <> 'FREIGHT_PARTNER' OR freight_partner_id IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_lower ON users(lower(email));

CREATE TABLE freight_partners (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE REFERENCES users(id),
    name text NOT NULL,
    country text NOT NULL,
    verified boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id, user_id)
);
ALTER TABLE users ADD CONSTRAINT users_owned_freight_profile
    FOREIGN KEY (freight_partner_id, id) REFERENCES freight_partners(id, user_id) DEFERRABLE;

CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_by_expiry ON sessions(expires_at);
CREATE INDEX sessions_by_user ON sessions(user_id);

CREATE TABLE privacy_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    kind text NOT NULL CHECK (kind IN ('ERASURE', 'CORRECTION')),
    detail text NOT NULL,
    status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'CLOSED')),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX privacy_one_open_per_kind ON privacy_requests(user_id, kind) WHERE status = 'RECEIVED';

CREATE TABLE products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    manufacturer_id uuid NOT NULL REFERENCES manufacturers(id),
    sku varchar(100) NOT NULL UNIQUE,
    title varchar(255) NOT NULL,
    description text NOT NULL DEFAULT '',
    category text NOT NULL,
    image_url text NOT NULL DEFAULT '',
    unit_cost_cents bigint NOT NULL CHECK (unit_cost_cents BETWEEN 0 AND 100000000),
    retail_price_cents bigint NOT NULL CHECK (retail_price_cents BETWEEN 1 AND 100000000),
    wholesale_price_cents bigint NOT NULL CHECK (wholesale_price_cents BETWEEN 1 AND retail_price_cents),
    wholesale_min integer NOT NULL DEFAULT 5 CHECK (wholesale_min BETWEEN 2 AND 10000),
    group_price_cents bigint NOT NULL CHECK (group_price_cents BETWEEN 1 AND retail_price_cents),
    quantity_available bigint NOT NULL CHECK (quantity_available >= 0),
    rating numeric(2,1) NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
    featured boolean NOT NULL DEFAULT false,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id, manufacturer_id)
);
CREATE INDEX ix_products_manufacturer ON products(manufacturer_id);
CREATE INDEX ix_products_category ON products(category) WHERE active;

CREATE TABLE product_reorder_settings (
    product_id uuid PRIMARY KEY REFERENCES products(id),
    reorder_point integer NOT NULL CHECK (reorder_point BETWEEN 0 AND 100000000),
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE production_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL REFERENCES products(id),
    recorded_by uuid NOT NULL REFERENCES users(id),
    lot_code text NOT NULL,
    material_input text NOT NULL,
    quantity_produced integer NOT NULL CHECK (quantity_produced BETWEEN 1 AND 100000000),
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (product_id, lot_code)
);
CREATE INDEX ix_production_batches_product ON production_batches(product_id, created_at DESC);

CREATE TABLE pools (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL REFERENCES products(id),
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    target_quantity integer NOT NULL CHECK (target_quantity > 0),
    committed_quantity integer NOT NULL DEFAULT 0 CHECK (committed_quantity BETWEEN 0 AND target_quantity),
    status pool_status NOT NULL DEFAULT 'OPEN',
    ends_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((status = 'FUNDED') = (committed_quantity = target_quantity))
);
CREATE INDEX ix_pools_expiration ON pools(ends_at) WHERE status = 'OPEN';
CREATE UNIQUE INDEX ix_pools_open_product ON pools(product_id) WHERE status = 'OPEN';

CREATE TABLE affiliate_codes (
    code text PRIMARY KEY CHECK (length(code) BETWEEN 8 AND 24),
    referrer_id uuid NOT NULL UNIQUE REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    pool_id uuid REFERENCES pools(id),
    status order_status NOT NULL,
    currency currency_code NOT NULL DEFAULT 'USD',
    subtotal_cents bigint NOT NULL CHECK (subtotal_cents > 0),
    commission_bps integer NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
    commission_cents bigint NOT NULL CHECK (commission_cents BETWEEN 0 AND subtotal_cents),
    platform_cents bigint NOT NULL CHECK (platform_cents >= 0),
    cashback_cents bigint NOT NULL CHECK (cashback_cents >= 0),
    affiliate_cents bigint NOT NULL CHECK (affiliate_cents >= 0),
    community_cents bigint NOT NULL CHECK (community_cents >= 0),
    shipping_name text NOT NULL,
    shipping_address text NOT NULL,
    shipping_city text NOT NULL,
    shipping_postal_code text NOT NULL,
    shipping_country text NOT NULL,
    referral_code text REFERENCES affiliate_codes(code),
    idempotency_key text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, idempotency_key),
    CHECK (commission_cents = platform_cents + cashback_cents + affiliate_cents + community_cents),
    CHECK (status <> 'PENDING' OR pool_id IS NOT NULL)
);
CREATE INDEX ix_orders_user ON orders(user_id, created_at DESC, id);
CREATE INDEX ix_orders_pool ON orders(pool_id, status) WHERE pool_id IS NOT NULL;
CREATE INDEX ix_orders_referral ON orders(referral_code, status) WHERE referral_code IS NOT NULL;

CREATE TABLE order_items (
    order_id uuid NOT NULL REFERENCES orders(id),
    product_id uuid NOT NULL,
    manufacturer_id uuid NOT NULL,
    product_title text NOT NULL,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
    unit_price_cents bigint NOT NULL CHECK (unit_price_cents BETWEEN 1 AND 100000000),
    unit_cost_cents bigint NOT NULL CHECK (unit_cost_cents BETWEEN 0 AND 100000000),
    price_tier price_tier NOT NULL,
    subtotal_cents bigint GENERATED ALWAYS AS (quantity * unit_price_cents) STORED,
    PRIMARY KEY (order_id, product_id),
    FOREIGN KEY (product_id, manufacturer_id) REFERENCES products(id, manufacturer_id)
);
CREATE INDEX ix_order_items_manufacturer ON order_items(manufacturer_id, order_id);
CREATE INDEX ix_order_items_product ON order_items(product_id, order_id);

CREATE TABLE membership_applications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    applicant_id uuid NOT NULL REFERENCES users(id),
    requested_role user_role NOT NULL CHECK (requested_role <> 'ADMIN'),
    company_name text NOT NULL,
    country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    business_summary text NOT NULL,
    production_capacity integer CHECK (production_capacity > 0),
    quality_controls text NOT NULL DEFAULT '',
    compliance_reference text NOT NULL DEFAULT '',
    transport_regions text NOT NULL DEFAULT '',
    cold_chain boolean,
    warehousing text NOT NULL DEFAULT '',
    status membership_status NOT NULL DEFAULT 'PENDING',
    reviewer_id uuid REFERENCES users(id),
    review_note text NOT NULL DEFAULT '',
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((status = 'PENDING') = (reviewed_at IS NULL)),
    CHECK (status = 'PENDING' OR reviewer_id IS NOT NULL OR requested_role = 'CONSUMER')
);
CREATE UNIQUE INDEX ux_pending_membership_applicant ON membership_applications(applicant_id)
    WHERE status = 'PENDING';
CREATE UNIQUE INDEX ux_consumer_membership_applicant ON membership_applications(applicant_id)
    WHERE requested_role = 'CONSUMER' AND status = 'APPROVED';
CREATE INDEX ix_membership_applicant ON membership_applications(applicant_id, created_at DESC);

CREATE TABLE shipments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
    freight_partner_id uuid REFERENCES freight_partners(id),
    region_code text NOT NULL DEFAULT 'UNASSIGNED',
    carrier text NOT NULL,
    tracking_number text NOT NULL UNIQUE,
    status shipment_status NOT NULL,
    estimated_delivery date,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_shipments_partner ON shipments(freight_partner_id, updated_at DESC);

CREATE TABLE shipment_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid NOT NULL REFERENCES shipments(id),
    recorded_by uuid NOT NULL REFERENCES users(id),
    status shipment_status NOT NULL,
    location text NOT NULL DEFAULT '',
    note text NOT NULL DEFAULT '',
    occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_shipment_events_shipment ON shipment_events(shipment_id, occurred_at, id);

CREATE TABLE freight_remittances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid NOT NULL REFERENCES shipments(id),
    manufacturer_id uuid NOT NULL REFERENCES manufacturers(id),
    recorded_by uuid NOT NULL REFERENCES users(id),
    amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000),
    defect_allowance_cents bigint NOT NULL DEFAULT 0 CHECK (defect_allowance_cents BETWEEN 0 AND amount_cents),
    currency currency_code NOT NULL,
    status remittance_status NOT NULL DEFAULT 'PENDING',
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    settled_by uuid REFERENCES users(id),
    settled_at timestamptz,
    UNIQUE (shipment_id, manufacturer_id),
    CHECK (
        (status = 'SETTLED' AND settled_at IS NOT NULL AND settled_by IS NOT NULL)
        OR (status = 'PENDING' AND settled_at IS NULL AND settled_by IS NULL)
    )
);
CREATE INDEX ix_freight_remittance_manufacturer ON freight_remittances(manufacturer_id, status);

CREATE TABLE event_outbox (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    event_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at timestamptz
);
CREATE INDEX ix_pending_events ON event_outbox(sequence) WHERE published_at IS NULL;

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER product_reorder_settings_updated_at BEFORE UPDATE ON product_reorder_settings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER shipments_updated_at BEFORE UPDATE ON shipments
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE MATERIALIZED VIEW mv_shareholder_defect_baseline AS
WITH order_lines AS (
    SELECT oi.*, o.currency, o.commission_cents, o.subtotal_cents AS order_subtotal_cents,
        sum(oi.subtotal_cents) OVER (
            PARTITION BY oi.order_id ORDER BY oi.product_id ROWS UNBOUNDED PRECEDING
        ) AS cumulative_revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('PAID', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED')
),
sales AS (
    SELECT manufacturer_id, currency, count(DISTINCT order_id) AS total_orders,
        sum(quantity) AS units_sold, sum(subtotal_cents) AS gross_revenue_cents,
        sum(quantity * unit_cost_cents) AS cost_of_goods_cents,
        -- Cumulative differences reconcile to the exact order commission across manufacturers.
        sum(
            div(cumulative_revenue * commission_cents, order_subtotal_cents)
            - div((cumulative_revenue - subtotal_cents) * commission_cents, order_subtotal_cents)
        ) AS commission_cents
    FROM order_lines
    GROUP BY manufacturer_id, currency
),
freight AS (
    SELECT manufacturer_id, currency, sum(amount_cents) AS freight_amount_cents,
        sum(defect_allowance_cents) AS defect_allowance_cents
    FROM freight_remittances
    WHERE status = 'SETTLED'
    GROUP BY manufacturer_id, currency
),
totals AS (
    SELECT manufacturer_id, currency,
        coalesce(s.total_orders, 0) AS total_orders,
        coalesce(s.units_sold, 0) AS units_sold,
        coalesce(s.gross_revenue_cents, 0) AS gross_revenue_cents,
        coalesce(s.cost_of_goods_cents, 0) AS cost_of_goods_cents,
        coalesce(s.commission_cents, 0) AS commission_cents,
        coalesce(f.freight_amount_cents, 0) AS freight_amount_cents,
        coalesce(f.defect_allowance_cents, 0) AS defect_allowance_cents
    FROM sales s FULL JOIN freight f USING (manufacturer_id, currency)
),
spend AS (
    SELECT totals.*,
        freight_amount_cents - defect_allowance_cents AS net_freight_cents,
        cost_of_goods_cents + commission_cents + freight_amount_cents - defect_allowance_cents AS total_spend_cents
    FROM totals
)
SELECT s.manufacturer_id, m.name AS company_name, s.currency, s.total_orders, s.units_sold,
    s.gross_revenue_cents, s.cost_of_goods_cents, s.commission_cents,
    s.freight_amount_cents, s.defect_allowance_cents, s.net_freight_cents, s.total_spend_cents,
    s.gross_revenue_cents - s.total_spend_cents AS net_margin_cents,
    round(100 * (s.gross_revenue_cents - s.total_spend_cents) / nullif(s.gross_revenue_cents, 0), 2) AS margin_percent,
    round(100 * (s.gross_revenue_cents - s.total_spend_cents) / nullif(s.total_spend_cents, 0), 2) AS roi_percent
FROM spend s
JOIN manufacturers m ON m.id = s.manufacturer_id;

CREATE UNIQUE INDEX ux_shareholder_defect_baseline
    ON mv_shareholder_defect_baseline(manufacturer_id, currency);

CREATE MATERIALIZED VIEW mv_freight_remittances_by_region AS
SELECT s.freight_partner_id, s.region_code, r.currency,
    count(*) FILTER (WHERE r.status = 'PENDING') AS pending_count,
    count(*) FILTER (WHERE r.status = 'SETTLED') AS settled_count,
    coalesce(sum(r.amount_cents - r.defect_allowance_cents) FILTER (WHERE r.status = 'PENDING'), 0) AS pending_cents,
    coalesce(sum(r.amount_cents) FILTER (WHERE r.status = 'SETTLED'), 0) AS settled_gross_cents,
    coalesce(sum(r.defect_allowance_cents) FILTER (WHERE r.status = 'SETTLED'), 0) AS settled_defect_allowance_cents,
    coalesce(sum(r.amount_cents - r.defect_allowance_cents) FILTER (WHERE r.status = 'SETTLED'), 0) AS settled_net_cents
FROM freight_remittances r
JOIN shipments s ON s.id = r.shipment_id
WHERE s.freight_partner_id IS NOT NULL
GROUP BY s.freight_partner_id, s.region_code, r.currency;

CREATE UNIQUE INDEX ux_freight_remittances_by_region
    ON mv_freight_remittances_by_region(freight_partner_id, region_code, currency);
