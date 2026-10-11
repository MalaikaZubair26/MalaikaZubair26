require('dotenv').config();
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const DB_NAME = process.env.PGDATABASE || 'donerkebabtacos';
const usingCloudDb = !!process.env.DATABASE_URL || (process.env.PGHOST || '').includes('neon.tech');

const baseConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT, 10) || 5432,
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || '',
      ssl: usingCloudDb ? { rejectUnauthorized: false } : undefined,
    };

async function ensureDatabaseExists() {
  // Neon (and most managed cloud Postgres) gives you one database per
  // connection string / project and doesn't allow CREATE DATABASE the way a
  // local install does — the database already exists, so just skip this step.
  if (usingCloudDb) {
    console.log('Using a cloud Postgres database (Neon) — skipping local database creation.');
    return;
  }
  const client = new Client({ ...baseConfig, database: 'postgres' });
  await client.connect();
  const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
  if (res.rowCount === 0) {
    console.log(`Creating database "${DB_NAME}"...`);
    await client.query(`CREATE DATABASE ${DB_NAME}`);
  } else {
    console.log(`Database "${DB_NAME}" already exists. Skipping creation.`);
  }
  await client.end();
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(30) UNIQUE NOT NULL,
  name VARCHAR(100),
  saved_address TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name_es VARCHAR(100) NOT NULL,
  name_en VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  display_order INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  category_id INT REFERENCES categories(id) ON DELETE SET NULL,
  name_es VARCHAR(150) NOT NULL,
  name_en VARCHAR(150) NOT NULL,
  description_es TEXT,
  description_en TEXT,
  price NUMERIC(8,2) NOT NULL,
  image_url TEXT,
  is_available BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS option_groups (
  id SERIAL PRIMARY KEY,
  product_id INT REFERENCES products(id) ON DELETE CASCADE,
  name_es VARCHAR(100),
  name_en VARCHAR(100),
  required BOOLEAN DEFAULT false,
  max_selection INT DEFAULT 1
);

CREATE TABLE IF NOT EXISTS options (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES option_groups(id) ON DELETE CASCADE,
  name_es VARCHAR(100),
  name_en VARCHAR(100),
  price_modifier NUMERIC(8,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id),
  customer_name VARCHAR(100),
  customer_phone VARCHAR(30),
  delivery_address TEXT,
  fulfillment_type VARCHAR(20) CHECK (fulfillment_type IN ('delivery','takeaway','dine_in')) DEFAULT 'takeaway',
  kiosk_or_table_id VARCHAR(50),
  payment_method VARCHAR(20) CHECK (payment_method IN ('card','cash')) DEFAULT 'cash',
  delivery_fee NUMERIC(8,2) DEFAULT 0,
  subtotal NUMERIC(8,2) NOT NULL,
  tax_amount NUMERIC(8,2) NOT NULL,
  grand_total NUMERIC(8,2) NOT NULL,
  status VARCHAR(20) CHECK (status IN ('pending','preparing','ready','completed')) DEFAULT 'pending',
  gdpr_consent BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id),
  quantity INT NOT NULL DEFAULT 1,
  selected_options JSONB DEFAULT '[]',
  item_price NUMERIC(8,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_settings (
  key VARCHAR(50) PRIMARY KEY,
  value TEXT
);

-- === Added: image uploads, sidebar control, sizes/extras ===
ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

ALTER TABLE option_groups ADD COLUMN IF NOT EXISTS group_type VARCHAR(20) DEFAULT 'extra';
ALTER TABLE option_groups ADD COLUMN IF NOT EXISTS subtitle_es VARCHAR(150);
ALTER TABLE option_groups ADD COLUMN IF NOT EXISTS subtitle_en VARCHAR(150);
ALTER TABLE option_groups ADD COLUMN IF NOT EXISTS min_selection INT DEFAULT 0;

ALTER TABLE options ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT true;

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_trending BOOLEAN DEFAULT false;

-- Payment is collected in person (cash or the rider's/counter's card POS), not online,
-- so 'cash_counter' is renamed to plain 'cash' to cover both pickup and delivery.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
UPDATE orders SET payment_method = 'cash' WHERE payment_method = 'cash_counter';
ALTER TABLE orders ALTER COLUMN payment_method SET DEFAULT 'cash';
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('card','cash'));
`;

const CATEGORY_SEED = [
  ['Panadería', 'Bakery', 'bakery', 1],
  ['Hamburguesas', 'Burger', 'burger', 2],
  ['Bebidas', 'Beverages', 'beverages', 3],
  ['Tacos', 'Tacos', 'tacos', 4],
  ['Kebab', 'Kebab', 'kebab', 5],
];

async function seedIfEmpty(client) {
  const catCount = await client.query('SELECT COUNT(*) FROM categories');
  let categoryIds = {};

  if (parseInt(catCount.rows[0].count, 10) === 0) {
    console.log('Seeding categories...');
    for (const [name_es, name_en, slug, order] of CATEGORY_SEED) {
      const r = await client.query(
        'INSERT INTO categories (name_es, name_en, slug, display_order) VALUES ($1,$2,$3,$4) RETURNING id, slug',
        [name_es, name_en, slug, order]
      );
      categoryIds[slug] = r.rows[0].id;
    }
  } else {
    console.log('Categories already exist. Skipping category seed.');
    const r = await client.query('SELECT id, slug FROM categories');
    r.rows.forEach((row) => (categoryIds[row.slug] = row.id));
  }

  const prodCount = await client.query('SELECT COUNT(*) FROM products');
  if (parseInt(prodCount.rows[0].count, 10) === 0) {
    console.log('Seeding products (Spanish menu)...');
    const PRODUCTS = [
      ['kebab', 'Kebab de Pollo', 'Chicken Kebab', 'Pan de pita, pollo a la parrilla, salsa de yogur y vegetales frescos.', 'Pita bread, grilled chicken, yogurt sauce and fresh vegetables.', 8.50, 'https://images.unsplash.com/photo-1633321702518-7feccafb94d5?w=600'],
      ['kebab', 'Kebab de Ternera', 'Beef Kebab', 'Pan de pita, ternera especiada, salsa picante y ensalada.', 'Pita bread, spiced beef, spicy sauce and salad.', 9.50, 'https://images.unsplash.com/photo-1529006557810-274b9b2fc783?w=600'],
      ['kebab', 'Plato de Kebab Mixto', 'Mixed Kebab Plate', 'Pollo y ternera con arroz, patatas y ensalada.', 'Chicken and beef with rice, fries and salad.', 12.90, 'https://images.unsplash.com/photo-1529193591184-b1d58069ecdd?w=600'],
      ['tacos', 'Tacos al Pastor', 'Al Pastor Tacos', 'Tres tacos de cerdo marinado con piña y cilantro.', 'Three marinated pork tacos with pineapple and cilantro.', 7.90, 'https://images.unsplash.com/photo-1552332386-f8dd00dc2f85?w=600'],
      ['tacos', 'Tacos de Pollo', 'Chicken Tacos', 'Tres tacos de pollo a la parrilla con salsa verde.', 'Three grilled chicken tacos with green salsa.', 7.50, 'https://images.unsplash.com/photo-1551504734-5ee1c4a1479b?w=600'],
      ['burger', 'Hamburguesa Clásica', 'Classic Burger', 'Carne de res, queso cheddar, lechuga, tomate y salsa especial.', 'Beef patty, cheddar cheese, lettuce, tomato and special sauce.', 8.90, 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600'],
      ['burger', 'Hamburguesa Doble', 'Double Burger', 'Doble carne, doble queso, panceta crujiente.', 'Double patty, double cheese, crispy bacon.', 10.90, 'https://images.unsplash.com/photo-1553979459-d2229ba7433b?w=600'],
      ['bakery', 'Baklava', 'Baklava', 'Pastel de hojaldre con nueces y miel.', 'Filo pastry with nuts and honey.', 3.50, 'https://images.unsplash.com/photo-1519676867240-f03562e64548?w=600'],
      ['bakery', 'Pan Pita Casero', 'Homemade Pita Bread', 'Pan pita recién horneado.', 'Freshly baked pita bread.', 2.00, 'https://images.unsplash.com/photo-1620921575034-78c50c66f6d8?w=600'],
      ['beverages', 'Refresco', 'Soft Drink', 'Lata de 330ml, varios sabores.', '330ml can, assorted flavors.', 1.80, 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=600'],
      ['beverages', 'Ayran', 'Ayran Yogurt Drink', 'Bebida tradicional de yogur turco.', 'Traditional Turkish yogurt drink.', 2.50, 'https://images.unsplash.com/photo-1571212515416-fca325e6f7d7?w=600'],
      ['beverages', 'Agua Mineral', 'Mineral Water', 'Botella de 500ml.', '500ml bottle.', 1.20, 'https://images.unsplash.com/photo-1560023907-5f339617ea30?w=600'],
    ];
    const insertedIds = {};
    for (const p of PRODUCTS) {
      const [slug, nEs, nEn, dEs, dEn, price, img] = p;
      const r = await client.query(
        `INSERT INTO products (category_id, name_es, name_en, description_es, description_en, price, image_url, is_available)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id`,
        [categoryIds[slug], nEs, nEn, dEs, dEn, price, img]
      );
      insertedIds[nEs] = r.rows[0].id;
    }

    console.log('Seeding sample customization options...');
    const sauceGroup = await client.query(
      `INSERT INTO option_groups (product_id, name_es, name_en, required, max_selection)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [insertedIds['Kebab de Pollo'], 'Elige tu salsa', 'Choose your sauce', true, 1]
    );
    const sauceGroupId = sauceGroup.rows[0].id;
    const sauces = [
      ['Salsa de Yogur', 'Yogurt Sauce', 0],
      ['Salsa Picante', 'Spicy Sauce', 0],
      ['Salsa de Ajo', 'Garlic Sauce', 0.30],
    ];
    for (const [es, en, mod] of sauces) {
      await client.query('INSERT INTO options (group_id, name_es, name_en, price_modifier) VALUES ($1,$2,$3,$4)', [sauceGroupId, es, en, mod]);
    }

    const extrasGroup = await client.query(
      `INSERT INTO option_groups (product_id, name_es, name_en, required, max_selection)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [insertedIds['Tacos al Pastor'], 'Extras', 'Extras', false, 3]
    );
    const extrasGroupId = extrasGroup.rows[0].id;
    const extras = [
      ['Extra Queso', 'Extra Cheese', 0.80],
      ['Extra Guacamole', 'Extra Guacamole', 1.00],
      ['Extra Cilantro', 'Extra Cilantro', 0.20],
    ];
    for (const [es, en, mod] of extras) {
      await client.query('INSERT INTO options (group_id, name_es, name_en, price_modifier) VALUES ($1,$2,$3,$4)', [extrasGroupId, es, en, mod]);
    }
  } else {
    console.log('Products already exist. Skipping product seed (admin edits are preserved).');
  }

  const adminCount = await client.query('SELECT COUNT(*) FROM admin_users');
  if (parseInt(adminCount.rows[0].count, 10) === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(password, 10);
    await client.query('INSERT INTO admin_users (username, password_hash) VALUES ($1,$2)', [username, hash]);
    console.log(`Created admin user "${username}" (password from .env).`);
  } else {
    console.log('Admin user already exists. Skipping.');
  }

  console.log('Seeding/updating store settings defaults (existing values are preserved)...');
  const STORE_SETTINGS_DEFAULTS = {
    store_name: 'DONER KEBAB Y TACOS',
    tagline: 'AUTÉNTICO KEBAB EN DOS HERMANAS',
    phone_1: '618 865 208',
    phone_2: '660 269 141',
    address: 'C/ ANTONIO ROS MARBÀ 2 LOCAL, 41701 DOS HERMANAS (SEVILLA)',
    delivery_fee: '2.00',
    min_order: '10.00',
    description: 'Doner Kebab y Tacos',
    hours_summer: '13:00 - 16:30 y 20:00 - 00:30',
    hours_winter: '13:00 - 16:30 y 19:00 - 00:00',
  };
  for (const [key, value] of Object.entries(STORE_SETTINGS_DEFAULTS)) {
    await client.query(
      'INSERT INTO store_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING',
      [key, value]
    );
  }
}

// Adds three example products that reproduce exactly what your screenshots
// showed on the reference TurboPos site: a single kebab with a meat choice
// and a big "modify your product" extras list, a combo with numbered steps,
// and a side dish with a size choice. This runs every time (not just on an
// empty database) but skips a product if it already exists by name, so it's
// safe to re-run after you've customized your real menu in the admin panel.
// Standard drink list used across several upsell groups on the reference site.
const STANDARD_DRINKS = [
  ['Coca Cola', 'Coca-Cola'], ['Coca Cola Zero', 'Coca-Cola Zero'],
  ['Fanta Naranja', 'Fanta Orange'], ['Fanta Limón', 'Fanta Lemon'],
  ['Aquarius Limón', 'Aquarius Lemon'], ['Aquarius Naranja', 'Aquarius Orange'],
  ['Nestea Limón', 'Nestea Lemon'], ['Nestea Maracuyá', 'Nestea Passionfruit'],
  ['Sprite', 'Sprite'], ['Agua', 'Water'],
];

async function seedScreenshotExamples(client) {
  const catRes = await client.query('SELECT id, slug FROM categories');
  const categoryIds = {};
  catRes.rows.forEach((row) => (categoryIds[row.slug] = row.id));

  // Make sure the extra categories these examples live in exist.
  const extraCats = [
    ['Ofertas', 'Combo Offers', 'ofertas', 6],
    ['Acompañamientos', 'Sides', 'sides', 7],
    ['Tacos', 'Tacos', 'tacos', 8],
    ['Menús', 'Meals', 'menus', 9],
    ['Hamburguesas', 'Burgers', 'hamburguesas', 10],
    ['Pizzas', 'Pizzas', 'pizzas', 11],
  ];
  for (const [es, en, slug, order] of extraCats) {
    if (!categoryIds[slug]) {
      const r = await client.query(
        'INSERT INTO categories (name_es, name_en, slug, display_order) VALUES ($1,$2,$3,$4) ON CONFLICT (slug) DO NOTHING RETURNING id',
        [es, en, slug, order]
      );
      if (r.rows[0]) categoryIds[slug] = r.rows[0].id;
      else {
        const existing = await client.query('SELECT id FROM categories WHERE slug=$1', [slug]);
        categoryIds[slug] = existing.rows[0].id;
      }
    }
  }

  async function productExists(name_es) {
    const r = await client.query('SELECT id FROM products WHERE name_es = $1', [name_es]);
    return r.rowCount > 0 ? r.rows[0].id : null;
  }

  async function addGroup(productId, { name_es, name_en, group_type, required, min_selection, max_selection, subtitle_es, subtitle_en }) {
    const r = await client.query(
      `INSERT INTO option_groups (product_id, name_es, name_en, group_type, required, min_selection, max_selection, subtitle_es, subtitle_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [productId, name_es, name_en, group_type, required, min_selection, max_selection, subtitle_es || null, subtitle_en || null]
    );
    return r.rows[0].id;
  }

  async function addOptions(groupId, options) {
    for (const [es, en, mod] of options) {
      await client.query('INSERT INTO options (group_id, name_es, name_en, price_modifier) VALUES ($1,$2,$3,$4)', [groupId, es, en, mod]);
    }
  }

  async function addProduct(category_slug, name_es, name_en, description_es, description_en, price, image_url) {
    const pRes = await client.query(
      `INSERT INTO products (category_id, name_es, name_en, description_es, description_en, price, image_url, is_available)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id`,
      [categoryIds[category_slug], name_es, name_en, description_es, description_en, price, image_url]
    );
    return pRes.rows[0].id;
  }

  const meatOptions = [['Pollo', 'Chicken', 0], ['Ternera', 'Beef', 0], ['Mixto', 'Mixed', 0]];

  // "Menú con X + Patatas" bundle upsell — turns a single item into a meal with fries + a drink.
  function bundleDrinkOptions(price) {
    return STANDARD_DRINKS.map(([es, en]) => [`Menú con ${es} + Patatas`, `${en} Meal + Fries`, price]);
  }
  // Plain drink-only upsell — water is cheaper than the rest, matching the reference site.
  function plainDrinkOptions(price, aguaPrice) {
    return STANDARD_DRINKS.map(([es, en]) => [es, en, es === 'Agua' ? aguaPrice : price]);
  }

  // ==================== KEBAB ====================
  const kebabName = 'Kebab Individual (ejemplo)';
  if (!(await productExists(kebabName)) && categoryIds['kebab']) {
    const productId = await addProduct('kebab', kebabName, 'Individual Kebab (example)',
      'Elige la carne y personaliza tu kebab.', 'Choose your meat and customize your kebab.',
      5.00, 'https://images.unsplash.com/photo-1633321702518-7feccafb94d5?w=600');
    const meatGroup = await addGroup(productId, { name_es: 'Elige la carne', name_en: 'Choose the meat', group_type: 'type', required: true, min_selection: 1, max_selection: 1 });
    await addOptions(meatGroup, meatOptions);
    const modGroup = await addGroup(productId, { name_es: '¿Quieres modificar tu producto?', name_en: 'Do you want to modify your product?', group_type: 'extra', required: false, min_selection: 0, max_selection: 99 });
    await addOptions(modGroup, [
      ['Sin tomate', 'No tomato', 0], ['Sin maíz', 'No corn', 0], ['Sin salsa', 'No sauce', 0],
      ['Sin zanahoria', 'No carrot', 0], ['Solo con lechuga', 'Lettuce only', 0],
      ['Solo carne y salsa blanca', 'Meat and white sauce only', 1.00],
      ['Sin cebolla', 'No onion', 0], ['Sin lechuga', 'No lettuce', 1.00],
      ['Con lechuga y salsa', 'With lettuce and sauce', 0],
      ['Con huevo', 'With egg', 1.00], ['Añadir salsa roja', 'Add red sauce', 0],
      ['Tarrina salsa', 'Sauce tub', 0.50], ['Extra queso', 'Extra cheese', 0.50],
      ['Con picante', 'Spicy', 0], ['Con poca salsa', 'Light sauce', 0],
    ]);
  }

  // ==================== TACOS ====================
  const tacoName = 'Taco Individual (ejemplo)';
  if (!(await productExists(tacoName))) {
    const productId = await addProduct('tacos', tacoName, 'Individual Taco (example)',
      'Elige la carne y personaliza tu taco.', 'Choose your meat and customize your taco.',
      4.50, 'https://images.unsplash.com/photo-1552332386-f8dd00dc2f85?w=600');
    const meatGroup = await addGroup(productId, { name_es: 'Elige la carne', name_en: 'Choose the meat', group_type: 'type', required: true, min_selection: 1, max_selection: 1 });
    await addOptions(meatGroup, meatOptions);
    const modGroup = await addGroup(productId, { name_es: '¿Quieres modificar tu taco?', name_en: 'Do you want to modify your taco?', group_type: 'extra', required: false, min_selection: 0, max_selection: 5 });
    await addOptions(modGroup, [
      ['Sin salsa de taco', 'No taco sauce', 0], ['Solo carne', 'Meat only', 1.00], ['Sin queso', 'No cheese', 0],
      ['Con Lechuga y Salsa', 'With lettuce and sauce', 0], ['Con huevo', 'With egg', 1.00],
      ['Añadir salsa roja', 'Add red sauce', 0], ['Tarrina salsa', 'Sauce tub', 0.50],
      ['Extra queso feta', 'Extra feta cheese', 0.50], ['Con Picante', 'Spicy', 0],
      ['Con poca salsa', 'Light sauce', 0], ['Sin Patata', 'No fries', 0],
    ]);
    const menuGroup = await addGroup(productId, { name_es: '¿Quieres hacerlo menú por tan solo 1.5 euros más?', name_en: 'Want to make it a meal for just €1.5 more?', group_type: 'extra', required: false, min_selection: 0, max_selection: 1 });
    await addOptions(menuGroup, bundleDrinkOptions(1.50));
  }

  const tacoPolloName = '23. Taco Pollo';
  if (!(await productExists(tacoPolloName))) {
    const productId = await addProduct('tacos', tacoPolloName, '23. Chicken Taco',
      'Pechuga de Pollo, Patatas, Queso, Mozzarella y Salsa', 'Chicken breast, fries, cheese, mozzarella and sauce',
      7.00, 'https://images.unsplash.com/photo-1552332386-f8dd00dc2f85?w=600');
    const extraGroup = await addGroup(productId, { name_es: '¿Quieres añadir algún extra a tu taco?', name_en: 'Want to add an extra to your taco?', group_type: 'extra', required: false, min_selection: 0, max_selection: 5 });
    await addOptions(extraGroup, [
      ['Extra mozzarella', 'Extra mozzarella', 1.00], ['Extra queso', 'Extra cheese', 1.00],
      ['Extra salsa', 'Extra sauce', 1.00], ['Extra patatas', 'Extra fries', 1.00],
    ]);
    const modGroup = await addGroup(productId, { name_es: '¿Quieres modificar tu taco?', name_en: 'Do you want to modify your taco?', group_type: 'extra', required: false, min_selection: 0, max_selection: 5 });
    await addOptions(modGroup, [
      ['Sin salsa de taco', 'No taco sauce', 0], ['Solo carne', 'Meat only', 1.00], ['Sin queso', 'No cheese', 0],
      ['Con Lechuga y Salsa', 'With lettuce and sauce', 0], ['Con huevo', 'With egg', 1.00],
      ['Añadir salsa roja', 'Add red sauce', 0], ['Tarrina salsa', 'Sauce tub', 0.50],
      ['Extra queso feta', 'Extra feta cheese', 0.50], ['Con Picante', 'Spicy', 0],
      ['Con poca salsa', 'Light sauce', 0], ['Sin Patata', 'No fries', 0],
    ]);
    const menuGroup2 = await addGroup(productId, { name_es: '¿Quieres hacerlo menú por tan solo 1.5 euros más?', name_en: 'Want to make it a meal for just €1.5 more?', group_type: 'extra', required: false, min_selection: 0, max_selection: 1 });
    await addOptions(menuGroup2, bundleDrinkOptions(1.50));
  }

  // ==================== MENÚS ====================
  const arrozName = '5. Menú Plato Arroz';
  if (!(await productExists(arrozName))) {
    const productId = await addProduct('menus', arrozName, '5. Rice Plate Meal',
      'Pollo, Ternera o Mixto, con Verduras, Arroz y Bebida', 'Chicken, beef or mixed, with vegetables, rice and a drink',
      7.00, 'https://images.unsplash.com/photo-1512058564366-18510be2db19?w=600');
    const meatGroup = await addGroup(productId, { name_es: 'Elige la carne', name_en: 'Choose the meat', group_type: 'type', required: true, min_selection: 1, max_selection: 1 });
    await addOptions(meatGroup, meatOptions);
    const modGroup = await addGroup(productId, { name_es: '¿Quieres modificar tu producto?', name_en: 'Do you want to modify your product?', group_type: 'extra', required: false, min_selection: 0, max_selection: 5 });
    await addOptions(modGroup, [
      ['Sin tomate', 'No tomato', 0], ['Sin maíz', 'No corn', 0], ['Sin salsa', 'No sauce', 0],
      ['Sin zanahoria', 'No carrot', 0], ['Solo con Lechuga', 'Lettuce only', 0],
      ['Solo carne y Salsa Blanca', 'Meat and white sauce only', 1.00],
      ['Sin Cebolla', 'No onion', 0], ['Sin lechuga', 'No lettuce', 1.00],
      ['Con Lechuga y Salsa', 'With lettuce and sauce', 0], ['Con huevo', 'With egg', 1.00],
      ['Añadir salsa roja', 'Add red sauce', 0], ['Tarrina salsa', 'Sauce tub', 0.50],
      ['Extra queso', 'Extra cheese', 0.50], ['Con Picante', 'Spicy', 0], ['Con poca salsa', 'Light sauce', 0],
    ]);
    const drinkGroup = await addGroup(productId, { name_es: 'Elige la bebida', name_en: 'Choose the drink', group_type: 'type', required: true, min_selection: 1, max_selection: 1 });
    await addOptions(drinkGroup, [
      ['Agua Pequeña', 'Small Water', 0], ['Nestea Maracuyá', 'Nestea Passionfruit', 0], ['Nestea Limón', 'Nestea Lemon', 0],
      ['Coca Cola', 'Coca-Cola', 0], ['Coca Cola Zero', 'Coca-Cola Zero', 0], ['Fanta Naranja', 'Fanta Orange', 0],
    ]);
  }

  // ==================== OFERTAS (combos with numbered steps) ====================
  async function addComboOffer(name_es, name_en, description_es, description_en, price, image_url, firstStepLabel, secondStepLabel, thirdStepLabel, bebidaOption) {
    const productId = await addProduct('ofertas', name_es, name_en, description_es, description_en, price, image_url);
    const step1 = await addGroup(productId, { name_es: firstStepLabel[0], name_en: firstStepLabel[1], group_type: 'component', required: true, min_selection: 1, max_selection: 1 });
    await addOptions(step1, meatOptions);
    const step2 = await addGroup(productId, { name_es: secondStepLabel[0], name_en: secondStepLabel[1], group_type: 'component', required: true, min_selection: 1, max_selection: 1 });
    await addOptions(step2, meatOptions);
    const step3 = await addGroup(productId, { name_es: thirdStepLabel[0], name_en: thirdStepLabel[1], group_type: 'component', required: true, min_selection: 1, max_selection: 1 });
    await addOptions(step3, meatOptions);
    const step4 = await addGroup(productId, { name_es: 'Patatas Medianas Menú', name_en: 'Medium Fries (menu)', group_type: 'component', required: true, min_selection: 1, max_selection: 1 });
    await addOptions(step4, [['Patatas Fritas', 'French Fries', 0]]);
    const step5 = await addGroup(productId, { name_es: 'Bebida Menú', name_en: 'Drink (menu)', group_type: 'component', required: true, min_selection: 1, max_selection: 1 });
    await addOptions(step5, [bebidaOption]);
  }

  if (!(await productExists('17. Oferta 3 Durum'))) {
    await addComboOffer(
      '17. Oferta 3 Durum', '17. 3 Durum Combo Offer',
      'Tres durums a elegir, patatas medianas y bebida.', 'Three durums of your choice, medium fries and a drink.',
      17.00, 'https://images.unsplash.com/photo-1633321702518-7feccafb94d5?w=600',
      ['Elige tu primer durum', 'Choose your first durum'],
      ['Elige tu segundo durum', 'Choose your second durum'],
      ['Elige tu tercer durum', 'Choose your third durum'],
      ['Coca Cola 2L', 'Coca-Cola 2L', 0]
    );
  }
  if (!(await productExists('19. Oferta 3 Pita'))) {
    await addComboOffer(
      '19. Oferta 3 Pita', '19. 3 Pita Combo Offer',
      'Tres pita kebab a elegir, patatas medianas y bebida.', 'Three pita kebabs of your choice, medium fries and a drink.',
      15.00, 'https://images.unsplash.com/photo-1619881589863-6c8c6c3f2f52?w=600',
      ['Elige tu primer pita kebab', 'Choose your first pita kebab'],
      ['Elige tu segundo pita kebab', 'Choose your second pita kebab'],
      ['Elige tu tercer pita kebab', 'Choose your third pita kebab'],
      ['Coca Cola', 'Coca-Cola', 0]
    );
  }

  // ==================== SIDES ====================
  const patatasName = '22. Patatas Gratinadas Sin Carne';
  if (!(await productExists(patatasName))) {
    const productId = await addProduct('sides', patatasName, '22. Gratin Potatoes (no meat)',
      'Patatas gratinadas con queso fundido.', 'Gratin potatoes with melted cheese.',
      5.00, 'https://images.unsplash.com/photo-1518013431117-eb1465fa5752?w=600');
    const sizeGroup = await addGroup(productId, { name_es: 'Tamaño', name_en: 'Size', group_type: 'size', required: true, min_selection: 1, max_selection: 1 });
    await addOptions(sizeGroup, [['Mediana', 'Medium', 5.00], ['Grande', 'Large', 6.50]]);
    const noSauceGroup = await addGroup(productId, { name_es: '¿Quieres quitar la salsa?', name_en: 'Do you want to remove the sauce?', group_type: 'extra', required: false, min_selection: 0, max_selection: 1 });
    await addOptions(noSauceGroup, [['Sin salsa blanca', 'No white sauce', 0]]);
    const drinkUpsell = await addGroup(productId, { name_es: '¿Te apetece bebida por solo 1.5 más?', name_en: 'Fancy a drink for just €1.5 more?', group_type: 'extra', required: false, min_selection: 0, max_selection: 1 });
    await addOptions(drinkUpsell, plainDrinkOptions(1.50, 1.00));
  }

  const bolitasName = '8. Bolitas de Pollo';
  if (!(await productExists(bolitasName))) {
    const productId = await addProduct('sides', bolitasName, '8. Chicken Bites',
      '14 uds', '14 pieces',
      3.00, 'https://images.unsplash.com/photo-1562967914-608f82629710?w=600');
    const menuGroup = await addGroup(productId, { name_es: '¿Quieres hacerlo menú por tan solo 2 euros más?', name_en: 'Want to make it a meal for just €2 more?', group_type: 'extra', required: false, min_selection: 0, max_selection: 1 });
    await addOptions(menuGroup, bundleDrinkOptions(2.00));
  }

  const nuggetsName = 'Nuggets (ejemplo)';
  if (!(await productExists(nuggetsName))) {
    const productId = await addProduct('sides', nuggetsName, 'Nuggets (example)',
      'Elige entre 6 y 9 unidades o menú con 6 unidades con patatas y bebida', 'Choose between 6 and 9 pieces, or a meal with 6 pieces, fries and a drink',
      4.50, 'https://images.unsplash.com/photo-1562967914-608f82629710?w=600');
    const formatoGroup = await addGroup(productId, { name_es: 'Formato', name_en: 'Format', group_type: 'size', required: true, min_selection: 1, max_selection: 1 });
    await addOptions(formatoGroup, [['6 uds', '6 pcs', 4.50], ['9 uds', '9 pcs', 6.50]]);
    const menuGroup = await addGroup(productId, { name_es: '¿Quieres hacerlo menú por tan solo 1.5 euros más?', name_en: 'Want to make it a meal for just €1.5 more?', group_type: 'extra', required: false, min_selection: 0, max_selection: 1 });
    await addOptions(menuGroup, bundleDrinkOptions(1.50));
  }

  // ==================== HAMBURGUESAS ====================
  const hamburguesaName = '6. Hamburguesa';
  if (!(await productExists(hamburguesaName))) {
    const productId = await addProduct('hamburguesas', hamburguesaName, '6. Burger',
      'Pollo', 'Chicken', 3.50, 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600');
    const modGroup = await addGroup(productId, { name_es: '¿Quieres modificar tu hamburguersa?', name_en: 'Do you want to modify your burger?', group_type: 'extra', required: false, min_selection: 0, max_selection: 5 });
    await addOptions(modGroup, [
      ['Sin salsa', 'No sauce', 0], ['Sin lechuga', 'No lettuce', 0], ['Sin tomate', 'No tomato', 0],
      ['Sin queso', 'No cheese', 0], ['Solo carne', 'Meat only', 0], ['Doble queso', 'Double cheese', 1.00],
      ['Con huevo', 'With egg', 1.00], ['Tarrina salsa', 'Sauce tub', 0.50], ['Doble carne', 'Double meat', 2.00],
      ['Añadir salsa roja', 'Add red sauce', 0], ['Sin salsa roja', 'No red sauce', 9.00], ['Solo Queso', 'Cheese only', 0],
    ]);
    const menuGroup = await addGroup(productId, { name_es: '¿Quieres hacerlo menú con patatas y bebida por tan solo 2,5 euros más?', name_en: 'Want to make it a meal with fries and a drink for just €2.5 more?', group_type: 'extra', required: false, min_selection: 0, max_selection: 1 });
    await addOptions(menuGroup, bundleDrinkOptions(2.50));
    const drinkUpsell = await addGroup(productId, { name_es: '¿Te apetece bebida por solo 1.5 más?', name_en: 'Fancy a drink for just €1.5 more?', group_type: 'extra', required: false, min_selection: 0, max_selection: 1 });
    await addOptions(drinkUpsell, plainDrinkOptions(1.50, 1.00));
  }

  // ==================== PIZZAS ====================
  const pizzaName = 'Pizza Prosciutto (ejemplo)';
  if (!(await productExists(pizzaName))) {
    const productId = await addProduct('pizzas', pizzaName, 'Prosciutto Pizza (example)',
      'Salsa Tomate, Mozzarella, Jamón Pavo, Queso Feta y Orégano', 'Tomato sauce, mozzarella, turkey ham, feta cheese and oregano',
      8.00, 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600');
    const sizeGroup = await addGroup(productId, { name_es: 'Tamaño', name_en: 'Size', group_type: 'size', required: true, min_selection: 1, max_selection: 1 });
    await addOptions(sizeGroup, [['Mediana 28 cm', 'Medium 28 cm', 8.00], ['Grande 32 cm', 'Large 32 cm', 10.00]]);
    const suplementosGroup = await addGroup(productId, { name_es: '¿Quieres añadir algún suplemento a tu pizza?', name_en: 'Want to add a topping to your pizza?', group_type: 'extra', required: false, min_selection: 0, max_selection: 5 });
    await addOptions(suplementosGroup, [
      ['Extra mozzarella', 'Extra mozzarella', 1.00], ['Extra oregano', 'Extra oregano', 1.00],
      ['Extra atún', 'Extra tuna', 1.00], ['Extra pollo', 'Extra chicken', 1.00], ['Extra ternera', 'Extra beef', 1.00],
      ['Extra cebolla', 'Extra onion', 1.00], ['Extra oliva', 'Extra olives', 1.00], ['Extra champiñones', 'Extra mushrooms', 1.00],
      ['Extra jamón pavo', 'Extra turkey ham', 1.00], ['Extra queso feta', 'Extra feta cheese', 1.00],
    ]);
    const drinkUpsell = await addGroup(productId, { name_es: '¿Te apetece bebida por solo 1.5 más?', name_en: 'Fancy a drink for just €1.5 more?', group_type: 'extra', required: false, min_selection: 0, max_selection: 1 });
    await addOptions(drinkUpsell, plainDrinkOptions(1.50, 1.00));
  }
}

async function main() {
  try {
    await ensureDatabaseExists();
    // With a cloud connection string (Neon), the database is already fixed by
    // that string — don't pass a separate `database` field, since that could
    // conflict with (or silently override) the one the string points to.
    const client = new Client(usingCloudDb ? baseConfig : { ...baseConfig, database: DB_NAME });
    await client.connect();
    console.log('Creating tables (if they do not already exist)...');
    await client.query(SCHEMA_SQL);
    await seedIfEmpty(client);
    await seedScreenshotExamples(client);
    await client.end();
    console.log('\n✅ Setup complete! You can now run: npm start');
  } catch (err) {
    console.error('\n❌ Setup failed:', err.message);
    process.exit(1);
  }
}

main();
