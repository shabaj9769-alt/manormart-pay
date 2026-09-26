const crypto = require('crypto');
const admin = require('firebase-admin');
const {
  db,
  cors,
  parseBody,
  requireAdmin,
  safeError,
} = require('../common');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_IP = 5;
const LOGIN_MAX_GLOBAL = 100;

function ipKey(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  return 'ip_' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24);
}

const sameSecret = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

async function msLeft(path, max) {
  const cur = (await db.ref(path).once('value')).val();
  if (!cur || Date.now() - cur.start > LOGIN_WINDOW_MS || cur.fails < max) return 0;
  return cur.start + LOGIN_WINDOW_MS - Date.now();
}

async function recordFail(path) {
  await db.ref(path).transaction((cur) => {
    const now = Date.now();
    if (!cur || now - cur.start > LOGIN_WINDOW_MS) return { fails: 1, start: now };
    return { fails: cur.fails + 1, start: cur.start };
  });
}

async function adminLogin(req, res) {
  cors(req, res, 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ADMIN_PIN || !process.env.FIREBASE_WEB_API_KEY) {
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  try {
    const pin = String(parseBody(req).pin || '').trim();
    if (!/^[A-Za-z0-9]{4,32}$/.test(pin)) return res.status(400).json({ error: 'Enter your PIN.' });

    const ipPath = `adminLogin/${ipKey(req)}`;
    const wait = Math.max(await msLeft(ipPath, LOGIN_MAX_PER_IP), await msLeft('adminLogin/global', LOGIN_MAX_GLOBAL));
    if (wait > 0) {
      return res.status(429).json({ error: `Too many wrong attempts. Try again.` });
    }

    if (!sameSecret(pin, process.env.ADMIN_PIN)) {
      await Promise.all([recordFail(ipPath), recordFail('adminLogin/global')]);
      return res.status(401).json({ error: 'Incorrect Admin Security PIN!' });
    }

    await db.ref(ipPath).remove();

    const customToken = await admin.auth().createCustomToken('manormart-admin', { admin: true });
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.FIREBASE_WEB_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.idToken) {
      return res.status(500).json({ error: 'Login service error.' });
    }
    return res.status(200).json({ idToken: d.idToken, refreshToken: d.refreshToken, expiresIn: Number(d.expiresIn) || 3600 });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.' });
  }
}

async function adminRefresh(req, res) {
  cors(req, res, 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.FIREBASE_WEB_API_KEY) return res.status(500).json({ error: 'Server is not configured yet.' });

  try {
    const refreshToken = String(parseBody(req).refreshToken || '');
    const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${process.env.FIREBASE_WEB_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.id_token) return res.status(401).json({ error: 'Session expired.' });
    return res.status(200).json({ idToken: d.id_token, refreshToken: d.refresh_token, expiresIn: Number(d.expires_in) || 3600 });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.' });
  }
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const FORBIDDEN_KEY_CHARS = /[.#$[\]]/;
const BLOCKED_ROOTS = new Set(['customers']);

function sanitizePath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  let p = rawPath.trim();
  if (!p) return null;
  if (p.startsWith('/')) p = p.slice(1);
  if (p.toLowerCase().endsWith('.json')) p = p.slice(0, -5);
  if (!p) return null;

  const segments = p.split('/').filter(Boolean);
  if (!segments.length) return null;

  const decoded = [];
  for (const seg of segments) {
    let d;
    try { d = decodeURIComponent(seg); } catch { return null; }
    if (!d || d === '.' || d === '..' || FORBIDDEN_KEY_CHARS.test(d)) return null;
    decoded.push(d);
  }
  if (BLOCKED_ROOTS.has(decoded[0])) return null;
  return decoded.join('/');
}

async function adminDb(req, res) {
  cors(req, res, 'GET,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (!await requireAdmin(req, res)) return;

    const rawPath = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path;
    const path = sanitizePath(rawPath);
    if (!path) return res.status(400).json({ error: 'Invalid or missing path.' });

    const ref = db.ref(path);

    if (req.method === 'GET') {
      const val = (await ref.once('value')).val();
      return res.status(200).json(val === undefined ? null : val);
    }

    if (req.method === 'DELETE') {
      await ref.remove();
      return res.status(200).json({ success: true });
    }

    if (req.method === 'PUT' || req.method === 'PATCH') {
      const raw = await getRawBody(req);
      let value;
      try { value = raw.length ? JSON.parse(raw) : null; }
      catch { return res.status(400).json({ error: 'Invalid JSON body.' }); }

      if (req.method === 'PUT') {
        await ref.set(value);
      } else {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return res.status(400).json({ error: 'PATCH body must be a JSON object.' });
        }
        await ref.update(value);
      }
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return safeError(res, 500, 'Database operation failed.', e);
  }
}

// Exports for api/admin.js router
module.exports = { adminLogin, adminRefresh, adminDb };
