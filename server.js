const express = require('express');
const path = require('path');
const multer = require('multer');
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
const SESSION_SECRET =
  process.env.SESSION_SECRET || 'spicyvault_secret_key_demo_change_this';

const LOCKR_API_URL = 'https://lockr.so/api/v1/lockers';
const LOCKR_SECRET_API_KEY = process.env.LOCKR_SECRET_API_KEY || 'CHANGE_ME';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const PUBLIC_DIR = path.join(__dirname, 'public');

const DATA_FILES = {
  items: 'data/items.json',
  users: 'data/users.json',
  visits: 'data/visits.json'
};

let writeQueue = Promise.resolve();

function enqueueWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

function ensureGitHubConfig() {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new Error('Missing GITHUB_TOKEN, GITHUB_OWNER or GITHUB_REPO.');
  }
}

function githubApiUrl(filePath) {
  return `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${filePath}`;
}

async function githubRequest(url, options = {}) {
  ensureGitHubConfig();

  const response = await fetchFn(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });

  return response;
}

async function parseJsonSafe(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function readRepoFile(filePath, fallbackValue) {
  const response = await githubRequest(
    `${githubApiUrl(filePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`
  );

  if (response.status === 404) {
    return {
      exists: false,
      sha: null,
      data: fallbackValue,
      base64: null
    };
  }

  const payload = await parseJsonSafe(response);

  if (!response.ok) {
    console.error('GitHub read error:', {
      filePath,
      status: response.status,
      statusText: response.statusText,
      payload
    });
    throw new Error(payload.message || `Failed to read ${filePath} from GitHub.`);
  }

  const base64 = (payload.content || '').replace(/\n/g, '');
  const content = Buffer.from(base64, 'base64').toString('utf8');

  return {
    exists: true,
    sha: payload.sha,
    data: content,
    base64
  };
}

async function writeRepoFile(filePath, rawContent, message) {
  return enqueueWrite(async () => {
    const existing = await readRepoFile(filePath, null);
    const contentBase64 = Buffer.isBuffer(rawContent)
      ? rawContent.toString('base64')
      : Buffer.from(String(rawContent), 'utf8').toString('base64');

    const response = await githubRequest(githubApiUrl(filePath), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message,
        content: contentBase64,
        branch: GITHUB_BRANCH,
        ...(existing.sha ? { sha: existing.sha } : {})
      })
    });

    const payload = await parseJsonSafe(response);

    if (!response.ok) {
      console.error('GitHub write error:', {
        filePath,
        status: response.status,
        statusText: response.statusText,
        payload
      });
      throw new Error(payload.message || `Failed to write ${filePath} to GitHub.`);
    }

    return payload;
  });
}

async function deleteRepoFile(filePath, message) {
  return enqueueWrite(async () => {
    const existing = await readRepoFile(filePath, null);
    if (!existing.exists || !existing.sha) return;

    const response = await githubRequest(githubApiUrl(filePath), {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message,
        sha: existing.sha,
        branch: GITHUB_BRANCH
      })
    });

    const payload = await parseJsonSafe(response);

    if (!response.ok) {
      console.error('GitHub delete error:', {
        filePath,
        status: response.status,
        statusText: response.statusText,
        payload
      });
      throw new Error(payload.message || `Failed to delete ${filePath} from GitHub.`);
    }
  });
}

async function readJsonFile(filePath, fallbackValue) {
  const result = await readRepoFile(filePath, null);

  if (!result.exists) {
    await writeRepoFile(
      filePath,
      JSON.stringify(fallbackValue, null, 2),
      `Initialize ${filePath}`
    );
    return fallbackValue;
  }

  try {
    const parsed = JSON.parse(result.data || 'null');
    return Array.isArray(fallbackValue)
      ? (Array.isArray(parsed) ? parsed : fallbackValue)
      : (parsed ?? fallbackValue);
  } catch {
    return fallbackValue;
  }
}

async function writeJsonFile(filePath, data, message) {
  await writeRepoFile(filePath, JSON.stringify(data, null, 2), message);
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

function getSessionCookieSecure() {
  return process.env.NODE_ENV === 'production';
}

function nextId(list) {
  return list.length ? Math.max(...list.map(item => Number(item.id) || 0)) + 1 : 1;
}

function getLockrErrorMessage(payload) {
  if (!payload) return 'Failed to create locker.';
  if (typeof payload === 'string') return payload;

  return (
    payload?.errors?.[0]?.message ||
    payload?.errors?.[0]?.detail ||
    payload?.error?.message ||
    payload?.error ||
    payload?.message ||
    payload?.detail ||
    payload?.raw ||
    'Failed to create locker.'
  );
}

function extractLockrUrl(payload) {
  if (!payload || typeof payload !== 'object') return '';

  return (
    payload?.url ||
    payload?.link ||
    payload?.short_url ||
    payload?.locker_url ||
    payload?.redirect_url ||
    payload?.data?.url ||
    payload?.data?.link ||
    payload?.data?.short_url ||
    payload?.data?.locker_url ||
    payload?.data?.redirect_url ||
    payload?.result?.url ||
    payload?.result?.link ||
    payload?.result?.short_url ||
    payload?.result?.locker_url ||
    payload?.data?.locker?.url ||
    payload?.data?.locker?.link ||
    ''
  );
}

async function createLockrLocker({ title, targetUrl }) {
  if (!LOCKR_SECRET_API_KEY || LOCKR_SECRET_API_KEY === 'CHANGE_ME') {
    throw new Error('Missing LOCKR_SECRET_API_KEY.');
  }

  const payload = {
    title,
    target: targetUrl
  };

  const response = await fetchFn(LOCKR_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LOCKR_SECRET_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const result = await parseJsonSafe(response);

  if (!response.ok) {
    console.error('Lockr create error:', JSON.stringify({
      status: response.status,
      statusText: response.statusText,
      payload,
      result
    }, null, 2));

    const error = new Error(getLockrErrorMessage(result));
    error.status = response.status;
    throw error;
  }

  const lockrUrl = extractLockrUrl(result);

  if (!lockrUrl) {
    console.error('Lockr success without URL:', JSON.stringify({
      payload,
      result
    }, null, 2));

    throw new Error('Lockr created but lockr URL missing in response.');
  }

  return {
    lockrUrl,
    result
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
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

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

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

app.use(express.static(PUBLIC_DIR));

app.use(async (req, res, next) => {
  try {
    const shouldLogVisit = ['/', '/login', '/register', '/admin', '/admin-login', '/keygenerator'].includes(req.path);

    if (shouldLogVisit) {
      const visits = await readJsonFile(DATA_FILES.visits, []);
      const ip = getClientIp(req);
      const countryCode = getCountryCodeFromIp(ip);

      visits.push({
        id: nextId(visits),
        ip,
        country_code: countryCode,
        user_agent: req.headers['user-agent'] || '',
        browser: detectBrowser(req.headers['user-agent'] || ''),
        path: req.path,
        referer: req.headers['referer'] || '',
        created_at: new Date().toISOString()
      });

      const trimmed = visits.slice(-300);
      await writeJsonFile(
        DATA_FILES.visits,
        trimmed,
        `Update visits at ${new Date().toISOString()}`
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

/* NOVO: keygenerator route */
app.get('/keygenerator', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'keygenerator.html'));
});

app.get('/api/uploads/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = `data/uploads/${filename}`;
    const file = await readRepoFile(filePath, null);

    if (!file.exists) {
      return res.status(404).send('Image not found.');
    }

    const ext = path.extname(filename).toLowerCase();
    const typeMap = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif'
    };

    res.setHeader('Content-Type', typeMap[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(file.base64 || '', 'base64'));
  } catch (error) {
    console.error('Image proxy error:', error);
    res.status(500).send('Failed to load image.');
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

    const users = await readJsonFile(DATA_FILES.users, []);
    const existing = users.find(
      user => String(user.username || '').toLowerCase() === username.toLowerCase()
    );

    if (existing) {
      return res.status(400).json({ error: 'Username already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = {
      id: nextId(users),
      username,
      password_hash: passwordHash,
      is_vip: 0,
      created_at: new Date().toISOString()
    };

    users.push(newUser);
    await writeJsonFile(DATA_FILES.users, users, `Register user ${username}`);

    req.session.userId = newUser.id;
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

    const users = await readJsonFile(DATA_FILES.users, []);
    const user = users.find(
      u => String(u.username || '').toLowerCase() === username.toLowerCase()
    );

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

    const users = await readJsonFile(DATA_FILES.users, []);
    const user = users.find(
      u => Number(u.id) === Number(req.session.userId)
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
    const items = await readJsonFile(DATA_FILES.items, []);
    items.sort((a, b) => Number(b.id) - Number(a.id));
    res.json(items);
  } catch (error) {
    console.error('Load items error:', error);
    res.status(500).json({ error: 'Failed to load items.' });
  }
});

app.post('/api/items', requireAdmin, upload.single('imageFile'), async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const target = String(req.body.target || '').trim();
    const imageUrl = String(req.body.imageUrl || '').trim();

    if (!title) {
      return res.status(400).json({ error: 'Title is required.' });
    }

    if (!target) {
      return res.status(400).json({ error: 'Target URL is required.' });
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(target);
    } catch {
      return res.status(400).json({ error: 'Invalid target URL.' });
    }

    let finalImage = '';
    let uploadedFilename = null;

    if (req.file) {
      const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
      uploadedFilename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

      await writeRepoFile(
        `data/uploads/${uploadedFilename}`,
        req.file.buffer,
        `Upload image ${uploadedFilename}`
      );

      finalImage = `/api/uploads/${uploadedFilename}`;
    } else if (imageUrl) {
      try {
        finalImage = new URL(imageUrl).toString();
      } catch {
        return res.status(400).json({ error: 'Invalid image URL.' });
      }
    }

    let lockrUrl = '';

    try {
      const lockrCreate = await createLockrLocker({
        title,
        targetUrl: parsedTarget.toString()
      });

      lockrUrl = lockrCreate.lockrUrl;
    } catch (lockrError) {
      if (uploadedFilename) {
        try {
          await deleteRepoFile(
            `data/uploads/${uploadedFilename}`,
            `Rollback image ${uploadedFilename}`
          );
        } catch (rollbackError) {
          console.error('Upload rollback error:', rollbackError.message);
        }
      }

      return res.status(lockrError.status || 500).json({
        error: lockrError.message || 'Failed to create locker.'
      });
    }

    const items = await readJsonFile(DATA_FILES.items, []);
    const newItem = {
      id: nextId(items),
      title,
      target_url: parsedTarget.toString(),
      lockr_url: lockrUrl,
      image_url: finalImage,
      created_at: new Date().toISOString()
    };

    items.push(newItem);
    await writeJsonFile(DATA_FILES.items, items, `Add item ${title}`);

    res.json({
      success: true,
      item: newItem
    });
  } catch (error) {
    console.error('Create item error:', error);
    res.status(500).json({ error: error.message || 'Internal server error.' });
  }
});

app.delete('/api/items/:id', requireAdmin, async (req, res) => {
  try {
    const items = await readJsonFile(DATA_FILES.items, []);
    const index = items.findIndex(
      item => Number(item.id) === Number(req.params.id)
    );

    if (index === -1) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    const [item] = items.splice(index, 1);

    if (item.image_url && item.image_url.startsWith('/api/uploads/')) {
      const filename = path.basename(item.image_url);
      try {
        await deleteRepoFile(`data/uploads/${filename}`, `Delete image ${filename}`);
      } catch (error) {
        console.error('Delete image error:', error.message);
      }
    }

    await writeJsonFile(DATA_FILES.items, items, `Delete item ${item.title}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete item error:', error);
    res.status(500).json({ error: 'Delete failed.' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await readJsonFile(DATA_FILES.users, []);
    const safeUsers = [...users]
      .sort((a, b) => Number(b.id) - Number(a.id))
      .map(user => ({
        id: user.id,
        username: user.username,
        is_vip: !!user.is_vip,
        created_at: user.created_at
      }));

    res.json(safeUsers);
  } catch (error) {
    console.error('Load users error:', error);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

app.patch('/api/admin/users/:id/vip', requireAdmin, async (req, res) => {
  try {
    const users = await readJsonFile(DATA_FILES.users, []);
    const user = users.find(
      u => Number(u.id) === Number(req.params.id)
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    user.is_vip = user.is_vip ? 0 : 1;

    await writeJsonFile(DATA_FILES.users, users, `Toggle VIP for ${user.username}`);

    res.json({
      success: true,
      isVip: !!user.is_vip
    });
  } catch (error) {
    console.error('Toggle VIP error:', error);
    res.status(500).json({ error: 'Failed to update VIP.' });
  }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const users = await readJsonFile(DATA_FILES.users, []);
    const items = await readJsonFile(DATA_FILES.items, []);
    const visits = await readJsonFile(DATA_FILES.visits, []);

    const latestVisits = [...visits]
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 20)
      .map(v => ({
        ip: v.ip || '',
        country_code: v.country_code || '',
        flag: countryCodeToFlagEmoji(v.country_code),
        created_at: v.created_at || ''
      }));

    res.json({
      totalUsers: users.length || 0,
      totalVipUsers: users.filter(u => !!u.is_vip).length || 0,
      totalItems: items.length || 0,
      totalVisits: visits.length || 0,
      latestVisits
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.json({
      totalUsers: 0,
      totalVipUsers: 0,
      totalItems: 0,
      totalVisits: 0,
      latestVisits: []
    });
  }
});

app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(400).json({
    error: err.message || 'Upload error.'
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`GitHub storage enabled for ${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}`);
});
