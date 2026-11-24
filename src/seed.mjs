import { randomBytes } from 'node:crypto';
import { transaction } from './database.mjs';

const factories = [
  ['loom-form', 'Loom & Form', 'Vietnam'],
  ['kinetic-audio', 'Kinetic Audio Works', 'China'],
  ['kiln-and-clay', 'Kiln & Clay Studio', 'Thailand'],
  ['fieldwork-canvas', 'Fieldwork Canvas', 'Philippines']
];

const products = [
  ['linen-throw', 'loom-form', 'LF-100', 'Sapa Linen Throw', 'A textured linen throw with woven olive stripes, finished with a hand-twisted fringe. Made in Da Nang.', 'Home & Living', 'throw', 1800, 4400, 3600, 5, 3200, 82, 4.9],
  ['orbit-speaker', 'kinetic-audio', 'KA-210', 'Orbit Portable Speaker', 'A compact fabric-grille speaker with a carry loop, USB-C charging and Bluetooth connectivity. Assembled in Shenzhen.', 'Electronics', 'speaker', 2520, 6900, 5600, 5, 4900, 61, 4.8],
  ['ceramic-cups', 'kiln-and-clay', 'KC-300', 'Dune Ceramic Cup Set', 'Two hand-glazed stoneware cups and matching saucers. Fired in small batches in Chiang Mai.', 'Kitchen & Dining', 'cups', 1230, 3200, 2600, 6, 2400, 44, 4.9],
  ['canvas-pack', 'fieldwork-canvas', 'FC-410', 'Rover Canvas Daypack', 'A waxed canvas roll-top bag with a padded sleeve and adjustable straps. Cut and sewn in Cebu.', 'Bags & Travel', 'pack', 1950, 5800, 4800, 4, 4200, 47, 4.7]
];

export function seedDemo(db) {
  transaction(db, () => {
    db.prepare('CREATE TABLE IF NOT EXISTS demo_seed (version INTEGER PRIMARY KEY) STRICT').run();
    if (db.prepare('SELECT 1 FROM demo_seed WHERE version = 1').get()) return;
    const factory = db.prepare(`INSERT INTO manufacturers(id,name,country,verified)
      VALUES (?,?,?,1) ON CONFLICT(id) DO NOTHING`);
    for (const row of factories) factory.run(...row);
    const product = db.prepare(`INSERT INTO products(id,manufacturer_id,sku,title,description,category,image_url,
      unit_cost_cents,retail_price_cents,wholesale_price_cents,wholesale_min,group_price_cents,
      quantity_available,rating,featured,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1)
      ON CONFLICT(id) DO NOTHING`);
    for (const [id, manufacturer, sku, title, description, category, image, ...rest] of products) {
      product.run(id, manufacturer, sku, title, description, category, `/images/${image}.jpg`, ...rest);
    }
    const pool = db.prepare(`INSERT INTO pools(id,product_id,title,description,target_quantity,committed_quantity,ends_at)
      VALUES (?,?,?,?,?,0,?) ON CONFLICT(id) DO NOTHING`);
    const deadline = days => new Date(Date.now() + days * 86400000).toISOString();
    pool.run('linen-circle', 'linen-throw', 'Linen for the long weekend', 'Buy together to unlock the community price on the Sapa Linen Throw.', 12, deadline(6));
    pool.run('orbit-circle', 'orbit-speaker', 'Sounds like a good deal', 'Join the Orbit pool to save on a factory-direct portable speaker.', 18, deadline(9));
    pool.run('dune-circle', 'ceramic-cups', 'A better coffee break', 'Pool your order for a pair of cups from Kiln & Clay Studio.', 10, deadline(12));

    const user = db.prepare(`INSERT INTO users(id,email,name,password_hash,role,manufacturer_id,freight_partner_id)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
    const demoPassword = () => `${randomBytes(16).toString('hex')}:${randomBytes(64).toString('hex')}`;
    user.run('demo-consumer', 'shopper@demo.invalid', 'Demo Shopper', demoPassword(), 'CONSUMER', null, null);
    user.run('demo-manufacturer', 'seller@demo.invalid', 'Loom & Form', demoPassword(), 'MANUFACTURER', 'loom-form', null);
    user.run('demo-freight', 'freight@demo.invalid', 'Demo Freight', demoPassword(), 'FREIGHT_PARTNER', null, 'demo-carrier');
    user.run('demo-admin', 'admin@demo.invalid', 'Demo Administrator', demoPassword(), 'ADMIN', null, null);
    db.prepare('INSERT INTO demo_seed(version) VALUES (1)').run();
  });
}
