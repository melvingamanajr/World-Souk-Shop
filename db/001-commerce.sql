CREATE TABLE IF NOT EXISTS manufacturers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    manufacturer_id TEXT NOT NULL REFERENCES manufacturers(id),
    sku TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    image_url TEXT NOT NULL DEFAULT '',
    unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents BETWEEN 0 AND 100000000),
    retail_price_cents INTEGER NOT NULL CHECK (retail_price_cents BETWEEN 1 AND 100000000),
    wholesale_price_cents INTEGER NOT NULL CHECK (wholesale_price_cents BETWEEN 1 AND retail_price_cents),
    wholesale_min INTEGER NOT NULL DEFAULT 5 CHECK (wholesale_min BETWEEN 2 AND 10000),
    group_price_cents INTEGER NOT NULL CHECK (group_price_cents BETWEEN 1 AND retail_price_cents),
    quantity_available INTEGER NOT NULL CHECK (quantity_available >= 0),
    rating REAL NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
    featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX IF NOT EXISTS ix_products_manufacturer ON products(manufacturer_id);
CREATE INDEX IF NOT EXISTS ix_products_category ON products(active, category);

CREATE TABLE IF NOT EXISTS pools (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    target_quantity INTEGER NOT NULL CHECK (target_quantity > 0),
    committed_quantity INTEGER NOT NULL DEFAULT 0 CHECK (committed_quantity BETWEEN 0 AND target_quantity),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FUNDED', 'EXPIRED')),
    ends_at TEXT NOT NULL CHECK (julianday(ends_at) IS NOT NULL),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX IF NOT EXISTS ix_pools_expiration ON pools(status, ends_at);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    pool_id TEXT REFERENCES pools(id),
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED')),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
    subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents > 0),
    commission_bps INTEGER NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
    commission_cents INTEGER NOT NULL CHECK (commission_cents BETWEEN 0 AND subtotal_cents),
    platform_cents INTEGER NOT NULL CHECK (platform_cents >= 0),
    cashback_cents INTEGER NOT NULL CHECK (cashback_cents >= 0),
    affiliate_cents INTEGER NOT NULL CHECK (affiliate_cents >= 0),
    community_cents INTEGER NOT NULL CHECK (community_cents >= 0),
    shipping_name TEXT NOT NULL,
    shipping_address TEXT NOT NULL,
    shipping_city TEXT NOT NULL,
    shipping_postal_code TEXT NOT NULL,
    shipping_country TEXT NOT NULL,
    referral_code TEXT,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (commission_cents = platform_cents + cashback_cents + affiliate_cents + community_cents),
    CHECK (status <> 'PENDING' OR pool_id IS NOT NULL),
    UNIQUE (user_id, idempotency_key)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_orders_pool ON orders(pool_id, status);

CREATE TABLE IF NOT EXISTS order_items (
    order_id TEXT NOT NULL REFERENCES orders(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    manufacturer_id TEXT NOT NULL REFERENCES manufacturers(id),
    product_title TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
    unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
    price_tier TEXT NOT NULL CHECK (price_tier IN ('RETAIL', 'WHOLESALE', 'GROUP')),
    subtotal_cents INTEGER GENERATED ALWAYS AS (quantity * unit_price_cents) STORED,
    PRIMARY KEY (order_id, product_id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_order_items_manufacturer ON order_items(manufacturer_id, order_id);
CREATE INDEX IF NOT EXISTS ix_order_items_product ON order_items(product_id, order_id);

CREATE TABLE IF NOT EXISTS shipments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
    freight_partner_id TEXT REFERENCES freight_partners(id),
    region_code TEXT NOT NULL DEFAULT 'UNASSIGNED',
    carrier TEXT NOT NULL,
    tracking_number TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'IN_TRANSIT', 'DELIVERED')),
    estimated_delivery TEXT,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS event_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    occurred_at TEXT NOT NULL,
    published_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS ix_pending_events ON event_outbox(sequence) WHERE published_at IS NULL;
