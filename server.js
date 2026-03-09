const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcryptjs');
const geoip = require('geoip-lite');

const fetchFn =
  typeof fetch === 'function'
    ? fetch.bind(globalThis)
    : (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'lozinka123';

// LOCKR
const LOCKR_API_URL = 'https://lockr.so/api/v1/lockers';
const LOCKR_SECRET_API_KEY =
  process.env.LOCKR_SECRET_API_KEY ||
  'CHANGE_ME';

// PAYPAL
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_ENV = process.env.PAYPAL_ENV || 'sandbox'; // sandbox or live

const PAYPAL_BASE_URL =
  PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

const SESSION_SECRET =
  process.env.SESSION_SECRET || 'spicyvault_secret_key_demo_change_this';

const APP_BASE_URL =
  process.env.APP_BASE_URL || `http://127.0.0.1:${PORT}`;

const DB_PATH = path.join(__dirname, 'spicyvault.db');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      target_url TEXT NOT NULL,
      lockr_url TEXT,
      image_url TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_vip INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT,
      country_code TEXT,
      user_agent TEXT,
      browser TEXT,
      path TEXT,
      referer TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS vip_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      paypal_order_id TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function detectBrowser(userAgent = '') {
  const ua = userAgent.toLowerCase();

  if (ua.includes('edg')) return 'Edge';
  if (ua.includes('opr') || ua.includes('opera')) return 'Opera';
  if (ua.includes('chrome')) return 'Chrome';
  if (ua.includes('firefox')) return 'Firefox';
  if (ua.includes('safari') && !ua.includes('chrome')) return 'Safari';

  return 'Unknown';
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function getCountryCodeFromIp(ip) {
  try {
    if (!ip) return '';

    const cleanedIp = ip.replace('::ffff:', '');

    if (
      cleanedIp === '127.0.0.1' ||
      cleanedIp === '::1' ||
      cleanedIp.startsWith('192.168.') ||
      cleanedIp.startsWith('10.') ||
      cleanedIp.startsWith('172.')
    ) {
      return 'LOCAL';
    }

    const geo = geoip.lookup(cleanedIp);
    return geo?.country || '';
  } catch {
    return '';
  }
}

function countryCodeToFlagEmoji(code) {
  if (!code || code === 'LOCAL') return '🏠';
  return code
    .toUpperCase()
    .replace(/./g, char => String.fromCodePoint(127397 + char.charCodeAt()));
}

function getPlanConfig(plan) {
  const plans = {
    week: { label: 'VIP 1 WEEK', value: '5.00', currency: 'EUR' },
    month: { label: 'VIP 1 MONTH', value: '15.00', currency: 'EUR' },
    lifetime: { label: 'VIP LIFETIME', value: '25.00', currency: 'EUR' }
  };

  return plans[plan] || null;
}

function getSessionCookieSecure() {
  return process.env.NODE_ENV === 'production';
}

async function parseJsonSafe(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('Missing PayPal credentials.');
  }

  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');

  const response = await fetchFn(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const data = await parseJsonSafe(response);

  if (!response.ok || !data.access_token) {
    console.error('PayPal token error:', {
      status: response.status,
      statusText: response.statusText,
      data
    });
    throw new Error('Failed to get PayPal access token.');
  }

  return data.access_token;
}

async function createPayPalOrder({ plan, userId }) {
  const planConfig = getPlanConfig(plan);
  if (!planConfig) {
    throw new Error('Invalid VIP plan.');
  }

  const accessToken = await getPayPalAccessToken();

  const response = await fetchFn(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: `user_${userId}_${plan}`,
          description: planConfig.label,
          amount: {
            currency_code: planConfig.currency,
            value: planConfig.value
          }
        }
      ],
      application_context: {
        brand_name: 'Spicy Vault',
        landing_page: 'LOGIN',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: `${APP_BASE_URL}/?paypal=success`,
        cancel_url: `${APP_BASE_URL}/?paypal=cancel`
      }
    })
  });

  const data = await parseJsonSafe(response);

  if (!response.ok || !data.id) {
    console.error('PayPal create order error:', {
      status: response.status,
      statusText: response.statusText,
      data
    });
    throw new Error('Failed to create PayPal order.');
  }

  const approveLink = data.links?.find(link => link.rel === 'approve')?.href || null;
  const now = new Date().toISOString();

  await run(
    `INSERT OR REPLACE INTO vip_orders
      (user_id, paypal_order_id, plan, amount, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      data.id,
      plan,
      planConfig.value,
      planConfig.currency,
      data.status || 'CREATED',
      now,
      now
    ]
  );

  return {
    orderId: data.id,
    approveLink
  };
}

async function capturePayPalOrder(orderId) {
  const accessToken = await getPayPalAccessToken();

  const response = await fetchFn(`${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }
  });

  const data = await parseJsonSafe(response);

  if (!response.ok) {
    console.error('PayPal capture error:', {
      status: response.status,
      statusText: response.statusText,
      data
    });
    throw new Error('Failed to capture PayPal payment.');
  }

  return data;
}

function isPayPalOrderCompleted(orderData) {
  if (!orderData) return false;

  if (orderData.status === 'COMPLETED') {
    return true;
  }

  const captures =
    orderData.purchase_units?.flatMap(unit => unit.payments?.captures || []) || [];

  return captures.some(capture => capture.status === 'COMPLETED');
}

async function upgradeUserVipFromOrder(orderId) {
  const order = await get('SELECT * FROM vip_orders WHERE paypal_order_id = ?', [orderId]);

  if (!order) {
    throw new Error('VIP order not found.');
  }

  if (order.status === 'COMPLETED') {
    return;
  }

  await run('UPDATE users SET is_vip = 1 WHERE id = ?', [order.user_id]);

  await run(
    'UPDATE vip_orders SET status = ?, updated_at = ? WHERE paypal_order_id = ?',
    ['COMPLETED', new Date().toISOString(), orderId]
  );
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, filename);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, WEBP and GIF files are allowed.'));
    }
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: getSessionCookieSecure(),
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));

app.use(async (req, res, next) => {
  try {
    const skip =
      req.path.startsWith('/uploads/') ||
      req.path === '/favicon.ico' ||
      req.path.endsWith('.css') ||
      req.path.endsWith('.js') ||
      req.path.endsWith('.png') ||
      req.path.endsWith('.jpg') ||
      req.path.endsWith('.jpeg') ||
      req.path.endsWith('.webp') ||
      req.path.endsWith('.gif');

    if (!skip) {
      const ip = getClientIp(req);
      const countryCode = getCountryCodeFromIp(ip);

      await run(
        `INSERT INTO visits (ip, country_code, user_agent, browser, path, referer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          ip,
          countryCode,
          req.headers['user-agent'] || '',
          detectBrowser(req.headers['user-agent'] || ''),
          req.path,
          req.headers['referer'] || '',
          new Date().toISOString()
        ]
      );
    }
  } catch (error) {
    console.error('Visit log error:', error.message);
  }

  next();
});

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function requireUserPage(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

function requireUserApi(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Login required.' });
  }
  next();
}

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'register.html'));
});

app.get('/admin-login', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin-login.html'));
});

app.get('/admin', (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect('/admin-login');
  }

  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/paypal-success', requireUserPage, (req, res) => {
  res.redirect('/?paypal=success');
});

app.get('/api/paypal/config', (req, res) => {
  res.json({
    clientId: PAYPAL_CLIENT_ID || '',
    currency: 'EUR',
    env: PAYPAL_ENV
  });
});

app.post('/api/paypal/create-order', requireUserApi, async (req, res) => {
  try {
    const plan = (req.body.plan || '').trim();

    const result = await createPayPalOrder({
      plan,
      userId: req.session.userId
    });

    res.json({
      orderID: result.orderId
    });
  } catch (error) {
    console.error('PayPal create-order route error:', error);
    res.status(500).json({
      error: error.message || 'Failed to create order.'
    });
  }
});

app.post('/api/paypal/capture-order', requireUserApi, async (req, res) => {
  try {
    const orderId = (req.body.orderID || '').trim();

    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderID.' });
    }

    const existing = await get(
      'SELECT * FROM vip_orders WHERE paypal_order_id = ? AND user_id = ?',
      [orderId, req.session.userId]
    );

    if (!existing) {
      return res.status(404).json({ error: 'VIP order not found.' });
    }

    if (existing.status === 'COMPLETED') {
      return res.json({ success: true, alreadyCompleted: true });
    }

    const captureData = await capturePayPalOrder(orderId);

    if (!isPayPalOrderCompleted(captureData)) {
      console.error('PayPal capture incomplete:', captureData);
      return res.status(400).json({ error: 'Payment not completed.' });
    }

    await upgradeUserVipFromOrder(orderId);

    res.json({ success: true });
  } catch (error) {
    console.error('PayPal capture-order route error:', error);
    res.status(500).json({
      error: error.message || 'Failed to capture order.'
    });
  }
});

/* BACKWARD COMPATIBILITY FOR OLD LINKS */
app.get('/api/paypal/start/:plan', requireUserPage, async (req, res) => {
  try {
    const plan = (req.params.plan || '').trim();

    const result = await createPayPalOrder({
      plan,
      userId: req.session.userId
    });

    if (!result.approveLink) {
      return res.redirect('/?paypal=error');
    }

    res.redirect(result.approveLink);
  } catch (error) {
    console.error('PayPal start compatibility route error:', error);
    res.redirect('/?paypal=error');
  }
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password.' });
  }

  req.session.isAdmin = true;
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.post('/api/register', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const existing = await get('SELECT * FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(400).json({ error: 'Username already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await run(
      'INSERT INTO users (username, password_hash, is_vip, created_at) VALUES (?, ?, 0, ?)',
      [username, passwordHash, new Date().toISOString()]
    );

    req.session.userId = result.lastID;

    res.json({ success: true });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Register failed.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const user = await get('SELECT * FROM users WHERE username = ?', [username]);

    if (!user) {
      return res.status(401).json({ error: 'Wrong username or password.' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
      return res.status(401).json({ error: 'Wrong username or password.' });
    }

    req.session.userId = user.id;

    res.json({ success: true });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/me', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.json({
        loggedIn: false,
        username: null,
        isVip: false
      });
    }

    const user = await get(
      'SELECT id, username, is_vip FROM users WHERE id = ?',
      [req.session.userId]
    );

    if (!user) {
      return res.json({
        loggedIn: false,
        username: null,
        isVip: false
      });
    }

    res.json({
      loggedIn: true,
      username: user.username,
      isVip: !!user.is_vip
    });
  } catch (error) {
    console.error('Me error:', error);
    res.json({
      loggedIn: false,
      username: null,
      isVip: false
    });
  }
});

app.get('/api/items', async (req, res) => {
  try {
    const items = await all('SELECT * FROM items ORDER BY id DESC');
    res.json(items);
  } catch (error) {
    console.error('Load items error:', error);
    res.status(500).json({ error: 'Failed to load items.' });
  }
});

app.post('/api/items', requireAdmin, upload.single('imageFile'), async (req, res) => {
  try {
    const title = (req.body.title || '').trim();
    const target = (req.body.target || '').trim();
    const imageUrl = (req.body.imageUrl || '').trim();

    if (!title || !target) {
      return res.status(400).json({ error: 'Title and target URL are required.' });
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(target);
    } catch {
      return res.status(400).json({ error: 'Invalid target URL.' });
    }

    let finalImage = '';

    if (req.file) {
      finalImage = `/uploads/${req.file.filename}`;
    } else if (imageUrl) {
      try {
        finalImage = new URL(imageUrl).toString();
      } catch {
        return res.status(400).json({ error: 'Invalid image URL.' });
      }
    }

    const payload = {
  title,
  url: parsedTarget.toString()
};

    const lockrResponse = await fetchFn(LOCKR_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOCKR_SECRET_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const lockrResult = await parseJsonSafe(lockrResponse);

    if (!lockrResponse.ok) {
      return res.status(lockrResponse.status).json({
        error: lockrResult?.message || lockrResult?.error || 'Failed to create locker.'
      });
    }

    const lockrUrl =
      lockrResult?.url ||
      lockrResult?.link ||
      lockrResult?.short_url ||
      lockrResult?.locker_url ||
      lockrResult?.data?.url ||
      lockrResult?.data?.link ||
      lockrResult?.data?.short_url ||
      parsedTarget.toString();

    const createdAt = new Date().toISOString();

    await run(
      `INSERT INTO items (title, target_url, lockr_url, image_url, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [title, parsedTarget.toString(), lockrUrl, finalImage, createdAt]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Create item error:', error);
    res.status(500).json({ error: error.message || 'Internal server error.' });
  }
});

app.delete('/api/items/:id', requireAdmin, async (req, res) => {
  try {
    const item = await get('SELECT * FROM items WHERE id = ?', [req.params.id]);

    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (item.image_url && item.image_url.startsWith('/uploads/')) {
      const safeRelativePath = item.image_url.replace(/^\/+/, '');
      const filePath = path.join(__dirname, safeRelativePath);

      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (error) {
          console.error('Delete image error:', error.message);
        }
      }
    }

    await run('DELETE FROM items WHERE id = ?', [req.params.id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete item error:', error);
    res.status(500).json({ error: 'Delete failed.' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await all(
      'SELECT id, username, is_vip, created_at FROM users ORDER BY id DESC'
    );
    res.json(users);
  } catch (error) {
    console.error('Load users error:', error);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

app.patch('/api/admin/users/:id/vip', requireAdmin, async (req, res) => {
  try {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const nextVip = user.is_vip ? 0 : 1;

    await run('UPDATE users SET is_vip = ? WHERE id = ?', [nextVip, req.params.id]);

    res.json({
      success: true,
      isVip: !!nextVip
    });
  } catch (error) {
    console.error('Toggle VIP error:', error);
    res.status(500).json({ error: 'Failed to update VIP.' });
  }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const totalUsers = await get('SELECT COUNT(*) as count FROM users');
    const totalVipUsers = await get('SELECT COUNT(*) as count FROM users WHERE is_vip = 1');
    const totalItems = await get('SELECT COUNT(*) as count FROM items');
    const totalVisits = await get('SELECT COUNT(*) as count FROM visits');

    const latestVisitsRaw = await all(`
      SELECT ip, country_code, created_at
      FROM visits
      ORDER BY id DESC
      LIMIT 20
    `);

    const latestVisits = latestVisitsRaw.map(v => ({
      ip: v.ip,
      country_code: v.country_code,
      flag: countryCodeToFlagEmoji(v.country_code),
      created_at: v.created_at
    }));

    res.json({
      totalUsers: totalUsers.count,
      totalVipUsers: totalVipUsers.count,
      totalItems: totalItems.count,
      totalVisits: totalVisits.count,
      latestVisits
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to load stats.' });
  }
});

app.get('/api/protected', requireUserPage, (req, res) => {
  res.json({ success: true });
});

app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(400).json({
    error: err.message || 'Upload error.'
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`APP_BASE_URL=${APP_BASE_URL}`);
  console.log(`PAYPAL_ENV=${PAYPAL_ENV}`);
  console.log('PayPal debug startup:', {
    hasClientId: !!PAYPAL_CLIENT_ID,
    hasClientSecret: !!PAYPAL_CLIENT_SECRET
  });
});

