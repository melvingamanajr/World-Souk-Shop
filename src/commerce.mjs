import { createHash, randomUUID } from 'node:crypto'
import { transaction } from './database.mjs'
import { HttpError } from './http-error.mjs'

export { transaction } from './database.mjs'

const ISO_NOW = () => new Date().toISOString()
const PRICES = {
  featured: 'p.featured DESC, p.rowid',
  'price-low': 'p.retail_price_cents ASC, p.rowid',
  'price-asc': 'p.retail_price_cents ASC, p.rowid',
  'price-high': 'p.retail_price_cents DESC, p.rowid',
  'price-desc': 'p.retail_price_cents DESC, p.rowid',
  rating: 'p.rating DESC, p.rowid',
  name: 'p.title COLLATE NOCASE ASC, p.rowid',
}
const PRODUCT_SELECT = `
  SELECT p.*, m.name AS manufacturer_name, m.country, m.verified
  FROM products AS p
  JOIN manufacturers AS m ON p.manufacturer_id = m.id
`
const POOL_SELECT = `
  SELECT po.*, p.group_price_cents, p.quantity_available, p.image_url,
         m.name AS manufacturer_name, m.country
  FROM pools AS po
  JOIN products AS p ON po.product_id = p.id
  JOIN manufacturers AS m ON p.manufacturer_id = m.id
  WHERE p.active = 1 AND m.verified = 1
`

export function recordEvent(db, type, aggregateId, payload, occurredAt = ISO_NOW()) {
  db.prepare(`
    INSERT INTO event_outbox (id, event_type, aggregate_id, payload, occurred_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), type, aggregateId, JSON.stringify(payload), occurredAt)
}

export function allocateCommission(subtotalCents, commissionBps = 800) {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0) {
    throw new RangeError('Subtotal must be a nonnegative integer in cents.')
  }
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10000) {
    throw new RangeError('Commission must be between 0 and 10000 basis points.')
  }
  const commission = (BigInt(subtotalCents) * BigInt(commissionBps) + 5000n) / 10000n
  const shares = [
    { key: 'platformCents', weight: 50n },
    { key: 'cashbackCents', weight: 30n },
    { key: 'affiliateCents', weight: 10n },
    { key: 'communityCents', weight: 10n },
  ].map(({ key, weight }) => ({
    key,
    amount: commission * weight / 100n,
    remainder: commission * weight % 100n,
  }))
  let centsLeft = commission - shares.reduce((sum, share) => sum + share.amount, 0n)
  // Rank fractional remainders, with ties in the order listed in the proposal.
  shares.sort((left, right) => Number(right.remainder - left.remainder))
  for (const share of shares) {
    if (centsLeft === 0n) break
    share.amount += 1n
    centsLeft -= 1n
  }
  return {
    commissionCents: Number(commission),
    ...Object.fromEntries(shares.map(({ key, amount }) => [key, Number(amount)])),
  }
}

function toProduct(p) {
  return {
    id: p.id,
    sku: p.sku,
    title: p.title,
    description: p.description,
    category: p.category,
    manufacturerId: p.manufacturer_id,
    manufacturer: p.manufacturer_name,
    country: p.country,
    image: p.image_url,
    priceCents: p.retail_price_cents,
    wholesaleCents: p.wholesale_price_cents,
    wholesaleMin: p.wholesale_min,
    groupCents: p.group_price_cents,
    stock: p.quantity_available,
    rating: p.rating,
    verified: Boolean(p.verified),
    featured: Boolean(p.featured),
  }
}

function toPool(p) {
  return {
    id: p.id,
    productId: p.product_id,
    title: p.title,
    description: p.description,
    priceCents: p.group_price_cents,
    target: p.target_quantity,
    current: p.committed_quantity,
    status: p.status,
    endsAt: p.ends_at,
    stock: p.quantity_available,
    image: p.image_url,
    manufacturer: p.manufacturer_name,
    country: p.country,
  }
}

function toItem(item) {
  return {
    productId: item.product_id,
    manufacturerId: item.manufacturer_id,
    title: item.product_title,
    quantity: item.quantity,
    unitPriceCents: item.unit_price_cents,
    priceTier: item.price_tier,
    subtotalCents: item.subtotal_cents,
  }
}

function toShipment(shipment) {
  if (!shipment) return null
  return {
    id: shipment.id,
    freightPartnerId: shipment.freight_partner_id,
    regionCode: shipment.region_code,
    carrier: shipment.carrier,
    trackingNumber: shipment.tracking_number,
    status: shipment.status,
    estimatedDelivery: shipment.estimated_delivery,
    updatedAt: shipment.updated_at,
  }
}

function requiredText(value, label, limit) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > limit || /[\x00-\x1f\x7f]/u.test(normalized)) {
    throw new HttpError(400, `${label} must have 1 to ${limit} characters.`, 'INVALID_CHECKOUT')
  }
  return normalized
}

function normalizeCheckout(body) {
  if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 50) {
    throw new HttpError(400, 'Choose between 1 and 50 products.', 'INVALID_CART')
  }
  const lines = new Map()
  for (const item of body.items) {
    const productId = requiredText(item?.productId, 'Product ID', 128)
    const poolId = item.poolId == null ? null : requiredText(item.poolId, 'Pool ID', 128)
    const quantity = item.quantity
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
      throw new HttpError(400, 'Each quantity must be between 1 and 10000.', 'INVALID_CART')
    }
    const previous = lines.get(productId)
    if (previous) {
      if (previous.poolId !== poolId || previous.quantity + quantity > 10000) {
        throw new HttpError(400, 'Choose a single price tier and up to 10000 units per product.', 'INVALID_CART')
      }
      previous.quantity += quantity
    } else {
      lines.set(productId, { productId, quantity, poolId })
    }
  }
  const items = [...lines.values()].sort((a, b) => a.productId.localeCompare(b.productId))
  if (items.length > 1 && items.some(item => item.poolId)) {
    throw new HttpError(400, 'Community pool orders require a separate checkout.', 'INVALID_CART')
  }
  const shipping = {
    name: requiredText(body.shipping?.name, 'Name', 120),
    address: requiredText(body.shipping?.address, 'Address', 200),
    city: requiredText(body.shipping?.city, 'City', 100),
    postalCode: requiredText(body.shipping?.postalCode, 'Postal code', 30),
    country: requiredText(body.shipping?.country, 'Country', 100),
  }
  const referralCode = body.referralCode
    ? requiredText(body.referralCode, 'Referral code', 80).toUpperCase()
    : null
  const idempotencyKey = requiredText(body.idempotencyKey, 'Checkout reference', 128)
  const requestHash = createHash('sha256').update(JSON.stringify({ items, shipping, referralCode })).digest('hex')
  return { items, shipping, referralCode, idempotencyKey, requestHash }
}

export function createCommerce(db, { commissionBps = 800 } = {}) {
  allocateCommission(0, commissionBps)

  function expirePools(now = ISO_NOW()) {
    const expired = db.prepare(`
      SELECT id FROM pools WHERE status = 'OPEN' AND julianday(ends_at) <= julianday(?)
    `)
    if (!expired.get(now)) return 0
    return transaction(db, () => {
      const overdue = expired.all(now)
      for (const { id } of overdue) {
        const orders = db.prepare("SELECT id FROM orders WHERE pool_id = ? AND status = 'PENDING'").all(id)
        let restoredQuantity = 0
        for (const order of orders) {
          const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(order.id)
          for (const item of items) {
            db.prepare('UPDATE products SET quantity_available = quantity_available + ? WHERE id = ?')
              .run(item.quantity, item.product_id)
            restoredQuantity += item.quantity
          }
          db.prepare("UPDATE orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now, order.id)
          recordEvent(db, 'order.cancelled', order.id, { orderId: order.id, reason: 'POOL_EXPIRED' }, now)
        }
        db.prepare("UPDATE pools SET status = 'EXPIRED', committed_quantity = committed_quantity - ? WHERE id = ?")
          .run(restoredQuantity, id)
        recordEvent(db, 'pool.expired', id, { poolId: id, cancelledOrders: orders.length }, now)
      }
      return overdue.length
    })
  }

  function hydrateOrder(row) {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY product_title').all(row.id)
    const shipment = db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(row.id)
    return {
      id: row.id,
      status: row.status,
      poolId: row.pool_id,
      currency: row.currency,
      subtotalCents: row.subtotal_cents,
      commissionBps: row.commission_bps,
      commissionCents: row.commission_cents,
      platformCents: row.platform_cents,
      cashbackCents: row.cashback_cents,
      affiliateCents: row.affiliate_cents,
      communityCents: row.community_cents,
      shipping: {
        name: row.shipping_name,
        address: row.shipping_address,
        city: row.shipping_city,
        postalCode: row.shipping_postal_code,
        country: row.shipping_country,
      },
      items: items.map(toItem),
      shipment: toShipment(shipment),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  function order(userId, id) {
    expirePools()
    const row = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, userId)
    if (!row) throw new HttpError(404, 'Order not found.', 'ORDER_NOT_FOUND')
    return hydrateOrder(row)
  }

  function checkout(userId, body) {
    const request = normalizeCheckout(body)
    const now = ISO_NOW()
    expirePools(now)
    return transaction(db, () => {
      const existing = db.prepare('SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?')
        .get(userId, request.idempotencyKey)
      if (existing) {
        if (existing.request_hash !== request.requestHash) {
          throw new HttpError(409, 'This checkout reference already belongs to another cart.', 'CHECKOUT_CONFLICT')
        }
        return hydrateOrder(existing)
      }

      if (request.referralCode) {
        const referrer = db.prepare('SELECT referrer_id AS id FROM affiliate_codes WHERE code = ?').get(request.referralCode)
        if (!referrer || referrer.id === userId) {
          throw new HttpError(422, 'Enter a referral code from another account.', 'INVALID_REFERRAL')
        }
      }

      const poolId = request.items[0].poolId
      const pool = poolId ? db.prepare('SELECT * FROM pools WHERE id = ?').get(poolId) : null
      if (poolId && (!pool || pool.product_id !== request.items[0].productId)) {
        throw new HttpError(404, 'Community pool not found.', 'POOL_NOT_FOUND')
      }
      if (pool && (pool.status !== 'OPEN' || Date.parse(pool.ends_at) <= Date.now())) {
        throw new HttpError(409, 'This community pool has closed.', 'POOL_CLOSED')
      }
      if (pool && request.items[0].quantity > pool.target_quantity - pool.committed_quantity) {
        throw new HttpError(409, 'Choose fewer units to match the remaining pool target.', 'POOL_CAPACITY')
      }
      const getProduct = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ? AND p.active = 1 AND m.verified = 1`)
      const reserve = db.prepare(`
        UPDATE products SET quantity_available = quantity_available - ?
        WHERE id = ? AND quantity_available >= ?
      `)
      const lines = request.items.map(item => {
        const product = getProduct.get(item.productId)
        if (!product) throw new HttpError(404, 'A product in your cart is unavailable.', 'PRODUCT_NOT_FOUND')
        const reserved = reserve.run(item.quantity, product.id, item.quantity)
        if (reserved.changes !== 1) {
          throw new HttpError(409, `Only ${product.quantity_available} units of ${product.title} are available.`, 'OUT_OF_STOCK')
        }
        let priceTier = 'RETAIL'
        let unitPriceCents = product.retail_price_cents
        if (pool) {
          priceTier = 'GROUP'
          unitPriceCents = product.group_price_cents
        } else if (item.quantity >= product.wholesale_min) {
          priceTier = 'WHOLESALE'
          unitPriceCents = product.wholesale_price_cents
        }
        recordEvent(db, 'inventory.reserved', product.id, { productId: product.id, quantity: item.quantity }, now)
        return { product, quantity: item.quantity, unitPriceCents, priceTier }
      })
      const subtotalCents = lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0)
      const allocation = allocateCommission(subtotalCents, commissionBps)
      const id = randomUUID()
      const status = pool ? 'PENDING' : 'PAID'
      db.prepare(`
        INSERT INTO orders (
          id, user_id, pool_id, status, subtotal_cents, commission_bps, commission_cents,
          platform_cents, cashback_cents, affiliate_cents, community_cents, shipping_name,
          shipping_address, shipping_city, shipping_postal_code, shipping_country, referral_code,
          idempotency_key, request_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, userId, poolId, status, subtotalCents, commissionBps, allocation.commissionCents,
        allocation.platformCents, allocation.cashbackCents, allocation.affiliateCents, allocation.communityCents,
        request.shipping.name, request.shipping.address, request.shipping.city, request.shipping.postalCode,
        request.shipping.country, request.referralCode, request.idempotencyKey, request.requestHash, now, now)
      const addLine = db.prepare(`
        INSERT INTO order_items (
          order_id, product_id, manufacturer_id, product_title, quantity,
          unit_price_cents, unit_cost_cents, price_tier
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const { product, quantity, unitPriceCents, priceTier } of lines) {
        addLine.run(id, product.id, product.manufacturer_id, product.title, quantity,
          unitPriceCents, product.unit_cost_cents, priceTier)
      }
      recordEvent(db, 'order.created', id, { orderId: id, status, poolId }, now)
      if (pool) {
        const current = pool.committed_quantity + lines[0].quantity
        const funded = current === pool.target_quantity
        db.prepare('UPDATE pools SET committed_quantity = ?, status = ? WHERE id = ?')
          .run(current, funded ? 'FUNDED' : 'OPEN', poolId)
        recordEvent(db, 'pool.joined', poolId, { poolId, quantity: lines[0].quantity, current }, now)
        if (funded) {
          const pending = db.prepare("SELECT id FROM orders WHERE pool_id = ? AND status = 'PENDING'").all(poolId)
          db.prepare("UPDATE orders SET status = 'PAID', updated_at = ? WHERE pool_id = ? AND status = 'PENDING'")
            .run(now, poolId)
          recordEvent(db, 'pool.funded', poolId, { poolId, current }, now)
          for (const { id: pendingId } of pending) {
            recordEvent(db, 'order.paid', pendingId, { orderId: pendingId }, now)
          }
        }
      } else {
        recordEvent(db, 'order.paid', id, { orderId: id }, now)
      }
      return hydrateOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id))
    })
  }

  function catalog({ q, category, sort } = {}) {
    expirePools()
    const where = ['p.active = 1', 'm.verified = 1']
    const params = []
    if (typeof q === 'string' && q.trim()) {
      const pattern = `%${q.trim().slice(0, 120).replace(/[\\%_]/g, '\\$&')}%`
      where.push(`(p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\'
        OR p.sku LIKE ? ESCAPE '\\' OR p.category LIKE ? ESCAPE '\\'
        OR m.name LIKE ? ESCAPE '\\' OR m.country LIKE ? ESCAPE '\\')`)
      params.push(pattern, pattern, pattern, pattern, pattern, pattern)
    }
    if (typeof category === 'string' && category.trim() && category.trim().toLowerCase() !== 'all') {
      where.push('p.category = ? COLLATE NOCASE')
      params.push(category.trim())
    }
    const orderBy = Object.hasOwn(PRICES, sort) ? PRICES[sort] : PRICES.featured
    return db.prepare(`${PRODUCT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`).all(...params).map(toProduct)
  }

  function product(id) {
    expirePools()
    const row = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ? AND p.active = 1 AND m.verified = 1`).get(id)
    if (!row) throw new HttpError(404, 'Product not found.', 'PRODUCT_NOT_FOUND')
    return toProduct(row)
  }

  function pools() {
    expirePools()
    return db.prepare(`${POOL_SELECT} ORDER BY CASE po.status WHEN 'OPEN' THEN 1 WHEN 'FUNDED' THEN 2 ELSE 3 END, po.ends_at`)
      .all().map(toPool)
  }

  function createPool(actor, body) {
    const productId = requiredText(body.productId, 'Product ID', 128)
    const title = requiredText(body.title, 'Pool title', 120)
    const description = requiredText(body.description, 'Pool description', 600)
    const target = body.targetQuantity
    if (!Number.isInteger(target) || target < 2 || target > 10000) {
      throw new HttpError(422, 'Set a pool target between 2 and 10000 units.')
    }
    const endsAt = new Date(body.endsAt)
    const now = Date.now()
    if (!Number.isFinite(endsAt.valueOf()) || endsAt.valueOf() <= now || endsAt.valueOf() > now + 90 * 86400000) {
      throw new HttpError(422, 'Choose a close date within the next 90 days.')
    }
    expirePools()
    return transaction(db, () => {
      const product = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ? AND p.active = 1 AND m.verified = 1 AND m.id = ?`)
        .get(productId, actor.manufacturerId)
      if (!product || actor.role !== 'MANUFACTURER') throw new HttpError(404, 'Product not found.')
      if (product.quantity_available < target) throw new HttpError(409, 'The pool target exceeds available stock.')
      if (product.group_price_cents >= product.retail_price_cents) throw new HttpError(422, 'Set a group price below the retail price first.')
      if (db.prepare("SELECT 1 FROM pools WHERE product_id = ? AND status = 'OPEN'").get(productId)) {
        throw new HttpError(409, 'An open pool already exists for this product.')
      }
      const id = randomUUID()
      db.prepare('INSERT INTO pools(id,product_id,title,description,target_quantity,ends_at) VALUES (?,?,?,?,?,?)')
        .run(id, productId, title, description, target, endsAt.toISOString())
      recordEvent(db, 'pool.created', id, { poolId: id, productId, target })
      return toPool(db.prepare(`${POOL_SELECT} AND po.id = ?`).get(id))
    })
  }

  function orders(userId) {
    expirePools()
    return db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(userId).map(hydrateOrder)
  }

  function wallet(userId) {
    expirePools()
    const entries = db.prepare(`
      SELECT id AS orderId, cashback_cents AS amountCents, status, created_at AS createdAt
      FROM orders WHERE user_id = ? AND cashback_cents > 0 ORDER BY created_at DESC, rowid DESC
    `).all(userId).map(row => ({
      ...row,
      status: row.status === 'PENDING' ? 'PENDING' : row.status === 'CANCELLED' ? 'VOID' : 'AVAILABLE',
    }))
    return {
      currency: 'USD',
      availableCents: entries.filter(row => row.status === 'AVAILABLE').reduce((sum, row) => sum + row.amountCents, 0),
      pendingCents: entries.filter(row => row.status === 'PENDING').reduce((sum, row) => sum + row.amountCents, 0),
      entries,
    }
  }

  function categories() {
    return db.prepare(`SELECT DISTINCT p.category FROM products p
      JOIN manufacturers m ON m.id = p.manufacturer_id WHERE p.active = 1 AND m.verified = 1
      ORDER BY p.category`).all().map(row => row.category)
  }

  return { catalog, categories, product, pools, createPool, checkout, orders, order, wallet, expirePools }
}
