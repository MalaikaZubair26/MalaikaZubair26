require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const path = require('path');
const pool = require('./db');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const TAX_RATE = 0; // Tax removed — prices are shown/charged tax-inclusive with no separate line item

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Image uploads ----------
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `image-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// A tighter limiter just for the two login endpoints, so a fixed-length PIN
// (4 digits = 10,000 combos) or a guessed password can't be brute-forced by
// hammering the general 120/min API limit.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — please wait a few minutes and try again.' },
});

// ---------- Sessions ----------
// Real, unguessable per-login session tokens (32 random bytes), kept in memory
// with an expiry, instead of a single fixed shared secret. Restarting the
// server clears all sessions — everyone just logs in again, which is fine for
// a small single-instance restaurant app.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map(); // token -> { role: 'admin' | 'kitchen', expires: number }

function createSession(role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { role, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function checkSession(token, role) {
  const session = sessions.get(token);
  if (!session) return false;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  if (session.role !== role) return false;
  return true;
}

// Periodically sweep expired sessions so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expires < now) sessions.delete(token);
  }
}, 60 * 60 * 1000);

// ---------- Helpers ----------
function requireAdmin(req, res, next) {
  const header = req.headers['x-admin-token'];
  if (!checkSession(header, 'admin')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function requireKitchen(req, res, next) {
  const header = req.headers['x-kitchen-token'];
  if (!checkSession(header, 'kitchen')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------- Image upload endpoint ----------
app.post('/api/admin/upload', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ path: `/uploads/${req.file.filename}` });
});

// ---------- Store Settings ----------
app.get('/api/settings', async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM store_settings');
    const settings = {};
    r.rows.forEach((row) => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const updates = req.body || {};
  try {
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(
        `INSERT INTO store_settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value)]
      );
    }
    const r = await pool.query('SELECT key, value FROM store_settings');
    const settings = {};
    r.rows.forEach((row) => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ---------- Public: Categories & Products ----------
app.get('/api/categories', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM categories WHERE is_active = true ORDER BY display_order ASC, id ASC'
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// ---------- Admin: Category CRUD ----------
app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  const { username, currentPassword, newPassword } = req.body;
  if (!username || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  try {
    const r = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);
    if (r.rowCount === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(currentPassword, r.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE admin_users SET password_hash = $1 WHERE username = $2', [newHash, username]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

app.get('/api/admin/categories', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM categories ORDER BY display_order ASC, id ASC');
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

app.post('/api/admin/categories', requireAdmin, async (req, res) => {
  const { name_es, name_en, slug, image_url, display_order, is_active } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO categories (name_es, name_en, slug, image_url, display_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name_es, name_en, slug, image_url || null, display_order || 0, is_active !== false]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

app.put('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  const { name_es, name_en, slug, image_url, display_order, is_active } = req.body;
  try {
    const r = await pool.query(
      `UPDATE categories SET name_es=$1, name_en=$2, slug=$3, image_url=$4, display_order=$5, is_active=$6
       WHERE id=$7 RETURNING *`,
      [name_es, name_en, slug, image_url || null, display_order || 0, is_active !== false, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Category not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

app.delete('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*, c.slug AS category_slug, c.name_es AS category_name_es, c.name_en AS category_name_en,
        EXISTS (SELECT 1 FROM option_groups og WHERE og.product_id = p.id) AS has_options
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       ORDER BY p.id ASC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// ---------- Product Options (customizations) ----------
// If an admin didn't type a subtitle, derive the standard TurboPos-style wording
// ("Elige un/a" for a required single choice, "Elige hasta N extras" for an
// optional group) so every product looks consistent without manual typing.
function deriveSubtitle(g) {
  if (!g.subtitle_es) {
    if (g.group_type !== 'size' && g.required && (g.max_selection || 1) === 1) {
      g.subtitle_es = 'Elige un/a';
      g.subtitle_en = g.subtitle_en || 'Choose one';
    } else if (!g.required) {
      g.subtitle_es = `Elige hasta ${g.max_selection || 1} extras`;
      g.subtitle_en = g.subtitle_en || `Choose up to ${g.max_selection || 1} extras`;
    }
  }
  return g;
}

app.get('/api/products/:id/options', async (req, res) => {
  try {
    const groupsRes = await pool.query(
      'SELECT * FROM option_groups WHERE product_id = $1 ORDER BY id ASC',
      [req.params.id]
    );
    const groups = groupsRes.rows;
    for (const g of groups) {
      const optsRes = await pool.query(
        'SELECT * FROM options WHERE group_id = $1 AND is_available = true ORDER BY id ASC',
        [g.id]
      );
      g.options = optsRes.rows;
      deriveSubtitle(g);
    }
    res.json(groups);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load product options' });
  }
});

// ---------- Customers ----------
app.post('/api/customers', async (req, res) => {
  const { phone, name, saved_address } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone is required' });
  try {
    const existing = await pool.query('SELECT * FROM customers WHERE phone = $1', [phone]);
    let customer;
    if (existing.rowCount > 0) {
      const r = await pool.query(
        'UPDATE customers SET name = $1, saved_address = $2 WHERE phone = $3 RETURNING *',
        [name || existing.rows[0].name, saved_address || existing.rows[0].saved_address, phone]
      );
      customer = r.rows[0];
    } else {
      const r = await pool.query(
        'INSERT INTO customers (phone, name, saved_address) VALUES ($1,$2,$3) RETURNING *',
        [phone, name || null, saved_address || null]
      );
      customer = r.rows[0];
    }
    res.json(customer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save customer' });
  }
});

// GDPR deletion (admin-triggered)
app.delete('/api/admin/customers/:phone', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE orders SET customer_id = NULL, customer_name = NULL, delivery_address = NULL WHERE customer_id = (SELECT id FROM customers WHERE phone = $1)', [req.params.phone]);
    await pool.query('DELETE FROM customers WHERE phone = $1', [req.params.phone]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

// GDPR self-service deletion (customer-triggered, matched by phone only)
app.delete('/api/customers/:phone/gdpr', async (req, res) => {
  try {
    const existing = await pool.query('SELECT id FROM customers WHERE phone = $1', [req.params.phone]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'No data found for this phone number' });
    }
    await pool.query(
      `UPDATE orders SET customer_id = NULL, customer_name = NULL, delivery_address = NULL
       WHERE customer_id = $1`,
      [existing.rows[0].id]
    );
    await pool.query('DELETE FROM customers WHERE id = $1', [existing.rows[0].id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process deletion request' });
  }
});

// Customer order history lookup (by phone)
app.get('/api/customers/:phone/orders', async (req, res) => {
  try {
    const ordersRes = await pool.query(
      `SELECT * FROM orders WHERE customer_phone = $1 ORDER BY created_at DESC LIMIT 25`,
      [req.params.phone]
    );
    const orders = ordersRes.rows;
    for (const o of orders) {
      const itemsRes = await pool.query(
        `SELECT oi.*, p.name_es, p.name_en FROM order_items oi
         LEFT JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = $1`,
        [o.id]
      );
      o.items = itemsRes.rows;
    }
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load order history' });
  }
});

// ---------- Orders ----------
app.post('/api/orders', async (req, res) => {
  const {
    customer_name, customer_phone, delivery_address,
    fulfillment_type, kiosk_or_table_id, payment_method,
    items, gdpr_consent,
  } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must include at least one item' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Recompute every item's price from the database instead of trusting the
    // price sent by the browser — otherwise a customer could edit the request
    // and check out for €0. This mirrors the size-override + extras logic in
    // app.js's computeUnitPrice().
    let subtotal = 0;
    for (const it of items) {
      const prodRes = await client.query('SELECT price FROM products WHERE id = $1', [it.product_id]);
      if (prodRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Invalid product in order (id ${it.product_id})` });
      }
      let unitPrice = parseFloat(prodRes.rows[0].price);
      const selected = Array.isArray(it.selected_options) ? it.selected_options : [];
      for (const so of selected) {
        const optRes = await client.query(
          `SELECT o.price_modifier, og.group_type
           FROM options o JOIN option_groups og ON og.id = o.group_id
           WHERE o.id = $1 AND og.product_id = $2`,
          [so.id, it.product_id]
        );
        if (optRes.rowCount === 0) continue; // ignore options that don't belong to this product
        const mod = parseFloat(optRes.rows[0].price_modifier);
        if (optRes.rows[0].group_type === 'size') {
          unitPrice = mod; // a size option's price_modifier is the full item price, not an add-on
        } else {
          unitPrice += mod;
        }
      }
      it.item_price = Math.round(unitPrice * 100) / 100;
      subtotal += it.item_price * parseInt(it.quantity, 10);
    }
    subtotal = Math.round(subtotal * 100) / 100;

    const settingsRes = await client.query(
      "SELECT key, value FROM store_settings WHERE key IN ('delivery_fee','min_order')"
    );
    const settingsMap = {};
    settingsRes.rows.forEach((row) => { settingsMap[row.key] = row.value; });
    const deliveryFeeSetting = settingsMap.delivery_fee != null ? parseFloat(settingsMap.delivery_fee) : 2.50;
    const minOrderSetting = settingsMap.min_order != null ? parseFloat(settingsMap.min_order) : 0;

    if (fulfillment_type === 'delivery' && subtotal < minOrderSetting) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `El pedido mínimo para entrega a domicilio es €${minOrderSetting.toFixed(2)}` });
    }

    const delivery_fee = fulfillment_type === 'delivery' ? deliveryFeeSetting : 0;
    const tax_amount = Math.round((subtotal * TAX_RATE) * 100) / 100;
    const grand_total = Math.round((subtotal + tax_amount + delivery_fee) * 100) / 100;

    let customer_id = null;
    if (customer_phone) {
      const existing = await client.query('SELECT id FROM customers WHERE phone = $1', [customer_phone]);
      if (existing.rowCount > 0) {
        customer_id = existing.rows[0].id;
      } else {
        const r = await client.query(
          'INSERT INTO customers (phone, name, saved_address) VALUES ($1,$2,$3) RETURNING id',
          [customer_phone, customer_name || null, delivery_address || null]
        );
        customer_id = r.rows[0].id;
      }
    }

    const orderRes = await client.query(
      `INSERT INTO orders
        (customer_id, customer_name, customer_phone, delivery_address, fulfillment_type,
         kiosk_or_table_id, payment_method, delivery_fee, subtotal, tax_amount, grand_total, status, gdpr_consent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12)
       RETURNING *`,
      [customer_id, customer_name || null, customer_phone || null, delivery_address || null,
       fulfillment_type || 'takeaway', kiosk_or_table_id || null, payment_method || 'cash',
       delivery_fee, subtotal, tax_amount, grand_total, !!gdpr_consent]
    );
    const order = orderRes.rows[0];

    for (const it of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, selected_options, item_price)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.id, it.product_id, it.quantity, JSON.stringify(it.selected_options || []), it.item_price]
      );
    }

    await client.query('COMMIT');
    res.json(order);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    client.release();
  }
});

app.get('/api/orders/:id/status', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, status, grand_total, created_at FROM orders WHERE id = $1', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch order status' });
  }
});

// ---------- Kitchen ----------
app.post('/api/kitchen/login', loginLimiter, (req, res) => {
  const { pin } = req.body;
  if (pin === (process.env.KITCHEN_PIN || '1234')) {
    return res.json({ success: true, token: createSession('kitchen') });
  }
  res.status(401).json({ error: 'Invalid PIN' });
});

app.get('/api/kitchen/orders', requireKitchen, async (req, res) => {
  try {
    const ordersRes = await pool.query(
      `SELECT * FROM orders WHERE status != 'completed' ORDER BY created_at ASC`
    );
    const orders = ordersRes.rows;
    for (const o of orders) {
      const itemsRes = await pool.query(
        `SELECT oi.*, p.name_es, p.name_en FROM order_items oi
         LEFT JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = $1`,
        [o.id]
      );
      o.items = itemsRes.rows;
    }
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load kitchen orders' });
  }
});

app.put('/api/kitchen/orders/:id/status', requireKitchen, async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'preparing', 'ready', 'completed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const r = await pool.query('UPDATE orders SET status = $1 WHERE id = $2 RETURNING *', [status, req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ---------- Admin Auth ----------
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);
    if (r.rowCount === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ success: true, token: createSession('admin') });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ---------- Admin: Product CRUD ----------
app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const { category_id, name_es, name_en, description_es, description_en, price, image_url, is_available, is_trending } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO products (category_id, name_es, name_en, description_es, description_en, price, image_url, is_available, is_trending)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [category_id || null, name_es, name_en, description_es || '', description_en || '', price, image_url || '', is_available !== false, !!is_trending]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const { category_id, name_es, name_en, description_es, description_en, price, image_url, is_available, is_trending } = req.body;
  try {
    const r = await pool.query(
      `UPDATE products SET category_id=$1, name_es=$2, name_en=$3, description_es=$4,
       description_en=$5, price=$6, image_url=$7, is_available=$8, is_trending=$9 WHERE id=$10 RETURNING *`,
      [category_id || null, name_es, name_en, description_es || '', description_en || '', price, image_url || '', is_available !== false, !!is_trending, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ---------- Admin: Option Groups & Options CRUD ----------
app.get('/api/admin/products/:id/options', requireAdmin, async (req, res) => {
  try {
    const groupsRes = await pool.query('SELECT * FROM option_groups WHERE product_id = $1 ORDER BY id ASC', [req.params.id]);
    const groups = groupsRes.rows;
    for (const g of groups) {
      const optsRes = await pool.query('SELECT * FROM options WHERE group_id = $1 ORDER BY id ASC', [g.id]);
      g.options = optsRes.rows;
      deriveSubtitle(g);
    }
    res.json(groups);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load options' });
  }
});

app.post('/api/admin/option-groups', requireAdmin, async (req, res) => {
  const { product_id, name_es, name_en, subtitle_es, subtitle_en, group_type, required, min_selection, max_selection } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO option_groups (product_id, name_es, name_en, subtitle_es, subtitle_en, group_type, required, min_selection, max_selection)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        product_id, name_es, name_en || name_es, subtitle_es || null, subtitle_en || null,
        group_type || 'extra', !!required,
        min_selection != null ? min_selection : (required ? 1 : 0),
        max_selection || 1,
      ]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create option group' });
  }
});

app.put('/api/admin/option-groups/:id', requireAdmin, async (req, res) => {
  const { name_es, name_en, subtitle_es, subtitle_en, group_type, required, min_selection, max_selection } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM option_groups WHERE id = $1', [req.params.id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Option group not found' });
    const cur = existing.rows[0];
    const r = await pool.query(
      `UPDATE option_groups SET name_es=$1, name_en=$2, subtitle_es=$3, subtitle_en=$4, group_type=$5,
       required=$6, min_selection=$7, max_selection=$8 WHERE id=$9 RETURNING *`,
      [
        name_es ?? cur.name_es,
        name_en ?? cur.name_en,
        subtitle_es !== undefined ? subtitle_es : cur.subtitle_es,
        subtitle_en !== undefined ? subtitle_en : cur.subtitle_en,
        group_type ?? cur.group_type,
        required !== undefined ? required : cur.required,
        min_selection !== undefined ? min_selection : cur.min_selection,
        max_selection !== undefined ? max_selection : cur.max_selection,
        req.params.id,
      ]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update option group' });
  }
});

app.delete('/api/admin/option-groups/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM option_groups WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete option group' });
  }
});

app.post('/api/admin/options', requireAdmin, async (req, res) => {
  const { group_id, name_es, name_en, price_modifier } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO options (group_id, name_es, name_en, price_modifier) VALUES ($1,$2,$3,$4) RETURNING *`,
      [group_id, name_es, name_en, price_modifier || 0]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create option' });
  }
});

app.put('/api/admin/options/:id', requireAdmin, async (req, res) => {
  const { name_es, name_en, price_modifier, is_available } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM options WHERE id = $1', [req.params.id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Option not found' });
    const cur = existing.rows[0];
    const r = await pool.query(
      `UPDATE options SET name_es=$1, name_en=$2, price_modifier=$3, is_available=$4 WHERE id=$5 RETURNING *`,
      [
        name_es ?? cur.name_es,
        name_en ?? cur.name_en,
        price_modifier ?? cur.price_modifier,
        is_available !== undefined ? is_available : cur.is_available,
        req.params.id,
      ]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update option' });
  }
});

app.delete('/api/admin/options/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM options WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete option' });
  }
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100');
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

app.listen(PORT, () => {
  console.log(`\n🥙 donerkebabtacos server running at http://localhost:${PORT}`);
  console.log(`   Customer app:  http://localhost:${PORT}/`);
  console.log(`   Kitchen view:  http://localhost:${PORT}/kitchen.html`);
  console.log(`   Admin panel:   http://localhost:${PORT}/admin.html\n`);
});

// Safety net: without this, a single unexpected bug anywhere in the app
// (like the double-release bug just fixed above) throws an exception that
// isn't caught by any specific route's try/catch, and Node's default
// behavior is to crash the *entire* process — taking the whole site offline
// for every customer until someone notices and restarts it by hand. Logging
// and continuing means one bad request can't bring down the restaurant.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (server kept running):', err);
});
